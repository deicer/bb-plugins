import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { isAntigravityProviderId } from "./lib/agy.ts";
import {
  hostContract,
  ledgerStateSchema,
  rpcContract,
  type Dashboard,
  type LedgerState,
} from "./lib/contract.ts";
import {
  applyQuotaSnapshot,
  buildDashboard,
  emptyLedgerState,
  type AttributionMode,
  type TurnContext,
} from "./lib/ledger.ts";

export { rpcContract };

const LEDGER_KV_KEY = "ledger:v1";
const POLL_COOLDOWN_MS = 4_000;

function formatPct(value: number): string {
  return value >= 10 ? `${value.toFixed(1)}%` : `${value.toFixed(2)}%`;
}

export default function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const activeThreads = new Set<string>();
  let lastTurnEndedAt = 0;
  let queue: Promise<unknown> = Promise.resolve();

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }

  async function readState(): Promise<LedgerState> {
    const raw = await bb.storage.kv.get<unknown>(LEDGER_KV_KEY);
    const parsed = ledgerStateSchema.safeParse(raw);
    return parsed.success ? parsed.data : emptyLedgerState();
  }

  async function writeState(state: LedgerState): Promise<void> {
    await bb.storage.kv.set(LEDGER_KV_KEY, state);
    bb.rpc.experimental_invalidate(["antigravity-quota"]);
    bb.realtime.publish("quota-updated", { at: state.lastPollAt ?? Date.now() });
  }

  async function resolveHostId(preferredHostId?: string | null): Promise<string | null> {
    if (preferredHostId) return preferredHostId;
    try {
      const config = await bb.sdk.system.config();
      return config.primaryHostId ?? null;
    } catch {
      return null;
    }
  }

  async function pollLocked(options: {
    mode: AttributionMode;
    force?: boolean;
    hostId?: string | null;
    turn?: TurnContext;
    signal?: AbortSignal;
  }): Promise<LedgerState> {
    const current = await readState();
    const now = Date.now();
    if (!options.force && current.lastPollAt !== null && now - current.lastPollAt < POLL_COOLDOWN_MS) {
      return current;
    }

    const hostId = await resolveHostId(options.hostId);
    if (!hostId) {
      const next: LedgerState = {
        ...current,
        lastPollAt: now,
        lastError: "Основной компьютер с установленным agy CLI не найден.",
      };
      await writeState(next);
      return next;
    }

    let snapshot;
    try {
      snapshot = await host.call("readQuota", {}, { hostId, signal: options.signal, timeoutMs: 30_000 });
    } catch {
      const next: LedgerState = {
        ...current,
        lastPollAt: now,
        lastError: "Не удалось прочитать квоту Google Antigravity на выбранном компьютере.",
      };
      await writeState(next);
      return next;
    }

    if (snapshot.status !== "ok") {
      const next: LedgerState = {
        ...current,
        lastPollAt: snapshot.observedAt,
        lastError: snapshot.message,
      };
      await writeState(next);
      return next;
    }

    const effectiveMode: AttributionMode = current.trackingSince === null ? "baseline" : options.mode;
    const next = applyQuotaSnapshot(current, snapshot, effectiveMode, options.turn);
    await writeState(next);
    return next;
  }

  async function getDashboard(): Promise<Dashboard> {
    const state = await readState();
    return buildDashboard(state, activeThreads.size);
  }

  async function resolveThreadHostId(environmentId: string | null | undefined): Promise<string | null> {
    if (!environmentId) return null;
    try {
      const env = await bb.sdk.environments.get({ environmentId });
      return env.hostId ?? null;
    } catch {
      return null;
    }
  }

  bb.rpc.register(defineRpcContract(rpcContract), {
    dashboard: async () => getDashboard(),
    refresh: async (_input, context) => {
      const state = await enqueue(() =>
        pollLocked({
          mode: activeThreads.size > 0 ? "me" : "others",
          force: true,
          signal: context.experimental_signal,
        }),
      );
      return buildDashboard(state, activeThreads.size);
    },
    reset: async () => {
      const state = await enqueue(async () => {
        const fresh = emptyLedgerState();
        await writeState(fresh);
        return pollLocked({ mode: "baseline", force: true });
      });
      return buildDashboard(state, activeThreads.size);
    },
  });

  // Mark Antigravity threads as active without polling mid-flight (an agy /usage call
  // takes ~3-5s and could otherwise race with the turn's first LLM call and misattribute
  // our own usage to "others"). Idle polling runs every 2 minutes when no turn is active.
  bb.events.on("thread.active", ({ thread }) => {
    if (!isAntigravityProviderId(thread.providerId)) return;
    activeThreads.add(thread.id);
  });

  // Post-turn snapshot attributes quota spent during our BB turn to "me".
  for (const event of ["thread.idle", "thread.failed"] as const) {
    bb.events.on(event, async ({ thread }) => {
      if (!isAntigravityProviderId(thread.providerId)) return;
      activeThreads.delete(thread.id);
      lastTurnEndedAt = Date.now();
      const hostId = await resolveThreadHostId(thread.environmentId);
      const threadTitle = (thread.title || thread.titleFallback || thread.id).slice(0, 140);
      await enqueue(() =>
        pollLocked({
          mode: "me",
          force: true,
          hostId,
          turn: { threadId: thread.id, threadTitle },
        }),
      ).catch((cause: unknown) => {
        bb.log.warn(`post-turn quota snapshot failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      });
    });
  }

  // Periodic background poll catches family/other-device usage and window resets while idle.
  bb.background.schedule("poll-quota", "*/2 * * * *", async () => {
    if (activeThreads.size > 0 || Date.now() - lastTurnEndedAt < 30_000) return;
    await enqueue(() => {
      if (activeThreads.size > 0 || Date.now() - lastTurnEndedAt < 30_000) return readState();
      return pollLocked({ mode: "others", force: false });
    }).catch((cause: unknown) => {
      bb.log.warn(`scheduled quota poll failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
  });

  // Take an initial snapshot shortly after load so the dashboard has data right away,
  // seeding any already-active Antigravity threads first so reloads mid-turn never misattribute.
  bb.background.service("initial-snapshot", {
    start: async (signal) => {
      try {
        const listed = await bb.sdk.threads.list({ archived: false, includeHidden: true });
        for (const thread of listed) {
          if (thread.status === "active" && isAntigravityProviderId(thread.providerId)) {
            activeThreads.add(thread.id);
          }
        }
      } catch {
        // Non-fatal: active thread tracking will still catch subsequent lifecycle events.
      }
      const state = await readState();
      if (state.trackingSince === null || state.lastPollAt === null || Date.now() - state.lastPollAt > 5 * 60_000) {
        await enqueue(() => pollLocked({ mode: activeThreads.size > 0 ? "me" : "others", force: false, signal })).catch((cause: unknown) => {
          if (!signal.aborted) {
            bb.log.warn(`initial quota snapshot failed: ${cause instanceof Error ? cause.message : String(cause)}`);
          }
        });
      }
      await new Promise<void>((resolve) => {
        if (signal.aborted) { resolve(); return; }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  });

  bb.cli.register({
    name: "antigravity-quota",
    summary: "Личный и семейный расход квоты Google Antigravity (5ч / неделя)",
    run: async (argv) => {
      const json = argv.includes("--json");
      const sub = argv.find((arg) => !arg.startsWith("-")) ?? "status";
      if (sub === "refresh") {
        const state = await enqueue(() => pollLocked({ mode: activeThreads.size > 0 ? "me" : "others", force: true }));
        const dashboard = buildDashboard(state, activeThreads.size);
        return { exitCode: 0, stdout: json ? JSON.stringify(dashboard, null, 2) : formatCliSummary(dashboard) };
      }
      if (sub === "reset") {
        const state = await enqueue(async () => {
          await writeState(emptyLedgerState());
          return pollLocked({ mode: "baseline", force: true });
        });
        const dashboard = buildDashboard(state, activeThreads.size);
        return {
          exitCode: 0,
          stdout: json ? JSON.stringify(dashboard, null, 2) : `Статистика сброшена.\n\n${formatCliSummary(dashboard)}`,
        };
      }
      if (sub === "status") {
        const dashboard = await getDashboard();
        return { exitCode: 0, stdout: json ? JSON.stringify(dashboard, null, 2) : formatCliSummary(dashboard) };
      }
      return { exitCode: 1, stderr: `Неизвестная команда: ${sub}. Используйте: status, refresh, reset` };
    },
  });
}

function formatCliSummary(dashboard: Dashboard): string {
  const lines: string[] = [];
  if (dashboard.lastError) lines.push(`Ошибка: ${dashboard.lastError}`);
  if (dashboard.groups.length === 0) {
    lines.push("Данных о квоте пока нет. Выполните `bb antigravity-quota refresh`.");
    return lines.join("\n");
  }
  for (const group of dashboard.groups) {
    lines.push(`=== ${group.group} ===`);
    if (group.fiveHour) {
      lines.push(
        `  5ч: осталось ${formatPct(group.fiveHour.lastRemainingPct)} | я: ${formatPct(group.fiveHour.myUsedPct)} | остальные: ${formatPct(group.fiveHour.othersUsedPct)}` +
        (group.fiveHour.baselineUsedPct > 0 ? ` | до учёта: ${formatPct(group.fiveHour.baselineUsedPct)}` : ""),
      );
    }
    if (group.weekly) {
      lines.push(
        `  Неделя: осталось ${formatPct(group.weekly.lastRemainingPct)} | я: ${formatPct(group.weekly.myUsedPct)} | остальные: ${formatPct(group.weekly.othersUsedPct)}` +
        (group.weekly.baselineUsedPct > 0 ? ` | до учёта: ${formatPct(group.weekly.baselineUsedPct)}` : ""),
      );
    }
  }
  return lines.join("\n");
}
