import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TokenUsage } from "./contract";

const SAFE_PROVIDER_THREAD_ID = /^[a-zA-Z0-9_-]{1,128}$/;

export type AntigravityTranscriptEntry = {
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalTokens: number;
  createdAtMs: number | null;
  model?: string;
};

export type AntigravityUsageLookup = (args: {
  providerThreadId: string;
  usedTokens: number;
  eventCreatedAt: number;
  modelContextWindow: number | null;
}) => Promise<TokenUsage | null>;

export function isSafeProviderThreadId(providerThreadId: string): boolean {
  return SAFE_PROVIDER_THREAD_ID.test(providerThreadId);
}

function asNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function parseAntigravityTranscript(raw: string): AntigravityTranscriptEntry[] {
  const entries: AntigravityTranscriptEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const record = parsed as Record<string, unknown>;
    if (record.type !== "PLANNER_RESPONSE") continue;
    const inputTokens = asNonNegativeNumber(record.input_tokens);
    const outputTokens = asNonNegativeNumber(record.output_tokens);
    if (inputTokens === null || outputTokens === null) continue;
    const cacheReadTokens = asNonNegativeNumber(record.cache_read_tokens) ?? 0;
    const createdAtMs = typeof record.created_at === "string" && Number.isFinite(Date.parse(record.created_at))
      ? Date.parse(record.created_at)
      : null;
    const model = typeof record.model === "string" && record.model.length > 0 ? record.model : undefined;
    entries.push({
      inputTokens,
      cacheReadTokens,
      outputTokens,
      totalTokens: inputTokens + cacheReadTokens + outputTokens,
      createdAtMs,
      ...(model ? { model } : {}),
    });
  }
  return entries;
}

export function matchAntigravityUsage(
  entries: readonly AntigravityTranscriptEntry[],
  usedTokens: number,
  eventCreatedAt: number,
  modelContextWindow: number | null,
): TokenUsage | null {
  const matches = entries.filter((entry) => entry.totalTokens === usedTokens);
  if (matches.length === 0) return null;

  let best = matches[matches.length - 1]!;
  let bestDistance = best.createdAtMs === null ? Number.POSITIVE_INFINITY : Math.abs(eventCreatedAt - best.createdAtMs);
  for (const entry of matches) {
    if (entry.createdAtMs === null) continue;
    const distance = Math.abs(eventCreatedAt - entry.createdAtMs);
    if (distance <= bestDistance) {
      best = entry;
      bestDistance = distance;
    }
  }

  const values = {
    inputTokens: best.inputTokens + best.cacheReadTokens,
    cachedInputTokens: best.cacheReadTokens,
    cacheReadInputTokens: best.cacheReadTokens,
    outputTokens: best.outputTokens,
    reasoningOutputTokens: 0,
    totalTokens: best.totalTokens,
  };
  return {
    last: values,
    total: values,
    modelContextWindow,
  };
}

export function createAntigravityUsageLookup(
  brainDir = path.join(os.homedir(), ".gemini", "antigravity-cli", "brain"),
  retryDelayMs = 120,
): AntigravityUsageLookup {
  return async ({ providerThreadId, usedTokens, eventCreatedAt, modelContextWindow }) => {
    if (!isSafeProviderThreadId(providerThreadId)) return null;
    const transcriptPath = path.join(brainDir, providerThreadId, ".system_generated", "logs", "transcript.jsonl");
    const readAndMatch = async (): Promise<{ exists: boolean; usage: TokenUsage | null }> => {
      let raw: string;
      try {
        raw = await readFile(transcriptPath, "utf8");
      } catch {
        return { exists: false, usage: null };
      }
      return { exists: true, usage: matchAntigravityUsage(parseAntigravityTranscript(raw), usedTokens, eventCreatedAt, modelContextWindow) };
    };
    const first = await readAndMatch();
    if (first.usage || !first.exists || retryDelayMs <= 0) return first.usage;
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    return (await readAndMatch()).usage;
  };
}
