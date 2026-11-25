import { z } from "zod";
import { TOKENS_DISPLAY_TAG, tokensDisplayPatchSchema, tokensDisplaySchema } from "./display";

const tokenCount = z.number().finite().nonnegative();

const usageValuesSchema = z.object({
  inputTokens: tokenCount,
  cachedInputTokens: tokenCount,
  cacheReadInputTokens: tokenCount.optional(),
  cacheWriteInputTokens: tokenCount.optional(),
  outputTokens: tokenCount,
  reasoningOutputTokens: tokenCount,
  totalTokens: tokenCount,
});

export const tokenUsageSchema = z.object({
  last: usageValuesSchema,
  total: usageValuesSchema,
  modelContextWindow: tokenCount.nullable(),
  promptCacheTtlMs: tokenCount.optional(),
});

export const contextWindowUsageSchema = z.object({
  usedTokens: tokenCount,
  modelContextWindow: tokenCount.nullable(),
  estimated: z.boolean().optional(),
});

const eventScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread") }),
  z.object({ kind: z.literal("turn"), turnId: z.string().min(1) }),
]);

const eventBaseShape = {
  threadId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  createdAt: tokenCount,
  scope: eventScopeSchema.optional(),
  /** Compatibility fallback: bb puts the turn on `scope`, not on the row. */
  turnId: z.string().min(1).optional(),
};

type ScopeBearing = { scope?: z.infer<typeof eventScopeSchema>; turnId?: string };

function scopeTurnId(row: ScopeBearing): string | undefined {
  return row.scope?.kind === "turn" ? row.scope.turnId : row.turnId;
}

const requireTurnScope = { message: "event has no turn scope", path: ["scope"] };

export const usageEventRowSchema = z.object({
  type: z.literal("thread/tokenUsage/updated"),
  ...eventBaseShape,
  data: z.object({ tokenUsage: tokenUsageSchema }),
})
  .refine((row) => scopeTurnId(row) !== undefined, requireTurnScope)
  .transform((row) => ({ ...row, turnId: scopeTurnId(row) as string }));

export const contextWindowUsageEventRowSchema = z.object({
  type: z.literal("thread/contextWindowUsage/updated"),
  ...eventBaseShape,
  data: z.object({
    providerThreadId: z.string().min(1).optional(),
    contextWindowUsage: contextWindowUsageSchema,
  }),
})
  .refine((row) => scopeTurnId(row) !== undefined, requireTurnScope)
  .transform((row) => ({ ...row, turnId: scopeTurnId(row) as string }));

/** `turn/started` and `turn/completed`: only their timestamps and turn id matter. */
export const turnEventRowSchema = z.object({
  type: z.enum(["turn/started", "turn/completed"]),
  ...eventBaseShape,
  data: z.unknown().optional(),
})
  .refine((row) => scopeTurnId(row) !== undefined, requireTurnScope)
  .transform((row) => ({ ...row, turnId: scopeTurnId(row) as string }));

/**
 * `item/started` and `item/completed`. `itemKind` comes from `data.item.type`
 * (bb's own DB also keeps it in an `item_kind` column).
 */
export const itemEventRowSchema = z.object({
  type: z.enum(["item/started", "item/completed"]),
  ...eventBaseShape,
  itemKind: z.string().min(1).optional(),
  data: z.object({ item: z.object({ type: z.string().min(1) }).loose().optional() }).optional(),
})
  .refine((row) => scopeTurnId(row) !== undefined, requireTurnScope)
  .transform((row) => ({
    ...row,
    turnId: scopeTurnId(row) as string,
    itemKind: row.data?.item?.type ?? row.itemKind,
  }));

/**
 * `client/turn/requested`: модель, с которой клиент запустил ход, лежит в
 * `data.execution.model`. Событие висит на треде, а не на ходе, поэтому
 * привязка к ходу идёт по sequence/времени, а не по scope.
 */
export const modelRequestRowSchema = z.object({
  type: z.literal("client/turn/requested"),
  ...eventBaseShape,
  data: z
    .object({ execution: z.object({ model: z.string().min(1) }).loose().optional() })
    .loose()
    .optional(),
}).transform((row) => ({ seq: row.seq, createdAt: row.createdAt, model: row.data?.execution?.model }));

export const turnUsageSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  /** Источник usage: полный `thread/tokenUsage/updated`, обогащённый transcript Antigravity или только `thread/contextWindowUsage/updated`. */
  usageSource: z.enum(["tokenUsage", "antigravityTranscript", "contextWindow"]).optional(),
  input: tokenCount,
  cached: tokenCount,
  cacheRead: tokenCount.optional(),
  cacheWrite: tokenCount.optional(),
  output: tokenCount,
  reasoning: tokenCount,
  total: tokenCount,
  modelContextWindow: tokenCount.nullable().optional(),
  /** Окно последнего вызова модели; отсутствует, когда окно неизвестно (старые записи хранят null). */
  durationMs: z.union([z.number().positive(), z.null()]).optional(),
  /** Весь ход: turn/completed − turn/started. */
  turnDurationMs: z.number().positive().optional(),
  tokPerSec: tokenCount.optional(),
  model: z.string().min(1).optional(),
  providerId: z.string().min(1).optional(),
  at: tokenCount,
});

export const threadUsageSchema = z.object({
  threadId: z.string().min(1),
  total: tokenCount,
  turns: z.number().int().nonnegative(),
  averageTokPerSec: tokenCount.optional(),
  currentTokPerSec: tokenCount.optional(),
  modelContextWindow: tokenCount.nullable(),
  /** Модель самого свежего хода, у которого она есть; иначе поля нет. */
  model: z.string().min(1).optional(),
});

export type TokenUsage = z.infer<typeof tokenUsageSchema>;
export type ContextWindowUsage = z.infer<typeof contextWindowUsageSchema>;
export type UsageEventRow = z.infer<typeof usageEventRowSchema>;
export type ContextWindowUsageEventRow = z.infer<typeof contextWindowUsageEventRowSchema>;
export type TurnEventRow = z.infer<typeof turnEventRowSchema>;
export type ItemEventRow = z.infer<typeof itemEventRowSchema>;
export type ModelRequestRow = z.infer<typeof modelRequestRowSchema>;
export type TurnUsage = z.infer<typeof turnUsageSchema>;
export type ThreadUsage = z.infer<typeof threadUsageSchema>;

/** RPC cache tag shared by both methods and by the server's invalidation. */
export function threadTag(threadId: string): string {
  return `thread:${threadId}`;
}

function keyThreadTag(key: string): readonly string[] {
  const separator = key.indexOf(":");
  return separator > 0 ? [threadTag(key.slice(0, separator))] : [];
}

// Frontend-safe runtime contract: defineRpcContract вызывается только в server.ts.
export const tokensRpcContract = {
  turn_usage: {
    input: z.object({ keys: z.array(z.string().min(3)).max(500) }).strict(),
    output: z.record(z.string(), turnUsageSchema.nullable()),
    keyTags: (key: string) => keyThreadTag(key),
  },
  thread_usage: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: threadUsageSchema.nullable(),
    tags: (input: { threadId: string }) => [threadTag(input.threadId)],
  },
  tokens_display_get: {
    input: z.null(),
    output: tokensDisplaySchema,
    tags: () => [TOKENS_DISPLAY_TAG],
  },
  tokens_display_set: {
    input: tokensDisplayPatchSchema,
    output: tokensDisplaySchema,
  },
};