import type {
  ArchivedWindow,
  BucketSnapshot,
  CurrentWindowLedger,
  Dashboard,
  GroupDashboard,
  LedgerState,
  PeriodSummary,
  TurnCostEntry,
} from "./contract.ts";

const RESET_JUMP_THRESHOLD_MS = 5 * 60_000;
const USED_DROP_RESET_THRESHOLD_PCT = 1.0;
const MIN_MEANINGFUL_DELTA_PCT = 0.0005;
const MAX_DAILY_DAYS = 95;
const MAX_ARCHIVED_WINDOWS = 200;
const MAX_RECENT_TURNS = 60;

export function emptyLedgerState(): LedgerState {
  return {
    version: 1,
    trackingSince: null,
    lastPollAt: null,
    lastError: null,
    current: {},
    daily: {},
    archivedWindows: [],
    recentTurns: [],
  };
}

function roundPct(value: number): number {
  return Math.round(Math.max(0, value) * 10_000) / 10_000;
}

export function localDateKey(timestampMs: number): string {
  const date = new Date(timestampMs);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseMs(iso: string | null): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

function isWindowReset(prev: CurrentWindowLedger, next: BucketSnapshot): boolean {
  const prevResetMs = parseMs(prev.resetTime);
  const nextResetMs = parseMs(next.resetTime);
  if (prevResetMs !== null && nextResetMs !== null && nextResetMs - prevResetMs > RESET_JUMP_THRESHOLD_MS) {
    return true;
  }
  if (prev.lastUsedPct - next.usedPct > USED_DROP_RESET_THRESHOLD_PCT) {
    return true;
  }
  return false;
}

function addDaily(
  daily: LedgerState["daily"],
  dateKey: string,
  bucketId: string,
  delta: { myUsedPct?: number; othersUsedPct?: number; myTurns?: number },
): void {
  const day = daily[dateKey] ?? {};
  const entry = day[bucketId] ?? { myUsedPct: 0, othersUsedPct: 0, myTurns: 0 };
  day[bucketId] = {
    myUsedPct: roundPct(entry.myUsedPct + (delta.myUsedPct ?? 0)),
    othersUsedPct: roundPct(entry.othersUsedPct + (delta.othersUsedPct ?? 0)),
    myTurns: entry.myTurns + (delta.myTurns ?? 0),
  };
  daily[dateKey] = day;
}

function pruneDaily(daily: LedgerState["daily"], nowMs: number): LedgerState["daily"] {
  const cutoff = localDateKey(nowMs - MAX_DAILY_DAYS * 86_400_000);
  const pruned: LedgerState["daily"] = {};
  for (const [dateKey, buckets] of Object.entries(daily)) {
    if (dateKey >= cutoff) pruned[dateKey] = buckets;
  }
  return pruned;
}

export type AttributionMode = "baseline" | "me" | "others";

export interface TurnContext {
  threadId: string;
  threadTitle: string;
}

export function applyQuotaSnapshot(
  prevState: LedgerState,
  snapshot: { observedAt: number; buckets: readonly BucketSnapshot[] },
  mode: AttributionMode,
  turn?: TurnContext,
): LedgerState {
  const nextCurrent: Record<string, CurrentWindowLedger> = { ...prevState.current };
  const nextDaily: LedgerState["daily"] = Object.fromEntries(
    Object.entries(prevState.daily).map(([day, map]) => [day, { ...map }]),
  );
  const nextArchived: ArchivedWindow[] = [...prevState.archivedWindows];
  const dateKey = localDateKey(snapshot.observedAt);
  const turnDeltas: TurnCostEntry["deltas"] = [];

  for (const bucket of snapshot.buckets) {
    const prev = nextCurrent[bucket.id];
    if (!prev) {
      const isInitial = mode === "baseline" || prevState.trackingSince === null;
      const myUsedPct = !isInitial && mode === "me" ? roundPct(bucket.usedPct) : 0;
      const othersUsedPct = !isInitial && mode === "others" ? roundPct(bucket.usedPct) : 0;
      const baselineUsedPct = isInitial ? roundPct(bucket.usedPct) : 0;
      const myTurns = !isInitial && mode === "me" && bucket.usedPct >= MIN_MEANINGFUL_DELTA_PCT ? 1 : 0;
      nextCurrent[bucket.id] = {
        id: bucket.id,
        group: bucket.group,
        window: bucket.window,
        label: bucket.label,
        startedAt: snapshot.observedAt,
        resetTime: bucket.resetTime,
        lastObservedAt: snapshot.observedAt,
        lastUsedPct: bucket.usedPct,
        lastRemainingPct: bucket.remainingPct,
        baselineUsedPct,
        myUsedPct,
        othersUsedPct,
        myTurns,
      };
      if (myUsedPct >= MIN_MEANINGFUL_DELTA_PCT || othersUsedPct >= MIN_MEANINGFUL_DELTA_PCT) {
        addDaily(nextDaily, dateKey, bucket.id, { myUsedPct, othersUsedPct, myTurns });
      }
      if (mode === "me" && myUsedPct >= MIN_MEANINGFUL_DELTA_PCT) {
        turnDeltas.push({ bucketId: bucket.id, group: bucket.group, window: bucket.window, deltaPct: myUsedPct });
      }
      continue;
    }

    if (isWindowReset(prev, bucket)) {
      const prevTotal = roundPct(prev.baselineUsedPct + prev.myUsedPct + prev.othersUsedPct);
      if (prevTotal > 0 || prev.myTurns > 0) {
        nextArchived.unshift({
          id: `${prev.id}:${prev.startedAt}:${snapshot.observedAt}`,
          bucketId: prev.id,
          group: prev.group,
          window: prev.window,
          startedAt: prev.startedAt,
          endedAt: snapshot.observedAt,
          baselineUsedPct: prev.baselineUsedPct,
          myUsedPct: prev.myUsedPct,
          othersUsedPct: prev.othersUsedPct,
          totalUsedPct: Math.max(prev.lastUsedPct, prevTotal),
          myTurns: prev.myTurns,
        });
      }
      const myUsedPct = mode === "me" ? roundPct(bucket.usedPct) : 0;
      const othersUsedPct = mode === "others" ? roundPct(bucket.usedPct) : 0;
      const baselineUsedPct = mode === "baseline" ? roundPct(bucket.usedPct) : 0;
      const myTurns = mode === "me" && bucket.usedPct >= MIN_MEANINGFUL_DELTA_PCT ? 1 : 0;
      nextCurrent[bucket.id] = {
        id: bucket.id,
        group: bucket.group,
        window: bucket.window,
        label: bucket.label,
        startedAt: snapshot.observedAt,
        resetTime: bucket.resetTime,
        lastObservedAt: snapshot.observedAt,
        lastUsedPct: bucket.usedPct,
        lastRemainingPct: bucket.remainingPct,
        baselineUsedPct,
        myUsedPct,
        othersUsedPct,
        myTurns,
      };
      if (myUsedPct >= MIN_MEANINGFUL_DELTA_PCT || othersUsedPct >= MIN_MEANINGFUL_DELTA_PCT) {
        addDaily(nextDaily, dateKey, bucket.id, { myUsedPct, othersUsedPct, myTurns });
      }
      if (mode === "me" && myUsedPct >= MIN_MEANINGFUL_DELTA_PCT) {
        turnDeltas.push({ bucketId: bucket.id, group: bucket.group, window: bucket.window, deltaPct: myUsedPct });
      }
      continue;
    }

    const rawDelta = bucket.usedPct - prev.lastUsedPct;
    const delta = rawDelta >= MIN_MEANINGFUL_DELTA_PCT ? roundPct(rawDelta) : 0;
    const addMe = mode === "me" ? delta : 0;
    const addOthers = mode === "others" ? delta : 0;
    const addBaseline = mode === "baseline" ? delta : 0;
    const addTurn = mode === "me" && delta > 0 ? 1 : 0;

    nextCurrent[bucket.id] = {
      ...prev,
      group: bucket.group,
      window: bucket.window,
      label: bucket.label,
      resetTime: bucket.resetTime ?? prev.resetTime,
      lastObservedAt: snapshot.observedAt,
      lastUsedPct: Math.max(prev.lastUsedPct, bucket.usedPct),
      lastRemainingPct: bucket.remainingPct,
      baselineUsedPct: roundPct(prev.baselineUsedPct + addBaseline),
      myUsedPct: roundPct(prev.myUsedPct + addMe),
      othersUsedPct: roundPct(prev.othersUsedPct + addOthers),
      myTurns: prev.myTurns + addTurn,
    };

    if (addMe > 0 || addOthers > 0) {
      addDaily(nextDaily, dateKey, bucket.id, { myUsedPct: addMe, othersUsedPct: addOthers, myTurns: addTurn });
    }
    if (addMe > 0) {
      turnDeltas.push({ bucketId: bucket.id, group: bucket.group, window: bucket.window, deltaPct: addMe });
    }
  }

  const nextRecentTurns = [...prevState.recentTurns];
  if (mode === "me" && turn && turnDeltas.length > 0) {
    nextRecentTurns.unshift({
      id: `${turn.threadId}:${snapshot.observedAt}`,
      at: snapshot.observedAt,
      threadId: turn.threadId,
      threadTitle: turn.threadTitle,
      deltas: turnDeltas,
    });
  }

  return {
    version: 1,
    trackingSince: prevState.trackingSince ?? snapshot.observedAt,
    lastPollAt: snapshot.observedAt,
    lastError: null,
    current: nextCurrent,
    daily: pruneDaily(nextDaily, snapshot.observedAt),
    archivedWindows: nextArchived.slice(0, MAX_ARCHIVED_WINDOWS),
    recentTurns: nextRecentTurns.slice(0, MAX_RECENT_TURNS),
  };
}

function summarizePeriod(
  daily: LedgerState["daily"],
  bucketIds: ReadonlySet<string>,
  predicate: (dateKey: string) => boolean,
): PeriodSummary {
  let myUsedPct = 0;
  let othersUsedPct = 0;
  let myTurns = 0;
  for (const [dateKey, buckets] of Object.entries(daily)) {
    if (!predicate(dateKey)) continue;
    for (const [bucketId, entry] of Object.entries(buckets)) {
      if (!bucketIds.has(bucketId)) continue;
      myUsedPct += entry.myUsedPct;
      othersUsedPct += entry.othersUsedPct;
      myTurns += entry.myTurns;
    }
  }
  myUsedPct = roundPct(myUsedPct);
  othersUsedPct = roundPct(othersUsedPct);
  const totalAttributedPct = roundPct(myUsedPct + othersUsedPct);
  const mySharePct = totalAttributedPct > 0
    ? Math.round((myUsedPct / totalAttributedPct) * 1000) / 10
    : null;
  return { myUsedPct, othersUsedPct, totalAttributedPct, mySharePct, myTurns };
}

export function buildDashboard(
  state: LedgerState,
  activeThreadsCount: number,
  nowMs = Date.now(),
): Dashboard {
  const buckets = Object.values(state.current);
  const groupNames = Array.from(new Set(buckets.map((bucket) => bucket.group))).sort((a, b) => {
    const aGemini = /^Gemini Models$/i.test(a) ? 0 : 1;
    const bGemini = /^Gemini Models$/i.test(b) ? 0 : 1;
    return aGemini - bGemini;
  });

  const today = localDateKey(nowMs);
  const monthPrefix = today.slice(0, 7);
  const cutoff30d = localDateKey(nowMs - 29 * 86_400_000);
  const cutoff14d = localDateKey(nowMs - 13 * 86_400_000);

  const groups: GroupDashboard[] = groupNames.map((group) => {
    const groupBuckets = buckets.filter((bucket) => bucket.group === group);
    const fiveHour = groupBuckets.find((bucket) => bucket.window === "5h") ?? null;
    const weekly = groupBuckets.find((bucket) => bucket.window === "weekly") ?? null;

    const weeklyIds = new Set(groupBuckets.filter((b) => b.window === "weekly").map((b) => b.id));
    const fiveHourIds = new Set(groupBuckets.filter((b) => b.window === "5h").map((b) => b.id));

    const monthCalendarWeekly = summarizePeriod(state.daily, weeklyIds, (d) => d.startsWith(monthPrefix));
    const last30dWeekly = summarizePeriod(state.daily, weeklyIds, (d) => d >= cutoff30d);
    const monthCalendarFiveHour = summarizePeriod(state.daily, fiveHourIds, (d) => d.startsWith(monthPrefix));

    const dailyDates = Object.keys(state.daily)
      .filter((d) => d >= cutoff14d)
      .sort((a, b) => b.localeCompare(a));

    const daily = dailyDates
      .map((date) => {
        const dayMap = state.daily[date] ?? {};
        let myWeeklyPct = 0;
        let othersWeeklyPct = 0;
        let myFiveHourPct = 0;
        let othersFiveHourPct = 0;
        let myTurns = 0;
        for (const [bucketId, entry] of Object.entries(dayMap)) {
          if (weeklyIds.has(bucketId)) {
            myWeeklyPct += entry.myUsedPct;
            othersWeeklyPct += entry.othersUsedPct;
            myTurns = Math.max(myTurns, entry.myTurns);
          } else if (fiveHourIds.has(bucketId)) {
            myFiveHourPct += entry.myUsedPct;
            othersFiveHourPct += entry.othersUsedPct;
            myTurns = Math.max(myTurns, entry.myTurns);
          }
        }
        return {
          date,
          myWeeklyPct: roundPct(myWeeklyPct),
          othersWeeklyPct: roundPct(othersWeeklyPct),
          myFiveHourPct: roundPct(myFiveHourPct),
          othersFiveHourPct: roundPct(othersFiveHourPct),
          myTurns,
        };
      })
      .filter((row) =>
        row.myWeeklyPct > 0 || row.othersWeeklyPct > 0 || row.myFiveHourPct > 0 || row.othersFiveHourPct > 0 || row.myTurns > 0,
      );

    return {
      group,
      fiveHour,
      weekly,
      monthCalendarWeekly,
      last30dWeekly,
      monthCalendarFiveHour,
      daily,
    };
  });

  return {
    trackingSince: state.trackingSince,
    lastPollAt: state.lastPollAt,
    lastError: state.lastError,
    activeThreadsCount,
    groups,
    recentTurns: state.recentTurns,
    archivedWindows: state.archivedWindows,
  };
}
