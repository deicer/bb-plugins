import type { ContextWindowUsage, ThreadUsage, TokenUsage, TurnUsage } from "./contract";

export const MAX_TURNS_PER_THREAD = 500;
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function makeTurnUsage(input: {
  threadId: string;
  turnId: string;
  tokenUsage: TokenUsage;
  /**
   * Начало окна последнего вызова модели (конец последнего инструмента или
   * turn/started). `undefined` — окно неизвестно: длительность не выдумываем.
   */
  windowStartedAt?: number | null;
  /** Конец окна и хода: turn/completed (или время usage-события). */
  endedAt: number;
  /** Начало всего хода из turn/started; null, если его не нашли. */
  turnStartedAt: number | null;
  model?: string;
  providerId?: string;
  usageSource?: TurnUsage["usageSource"];
  at: number;
}): TurnUsage {
  const { last } = input.tokenUsage;
  const windowStartedAt = input.windowStartedAt;
  const elapsed = windowStartedAt === undefined || windowStartedAt === null
    ? null
    : input.endedAt - windowStartedAt;
  const durationMs = elapsed !== null && elapsed > 0 ? elapsed : undefined;
  const tokPerSec = durationMs !== undefined && durationMs >= 1_000 && last.outputTokens > 0
    ? Math.round((last.outputTokens / (durationMs / 1_000)) * 10) / 10
    : undefined;
  const turnElapsed = input.turnStartedAt === null ? null : input.endedAt - input.turnStartedAt;
  const turnDurationMs = turnElapsed !== null && turnElapsed > 0 ? turnElapsed : undefined;
  return {
    threadId: input.threadId,
    turnId: input.turnId,
    ...(input.usageSource === undefined ? {} : { usageSource: input.usageSource }),
    input: last.inputTokens,
    cached: last.cachedInputTokens,
    ...(last.cacheReadInputTokens === undefined ? {} : { cacheRead: last.cacheReadInputTokens }),
    ...(last.cacheWriteInputTokens === undefined ? {} : { cacheWrite: last.cacheWriteInputTokens }),
    output: last.outputTokens,
    reasoning: last.reasoningOutputTokens,
    total: last.totalTokens,
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(turnDurationMs === undefined ? {} : { turnDurationMs }),
    ...(tokPerSec === undefined ? {} : { tokPerSec }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
    at: input.at,
  };
}

export function makeContextWindowTurnUsage(input: {
  threadId: string;
  turnId: string;
  contextWindowUsage: ContextWindowUsage;
  windowStartedAt?: number | null;
  endedAt: number;
  turnStartedAt: number | null;
  model?: string;
  providerId?: string;
  at: number;
}): TurnUsage {
  const windowStartedAt = input.windowStartedAt;
  const elapsed = windowStartedAt === undefined || windowStartedAt === null
    ? null
    : input.endedAt - windowStartedAt;
  const durationMs = elapsed !== null && elapsed > 0 ? elapsed : undefined;
  const turnElapsed = input.turnStartedAt === null ? null : input.endedAt - input.turnStartedAt;
  const turnDurationMs = turnElapsed !== null && turnElapsed > 0 ? turnElapsed : undefined;
  return {
    threadId: input.threadId,
    turnId: input.turnId,
    usageSource: "contextWindow",
    input: 0,
    cached: 0,
    output: 0,
    reasoning: 0,
    total: input.contextWindowUsage.usedTokens,
    ...(input.contextWindowUsage.modelContextWindow === null
      ? {}
      : { modelContextWindow: input.contextWindowUsage.modelContextWindow }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(turnDurationMs === undefined ? {} : { turnDurationMs }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
    at: input.at,
  };
}

export function summarizeTurns(
  threadId: string,
  turns: readonly TurnUsage[],
  modelContextWindow: number | null,
  currentTokPerSec?: number,
): ThreadUsage {
  const rates = turns.flatMap((row) => row.tokPerSec === undefined ? [] : [row.tokPerSec]);
  const averageTokPerSec = rates.length === 0
    ? undefined
    : Math.round((rates.reduce((sum, rate) => sum + rate, 0) / rates.length) * 10) / 10;
  // Модель треда — модель самого свежего хода, у которого она есть;
  // нет ни у одного — поля нет (undefined не проходит JSON-границу RPC).
  const model = [...turns]
    .sort((a, b) => b.at - a.at)
    .find((row) => row.model !== undefined)?.model;
  return {
    threadId,
    total: turns.reduce((sum, row) => sum + row.total, 0),
    turns: turns.length,
    ...(averageTokPerSec === undefined ? {} : { averageTokPerSec }),
    ...(currentTokPerSec === undefined ? {} : { currentTokPerSec }),
    modelContextWindow,
    ...(model === undefined ? {} : { model }),
  };
}

export function retainTurns(
  turns: readonly TurnUsage[],
  now: number,
  maxTurns = MAX_TURNS_PER_THREAD,
): { kept: TurnUsage[]; removed: TurnUsage[] } {
  const sorted = [...turns].sort((a, b) => b.at - a.at);
  const kept: TurnUsage[] = [];
  const removed: TurnUsage[] = [];
  for (const row of sorted) {
    if (kept.length < maxTurns && row.at >= now - RETENTION_MS) kept.push(row);
    else removed.push(row);
  }
  return { kept, removed };
}
