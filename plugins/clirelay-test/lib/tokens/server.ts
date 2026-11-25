import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { createAntigravityUsageLookup, type AntigravityUsageLookup } from "./antigravity-transcript";
import {
  contextWindowUsageEventRowSchema,
  itemEventRowSchema,
  modelRequestRowSchema,
  threadTag,
  threadUsageSchema,
  tokensRpcContract,
  turnEventRowSchema,
  turnUsageSchema,
  usageEventRowSchema,
  type ContextWindowUsageEventRow,
  type ItemEventRow,
  type TurnUsage,
  type UsageEventRow,
} from "./contract";
import {
  TOKENS_DISPLAY_KV_KEY,
  TOKENS_DISPLAY_TAG,
  applyTokensDisplayPatch,
  normalizeTokensDisplay,
  type TokensDisplay,
} from "./display";
import { makeContextWindowTurnUsage, makeTurnUsage, retainTurns, summarizeTurns } from "./usage";

const EVENT_TYPES = [
  "thread/tokenUsage/updated",
  "thread/contextWindowUsage/updated",
  "turn/started",
  "turn/completed",
  "client/turn/requested",
] as const;
/** Запрос модели хода: всегда отдельным list, чтобы не зависеть от границ страницы. */
const MODEL_REQUEST_TYPES = ["client/turn/requested"] as const;
const ITEM_EVENT_TYPES = ["item/started", "item/completed"] as const;
/** Лимит API bb: threads.events.list отвечает HTTP 400 на limit > 100. */
const EVENTS_PAGE_LIMIT = 100;
/** Сколько item-событий перед usage-событием просматриваем в поисках последнего инструмента. */
const TOOL_LOOKBACK = 10;
const STARTED_LOOKBACK = 20;
/** Сколько `client/turn/requested` перед ходом просматриваем в поисках модели. */
const REQUESTED_LOOKBACK = 20;
// Префиксы исторические (от плагина token-meter): коллизий в kv clirelay-test
// нет, а тесты и документация переносятся дословно.
const TURN_PREFIX = "token-meter:turn:";
const THREAD_PREFIX = "token-meter:thread:";
const SEQ_PREFIX = "token-meter:seq:";
/** Айтемы вывода: последний вызов модели начинается после последнего НЕ такого айтема. */
const MODEL_ITEM_KINDS = new Set(["agentMessage", "reasoning"]);
/**
 * providerId — свойство треда, а не хода: кэшируем один запрос на тред на 60 с.
 * Модель хода НЕ кэшируется: она берётся из события конкретного хода.
 */
const PROVIDER_CACHE_MS = 60_000;

type ExecutionInfo = { model?: string; providerId?: string };
type ExecutionBoundary = {
  /** Sequence usage-события: за ней `client/turn/requested` уже не относится к вызову. */
  seq: number;
  /** `turn/started` этого хода: запросы модели после него к ходу не относятся. */
  startedAt: number | null;
};
type ExecutionLookup = (threadId: string, boundary: ExecutionBoundary) => Promise<ExecutionInfo>;

/**
 * Модель хода = `execution.model` последнего `client/turn/requested` перед
 * `turn/started` этого хода. `defaultExecutionOptions` — только fallback:
 * это дефолт треда на момент синка, он врёт при catch-up бэклога и смене модели.
 */
async function findTurnModel(
  bb: BbPluginApi,
  threadId: string,
  boundary: ExecutionBoundary,
): Promise<string | undefined> {
  try {
    const rows = await bb.sdk.threads.events.list({
      threadId,
      types: MODEL_REQUEST_TYPES,
      beforeSeq: String(boundary.seq),
      order: "desc",
      limit: pageLimit(REQUESTED_LOOKBACK),
    });
    for (const row of rows) {
      const parsed = modelRequestRowSchema.safeParse(row);
      if (!parsed.success || !parsed.data.model) continue;
      // Граница включительная: createdAt == startedAt — запрос этого хода; строго позже — уже нет.
      if (boundary.startedAt !== null && parsed.data.createdAt > boundary.startedAt) continue;
      return parsed.data.model;
    }
  } catch {
    // Модель — необязательные метаданные: ошибка SDK не должна терять usage.
  }
  return undefined;
}

async function defaultTurnModel(bb: BbPluginApi, threadId: string): Promise<string | undefined> {
  try {
    const options = await bb.sdk.threads.defaultExecutionOptions({ threadId });
    return options?.model || undefined;
  } catch {
    return undefined;
  }
}

