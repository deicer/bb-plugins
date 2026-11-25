import assert from "node:assert/strict";
import { test } from "node:test";
import { applyQuotaSnapshot, buildDashboard, emptyLedgerState } from "./ledger.ts";
import type { BucketSnapshot } from "./contract.ts";

function bucket(overrides: Partial<BucketSnapshot> & Pick<BucketSnapshot, "id" | "window" | "usedPct">): BucketSnapshot {
  return {
    group: "Gemini Models",
    label: overrides.window === "5h" ? "5 часов" : "Неделя",
    remainingPct: Number((100 - overrides.usedPct).toFixed(4)),
    resetTime: overrides.window === "5h" ? "2026-11-25T18:00:00Z" : "2026-12-01T10:00:00Z",
    ...overrides,
  };
}

test("separates baseline, my BB turns, and idle family usage with high precision", () => {
  const t0 = Date.parse("2026-11-25T13:00:00Z");
  let state = emptyLedgerState();

  // 1. Initial baseline snapshot mid-window: 10% weekly, 4% 5h already used before tracking started.
  state = applyQuotaSnapshot(
    state,
    {
      observedAt: t0,
      buckets: [
        bucket({ id: "gemini-5h", window: "5h", usedPct: 4.0 }),
        bucket({ id: "gemini-weekly", window: "weekly", usedPct: 10.0 }),
      ],
    },
    "baseline",
  );
  assert.equal(state.current["gemini-weekly"]!.baselineUsedPct, 10);
  assert.equal(state.current["gemini-weekly"]!.myUsedPct, 0);
  assert.equal(state.current["gemini-weekly"]!.othersUsedPct, 0);

  // 2. Family uses quota while this Mac is idle (+8.5% 5h, +2.5% weekly).
  state = applyQuotaSnapshot(
    state,
    {
      observedAt: t0 + 5 * 60_000,
      buckets: [
        bucket({ id: "gemini-5h", window: "5h", usedPct: 12.5 }),
        bucket({ id: "gemini-weekly", window: "weekly", usedPct: 12.5 }),
      ],
    },
    "others",
  );
  assert.equal(state.current["gemini-5h"]!.othersUsedPct, 8.5);
  assert.equal(state.current["gemini-weekly"]!.othersUsedPct, 2.5);

  // 3. My BB turn runs and spends +3.25% 5h, +0.95% weekly.
  state = applyQuotaSnapshot(
    state,
    {
      observedAt: t0 + 6 * 60_000,
      buckets: [
        bucket({ id: "gemini-5h", window: "5h", usedPct: 15.75 }),
        bucket({ id: "gemini-weekly", window: "weekly", usedPct: 13.45 }),
      ],
    },
    "me",
    { threadId: "thr_1", threadTitle: "Fix usage rings" },
  );
  assert.equal(state.current["gemini-5h"]!.myUsedPct, 3.25);
  assert.equal(state.current["gemini-5h"]!.myTurns, 1);
  assert.equal(state.current["gemini-weekly"]!.myUsedPct, 0.95);
  assert.equal(state.recentTurns.length, 1);
  assert.equal(state.recentTurns[0]!.threadId, "thr_1");
  assert.equal(state.recentTurns[0]!.deltas.length, 2);

  const dashboard = buildDashboard(state, 0, t0 + 6 * 60_000);
  assert.equal(dashboard.groups.length, 1);
  const gemini = dashboard.groups[0]!;
  assert.equal(gemini.monthCalendarWeekly.myUsedPct, 0.95);
  assert.equal(gemini.monthCalendarWeekly.othersUsedPct, 2.5);
  assert.equal(gemini.monthCalendarWeekly.mySharePct, 27.5);
  assert.equal(gemini.daily.length, 1);
  assert.equal(gemini.daily[0]!.myFiveHourPct, 3.25);
  assert.equal(gemini.daily[0]!.othersFiveHourPct, 8.5);
});

test("detects window reset, archives old window, resets baseline to 0, and accumulates monthly total across resets", () => {
  const t0 = Date.parse("2026-11-20T10:00:00Z");
  let state = emptyLedgerState();

  state = applyQuotaSnapshot(
    state,
    { observedAt: t0, buckets: [bucket({ id: "gemini-weekly", window: "weekly", usedPct: 0, resetTime: "2026-11-24T10:00:00Z" })] },
    "baseline",
  );
  state = applyQuotaSnapshot(
    state,
    { observedAt: t0 + 60_000, buckets: [bucket({ id: "gemini-weekly", window: "weekly", usedPct: 60, resetTime: "2026-11-24T10:00:00Z" })] },
    "me",
    { threadId: "thr_a", threadTitle: "Week 1 work" },
  );
  state = applyQuotaSnapshot(
    state,
    { observedAt: t0 + 120_000, buckets: [bucket({ id: "gemini-weekly", window: "weekly", usedPct: 90, resetTime: "2026-11-24T10:00:00Z" })] },
    "others",
  );

  // Weekly window resets on Nov 25, then my turn uses 20% of the fresh week.
  const tReset = Date.parse("2026-11-25T10:00:00Z");
  state = applyQuotaSnapshot(
    state,
    { observedAt: tReset, buckets: [bucket({ id: "gemini-weekly", window: "weekly", usedPct: 20, resetTime: "2026-12-02T10:00:00Z" })] },
    "me",
    { threadId: "thr_b", threadTitle: "Week 2 work" },
  );

  assert.equal(state.archivedWindows.length, 1);
  assert.equal(state.archivedWindows[0]!.myUsedPct, 60);
  assert.equal(state.archivedWindows[0]!.othersUsedPct, 30);

  assert.equal(state.current["gemini-weekly"]!.baselineUsedPct, 0);
  assert.equal(state.current["gemini-weekly"]!.myUsedPct, 20);
  assert.equal(state.current["gemini-weekly"]!.othersUsedPct, 0);

  // Calendar month (Nov 2026) sums both weeks: me = 80%, others = 30%, total = 110% (1.10 weekly quotas).
  const dashboard = buildDashboard(state, 0, tReset);
  const month = dashboard.groups[0]!.monthCalendarWeekly;
  assert.equal(month.myUsedPct, 80);
  assert.equal(month.othersUsedPct, 30);
  assert.equal(month.totalAttributedPct, 110);
  assert.equal(month.mySharePct, 72.7);
});
