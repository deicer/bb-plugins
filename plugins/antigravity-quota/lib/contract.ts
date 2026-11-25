import type { PluginRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const pct = z.number().finite().min(0).max(100_000);
const bucketPct = z.number().finite().min(0).max(100);

export const bucketSnapshotSchema = z.object({
  id: z.string().min(1),
  group: z.string().min(1),
  window: z.enum(["5h", "weekly", "other"]),
  label: z.string().min(1),
  remainingPct: bucketPct,
  usedPct: bucketPct,
  resetTime: z.string().nullable(),
});

export const hostSnapshotSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    observedAt: z.number().int().positive(),
    buckets: z.array(bucketSnapshotSchema),
  }),
  z.object({
    status: z.enum(["not_installed", "unauthenticated", "expired", "error"]),
    observedAt: z.number().int().positive(),
    message: z.string(),
  }),
]);

export const currentWindowLedgerSchema = z.object({
  id: z.string().min(1),
  group: z.string().min(1),
  window: z.enum(["5h", "weekly", "other"]),
  label: z.string().min(1),
  startedAt: z.number().int().positive(),
  resetTime: z.string().nullable(),
  lastObservedAt: z.number().int().positive(),
  lastUsedPct: bucketPct,
  lastRemainingPct: bucketPct,
  baselineUsedPct: bucketPct,
  myUsedPct: pct,
  othersUsedPct: pct,
  myTurns: z.number().int().nonnegative(),
});

export const dailyBucketStatsSchema = z.object({
  myUsedPct: pct,
  othersUsedPct: pct,
  myTurns: z.number().int().nonnegative(),
});

export const turnCostEntrySchema = z.object({
  id: z.string().min(1),
  at: z.number().int().positive(),
  threadId: z.string().min(1),
  threadTitle: z.string().min(1),
  deltas: z.array(z.object({
    bucketId: z.string().min(1),
    group: z.string().min(1),
    window: z.enum(["5h", "weekly", "other"]),
    deltaPct: pct,
  })),
});

export const archivedWindowSchema = z.object({
  id: z.string().min(1),
  bucketId: z.string().min(1),
  group: z.string().min(1),
  window: z.enum(["5h", "weekly", "other"]),
  startedAt: z.number().int().positive(),
  endedAt: z.number().int().positive(),
  baselineUsedPct: bucketPct,
  myUsedPct: pct,
  othersUsedPct: pct,
  totalUsedPct: pct,
  myTurns: z.number().int().nonnegative(),
});

export const ledgerStateSchema = z.object({
  version: z.literal(1),
  trackingSince: z.number().int().positive().nullable(),
  lastPollAt: z.number().int().positive().nullable(),
  lastError: z.string().nullable(),
  current: z.record(z.string(), currentWindowLedgerSchema),
  /** Key: YYYY-MM-DD (local date) -> bucketId -> daily totals */
  daily: z.record(z.string(), z.record(z.string(), dailyBucketStatsSchema)),
  archivedWindows: z.array(archivedWindowSchema),
  recentTurns: z.array(turnCostEntrySchema),
});

export const periodSummarySchema = z.object({
  myUsedPct: pct,
  othersUsedPct: pct,
  totalAttributedPct: pct,
  mySharePct: z.number().finite().min(0).max(100).nullable(),
  myTurns: z.number().int().nonnegative(),
});

export const dailyRowSchema = z.object({
  date: z.string(),
  myWeeklyPct: pct,
  othersWeeklyPct: pct,
  myFiveHourPct: pct,
  othersFiveHourPct: pct,
  myTurns: z.number().int().nonnegative(),
});

export const groupDashboardSchema = z.object({
  group: z.string().min(1),
  fiveHour: currentWindowLedgerSchema.nullable(),
  weekly: currentWindowLedgerSchema.nullable(),
  monthCalendarWeekly: periodSummarySchema,
  last30dWeekly: periodSummarySchema,
  monthCalendarFiveHour: periodSummarySchema,
  daily: z.array(dailyRowSchema),
});

export const dashboardSchema = z.object({
  trackingSince: z.number().int().positive().nullable(),
  lastPollAt: z.number().int().positive().nullable(),
  lastError: z.string().nullable(),
  activeThreadsCount: z.number().int().nonnegative(),
  groups: z.array(groupDashboardSchema),
  recentTurns: z.array(turnCostEntrySchema),
  archivedWindows: z.array(archivedWindowSchema),
});

export const hostContract = {
  readQuota: {
    input: z.object({}).strict(),
    output: hostSnapshotSchema,
  },
} satisfies PluginRpcContract;

export const rpcContract = {
  dashboard: {
    input: z.object({}).strict(),
    output: dashboardSchema,
    tags: () => ["antigravity-quota"],
  },
  refresh: {
    input: z.object({}).strict(),
    output: dashboardSchema,
  },
  reset: {
    input: z.object({ confirm: z.literal(true) }).strict(),
    output: dashboardSchema,
  },
} satisfies PluginRpcContract;

export type BucketSnapshot = z.infer<typeof bucketSnapshotSchema>;
export type HostSnapshot = z.infer<typeof hostSnapshotSchema>;
export type CurrentWindowLedger = z.infer<typeof currentWindowLedgerSchema>;
export type TurnCostEntry = z.infer<typeof turnCostEntrySchema>;
export type ArchivedWindow = z.infer<typeof archivedWindowSchema>;
export type LedgerState = z.infer<typeof ledgerStateSchema>;
export type PeriodSummary = z.infer<typeof periodSummarySchema>;
export type GroupDashboard = z.infer<typeof groupDashboardSchema>;
export type Dashboard = z.infer<typeof dashboardSchema>;