function createProviderLookup(bb: BbPluginApi): (threadId: string) => Promise<string | undefined> {
  const cache = new Map<string, { at: number; value?: string }>();
  return async (threadId) => {
    const cached = cache.get(threadId);
    if (cached && Date.now() - cached.at < PROVIDER_CACHE_MS) return cached.value;
    let value: string | undefined;
    try {
      // providerId есть только в ThreadResponse; defaultExecutionOptions его не отдаёт.
      const thread = await bb.sdk.threads.get({ threadId });
      value = thread.providerId || undefined;
    } catch {
      // Метаданные необязательны.
    }
    cache.set(threadId, { at: Date.now(), value });
    return value;
  };
}

function createExecutionLookup(bb: BbPluginApi): ExecutionLookup {
  const providerIdFor = createProviderLookup(bb);
  return async (threadId, boundary) => {
    const model = await findTurnModel(bb, threadId, boundary) ?? await defaultTurnModel(bb, threadId);
    const providerId = await providerIdFor(threadId);
    return {
      ...(model ? { model } : {}),
      ...(providerId ? { providerId } : {}),
    };
  };
}

type Kv = BbPluginApi["storage"]["kv"];

function pageLimit(size: number): string {
  return String(Math.min(size, EVENTS_PAGE_LIMIT));
}

function turnKey(threadId: string, turnId: string): string {
  return `${TURN_PREFIX}${threadId}:${turnId}`;
}

function turnPrefix(threadId: string): string {
  return `${TURN_PREFIX}${threadId}:`;
}

function sequenceKey(threadId: string): string {
  return `${SEQ_PREFIX}${threadId}`;
}

function summaryKey(threadId: string): string {
  return `${THREAD_PREFIX}${threadId}`;
}

async function readTurns(kv: Kv, threadId: string): Promise<TurnUsage[]> {
  const keys = await kv.list(turnPrefix(threadId));
  const rows = await Promise.all(keys.map((key) => kv.get<unknown>(key)));
  return rows.flatMap((row) => {
    const parsed = turnUsageSchema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}

async function writeSummary(
  bb: BbPluginApi,
  threadId: string,
  turns: readonly TurnUsage[],
  freshContextWindow?: number | null,
  currentTokPerSec?: number | null,
): Promise<void> {
  if (turns.length === 0) {
    await bb.storage.kv.delete(summaryKey(threadId));
    return;
  }
  const needPrevious = freshContextWindow === undefined || currentTokPerSec === undefined;
  const previous = needPrevious
    ? threadUsageSchema.safeParse(await bb.storage.kv.get<unknown>(summaryKey(threadId)))
    : null;
  const modelContextWindow = freshContextWindow !== undefined
    ? freshContextWindow
    : previous?.success ? previous.data.modelContextWindow : null;
  const liveRate = currentTokPerSec === undefined
    ? (previous?.success ? previous.data.currentTokPerSec : undefined)
    : currentTokPerSec === null ? undefined : currentTokPerSec;
  await bb.storage.kv.set(summaryKey(threadId), summarizeTurns(threadId, turns, modelContextWindow, liveRate));
}

async function clearCurrentRate(bb: BbPluginApi, threadId: string): Promise<boolean> {
  const previous = threadUsageSchema.safeParse(await bb.storage.kv.get<unknown>(summaryKey(threadId)));
  if (!previous.success || previous.data.currentTokPerSec === undefined) return false;
  const { currentTokPerSec: _cleared, ...rest } = previous.data;
  await bb.storage.kv.set(summaryKey(threadId), rest);
  return true;
}

async function pruneThread(kv: Kv, threadId: string, now: number): Promise<TurnUsage[]> {
  // ponytail: O(n) чтение всех ходов треда на каждую запись; при лимите 500 локальных kv.get это дёшево.
  const rows = await readTurns(kv, threadId);
  const retained = retainTurns(rows, now);
  await Promise.all(retained.removed.map((row) => kv.delete(turnKey(row.threadId, row.turnId))));
  return retained.kept;
}

async function saveUsage(
  bb: BbPluginApi,
  event: UsageEventRow,
  windowStartedAt: number | null | undefined,
  turnStartedAt: number | null,
  endedAt: number,
  execution: ExecutionInfo,
  isActiveTurn: boolean,
): Promise<void> {
  const { threadId, turnId } = event;
  const record = makeTurnUsage({
    threadId,
    turnId,
    tokenUsage: event.data.tokenUsage,
    windowStartedAt,
    endedAt,
    turnStartedAt,
    ...execution,
    at: event.createdAt,
  });
  await bb.storage.kv.set(turnKey(threadId, turnId), record);
  const kept = await pruneThread(bb.storage.kv, threadId, Date.now());
  await writeSummary(bb, threadId, kept, event.data.tokenUsage.modelContextWindow, isActiveTurn ? (record.tokPerSec ?? null) : null);
}

async function saveContextWindowUsage(
  bb: BbPluginApi,
  event: ContextWindowUsageEventRow,
  windowStartedAt: number | null | undefined,
  turnStartedAt: number | null,
  endedAt: number,
  execution: ExecutionInfo,
  antigravityLookup: AntigravityUsageLookup,
  isActiveTurn: boolean,
): Promise<boolean> {
  const { threadId, turnId } = event;
  const existing = turnUsageSchema.safeParse(await bb.storage.kv.get<unknown>(turnKey(threadId, turnId)));
  if (
    existing.success
    && existing.data.usageSource !== "contextWindow"
    && existing.data.usageSource !== "antigravityTranscript"
  ) return false;

  const providerThreadId = event.data.providerThreadId;
  const enriched = providerThreadId
    ? await antigravityLookup({
      providerThreadId,
      usedTokens: event.data.contextWindowUsage.usedTokens,
      eventCreatedAt: event.createdAt,
      modelContextWindow: event.data.contextWindowUsage.modelContextWindow,
    })
    : null;

  const record = enriched
    ? makeTurnUsage({
      threadId,
      turnId,
      tokenUsage: enriched,
      usageSource: "antigravityTranscript",
      windowStartedAt,
      endedAt,
      turnStartedAt,
      ...execution,
      at: event.createdAt,
    })
    : makeContextWindowTurnUsage({
      threadId,
      turnId,
      contextWindowUsage: event.data.contextWindowUsage,
      windowStartedAt,
      endedAt,
      turnStartedAt,
      ...execution,
      at: event.createdAt,
    });
  await bb.storage.kv.set(turnKey(threadId, turnId), record);
  const kept = await pruneThread(bb.storage.kv, threadId, Date.now());
  await writeSummary(bb, threadId, kept, event.data.contextWindowUsage.modelContextWindow, isActiveTurn ? (record.tokPerSec ?? null) : null);
  return true;
}

async function pruneAll(bb: BbPluginApi): Promise<void> {
  const now = Date.now();
  const kept = new Map<string, TurnUsage[]>();
  for (const key of await bb.storage.kv.list(TURN_PREFIX)) {
    const parsed = turnUsageSchema.safeParse(await bb.storage.kv.get<unknown>(key));
    if (!parsed.success) {
      await bb.storage.kv.delete(key);
      continue;
    }
    const rows = kept.get(parsed.data.threadId) ?? [];
    rows.push(parsed.data);
    kept.set(parsed.data.threadId, rows);
  }
  for (const [threadId, rows] of kept) {
    const retained = retainTurns(rows, now);
    await Promise.all(retained.removed.map((row) => bb.storage.kv.delete(turnKey(threadId, row.turnId))));
    kept.set(threadId, retained.kept);
    await writeSummary(bb, threadId, retained.kept);
  }
  for (const prefix of [THREAD_PREFIX, SEQ_PREFIX]) {
    for (const key of await bb.storage.kv.list(prefix)) {
      if ((kept.get(key.slice(prefix.length)) ?? []).length > 0) continue;
      await bb.storage.kv.delete(key);
    }
  }
}

async function findStartedAt(
  bb: BbPluginApi,
  threadId: string,
  usageSeq: number,
  turnId: string,
): Promise<number | null> {
  const rows = await bb.sdk.threads.events.list({
    threadId,
    types: ["turn/started"],
    beforeSeq: String(usageSeq),
    order: "desc",
    limit: pageLimit(STARTED_LOOKBACK),
  });
  for (const row of rows) {
    const parsed = turnEventRowSchema.safeParse(row);
    if (parsed.success && parsed.data.turnId === turnId) return parsed.data.createdAt;
  }
  return null;
}

type ToolWindow =
  /** Окно известно: начало — конец последнего инструмента или null (инструментов в ходе нет). */
  | { known: true; startedAt: number | null }
  /** Lookback исчерпан на айтемах того же хода: неизвестно, где начался вызов. */
  | { known: false };

/**
 * Конец последнего инструмента этого хода. `tokenUsage.last` — usage последнего
 * вызова модели, поэтому окно вызова начинается там, а не в `turn/started`
 * (иначе в знаменатель попадают все инструменты хода).
 */
async function findToolWindow(
  bb: BbPluginApi,
  threadId: string,
  usageSeq: number,
  turnId: string,
): Promise<ToolWindow> {
  const rows = await bb.sdk.threads.events.list({
    threadId,
    types: ITEM_EVENT_TYPES,
    beforeSeq: String(usageSeq),
    order: "desc",
    limit: pageLimit(TOOL_LOOKBACK),
  });
  for (const row of rows) {
    const parsed = itemEventRowSchema.safeParse(row);
    if (!parsed.success) continue;
    // Инструменты других ходов не считаются: ход кончился раньше.
    if (parsed.data.turnId !== turnId) return { known: true, startedAt: null };
    if (parsed.data.type !== "item/completed" || !isToolItem(parsed.data)) continue;
    return { known: true, startedAt: parsed.data.createdAt };
  }
  // Страница короче lookback — перед нами все айтемы хода, инструмента в нём нет.
  return rows.length < TOOL_LOOKBACK ? { known: true, startedAt: null } : { known: false };
}

function isToolItem(row: ItemEventRow): boolean {
  return row.itemKind !== undefined && !MODEL_ITEM_KINDS.has(row.itemKind);
}

async function syncThread(
  bb: BbPluginApi,
  threadId: string,
  signalSequence: number,
  executionLookup: ExecutionLookup,
  antigravityLookup: AntigravityUsageLookup,
): Promise<void> {
  let afterSeq = await bb.storage.kv.get<number>(sequenceKey(threadId)) ?? 0;
  if (afterSeq >= signalSequence) return;
  let changed = false;

  while (afterSeq < signalSequence) {
    const rows = await bb.sdk.threads.events.list({
      threadId,
      afterSeq: String(afterSeq),
      limit: pageLimit(EVENTS_PAGE_LIMIT),
      order: "asc",
      types: EVENT_TYPES,
    });
    if (rows.length === 0) {
      await bb.storage.kv.set(sequenceKey(threadId), signalSequence);
      break;
    }

    let maxSeq = afterSeq;
    const usageByTurn = new Map<string, UsageEventRow>();
    const contextUsageByTurn = new Map<string, ContextWindowUsageEventRow>();
    const started = new Map<string, number>();
    const completed = new Map<string, number>();
    for (const row of rows) {
      maxSeq = Math.max(maxSeq, row.seq);
      if (row.type === "thread/tokenUsage/updated") {
        const parsed = usageEventRowSchema.safeParse(row);
        if (parsed.success) usageByTurn.set(parsed.data.turnId, parsed.data);
        continue;
      }
      if (row.type === "thread/contextWindowUsage/updated") {
        const parsed = contextWindowUsageEventRowSchema.safeParse(row);
        if (parsed.success && parsed.data.data.contextWindowUsage.estimated !== true) {
          contextUsageByTurn.set(parsed.data.turnId, parsed.data);
        }
        continue;
      }
      const point = turnEventRowSchema.safeParse(row);
      if (!point.success) continue;
      if (point.data.type === "turn/started") started.set(point.data.turnId, point.data.createdAt);
      else completed.set(point.data.turnId, point.data.createdAt);
    }

    const usages = [
      ...usageByTurn.values(),
      ...[...contextUsageByTurn.values()].filter((item) => !usageByTurn.has(item.turnId)),
    ].sort((a, b) => a.seq - b.seq);
    for (const usage of usages) {
      const turnStartedAt = started.get(usage.turnId) ?? await findStartedAt(bb, threadId, usage.seq, usage.turnId);
      const isActiveTurn = !completed.has(usage.turnId);
      const endedAt = completed.get(usage.turnId) ?? usage.createdAt;
      const toolWindow = await findToolWindow(bb, threadId, usage.seq, usage.turnId);
      const windowStartedAt = toolWindow.known ? toolWindow.startedAt ?? turnStartedAt : undefined;
      const execution = await executionLookup(threadId, { seq: usage.seq, startedAt: turnStartedAt });
      if (usage.type === "thread/tokenUsage/updated") {
        await saveUsage(bb, usage, windowStartedAt, turnStartedAt, endedAt, execution, isActiveTurn);
        changed = true;
      } else {
        const saved = await saveContextWindowUsage(bb, usage, windowStartedAt, turnStartedAt, endedAt, execution, antigravityLookup, isActiveTurn);
        if (saved) changed = true;
      }
    }
    const lastUsage = usages.at(-1);
    const hasCompletedAfterLastUsage = completed.size > 0 && (!lastUsage || completed.has(lastUsage.turnId));
    if (hasCompletedAfterLastUsage && await clearCurrentRate(bb, threadId)) {
      changed = true;
    }
    const nextSeq = rows.length < EVENTS_PAGE_LIMIT ? Math.max(signalSequence, maxSeq) : maxSeq;
    await bb.storage.kv.set(sequenceKey(threadId), nextSeq);
    afterSeq = nextSeq;
    if (rows.length < EVENTS_PAGE_LIMIT) break;
  }

  if (changed) bb.rpc.experimental_invalidate([threadTag(threadId)]);
}

async function dropThread(bb: BbPluginApi, threadId: string): Promise<void> {
  const keys = await bb.storage.kv.list(turnPrefix(threadId));
  await Promise.all(keys.map((key) => bb.storage.kv.delete(key)));
  await bb.storage.kv.delete(sequenceKey(threadId));
  await bb.storage.kv.delete(summaryKey(threadId));
}

/** Сервер токенов: свой RPC-контракт, свой обработчик событий, свой kv. */
export async function registerTokens(bb: BbPluginApi): Promise<void> {
  // ponytail: свой промис-лок модуля; общий `locked` из server.ts не нужен — kv-ключ ни с чем не пересекается.
  let displayQueue: Promise<unknown> = Promise.resolve();
  async function readDisplay(): Promise<TokensDisplay> {
    return normalizeTokensDisplay(await bb.storage.kv.get(TOKENS_DISPLAY_KV_KEY));
  }

  bb.rpc.register(defineRpcContract(tokensRpcContract), {
    turn_usage: async ({ keys }) => Object.fromEntries(await Promise.all(keys.map(async (key) => {
      const separator = key.indexOf(":");
      if (separator <= 0 || separator === key.length - 1) return [key, null] as const;
      const threadId = key.slice(0, separator);
      const turnId = key.slice(separator + 1);
      const parsed = turnUsageSchema.safeParse(await bb.storage.kv.get<unknown>(turnKey(threadId, turnId)));
      return [key, parsed.success ? parsed.data : null] as const;
    }))),
    thread_usage: async ({ threadId }) => {
      const parsed = threadUsageSchema.safeParse(await bb.storage.kv.get<unknown>(summaryKey(threadId)));
      return parsed.success ? parsed.data : null;
    },
    tokens_display_get: async () => readDisplay(),
    // Read-modify-write сериализован: два быстрых клика не должны терять друг друга.
    tokens_display_set: (patch) => {
      const run = displayQueue.then(async () => {
        const next = normalizeTokensDisplay(applyTokensDisplayPatch(await readDisplay(), patch));
        await bb.storage.kv.set(TOKENS_DISPLAY_KV_KEY, next);
        bb.rpc.experimental_invalidate([TOKENS_DISPLAY_TAG]);
        return next;
      });
      displayQueue = run.catch(() => undefined);
      return run;
    },
  });

  try {
    await pruneAll(bb);
  } catch (cause) {
    bb.log.warn(`tokens prune failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  const pending = new Map<string, Promise<void>>();
  const executionLookup = createExecutionLookup(bb);
  const antigravityLookup = createAntigravityUsageLookup();
  bb.events.on("experimental_thread.events", async ({ thread, sequence }) => {
    const previous = pending.get(thread.id) ?? Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => syncThread(bb, thread.id, sequence, executionLookup, antigravityLookup))
      .catch((cause: unknown) => {
        bb.log.warn(`tokens sync failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      });
    pending.set(thread.id, current);
    try {
      await current;
    } finally {
      if (pending.get(thread.id) === current) pending.delete(thread.id);
    }
  });

  for (const event of ["thread.idle", "thread.failed"] as const) {
    bb.events.on(event, async ({ thread }) => {
      try {
        if (await clearCurrentRate(bb, thread.id)) {
          bb.rpc.experimental_invalidate([threadTag(thread.id)]);
        }
      } catch (cause) {
        bb.log.warn(`tokens clear current rate failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    });
  }

  bb.events.on("thread.deleted", async ({ thread }) => {
    try {
      await dropThread(bb, thread.id);
      bb.rpc.experimental_invalidate([threadTag(thread.id)]);
    } catch (cause) {
      bb.log.warn(`tokens drop failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  });
}