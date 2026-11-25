import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { definePluginApp, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { CurrentWindowLedger, Dashboard, GroupDashboard } from "./lib/contract";
import {
  getPopoverAnchors,
  mountPopoverAnchors,
  subscribePopoverAnchors,
} from "./lib/popover-anchor";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const dateTimeFormat = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

function formatPct(value: number): string {
  if (value === 0) return "0%";
  if (value >= 10) return `${value.toFixed(1)}%`;
  return `${value.toFixed(2)}%`;
}

function formatResetCountdown(iso: string | null): string {
  if (!iso) return "Окно не начато";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "Время сброса неизвестно";
  const minutes = Math.ceil((ms - Date.now()) / 60_000);
  if (minutes <= 0) return "Ожидается сброс";
  if (minutes >= 1440) return `Сброс через ${Math.floor(minutes / 1440)} д ${Math.floor((minutes % 1440) / 60)} ч`;
  if (minutes >= 60) return `Сброс через ${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
  return `Сброс через ${minutes} мин`;
}

function shareOf(part: number, total: number): string {
  if (total <= 0) return "—";
  return `${Math.round((part / total) * 1000) / 10}%`;
}

function ChartPieIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12c.552 0 1.005-.449.95-.998a10 10 0 0 0-8.953-8.951c-.55-.055-.998.398-.998.95v8a1 1 0 0 0 1 1z" />
      <path d="M21.21 15.89A10 10 0 1 1 8 2.83" />
    </svg>
  );
}

function WindowCard({ title, ledger }: { title: string; ledger: CurrentWindowLedger | null }) {
  if (!ledger) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">{title}</CardTitle>
          <CardDescription>Нет данных для этой группы</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const attributedTotal = ledger.myUsedPct + ledger.othersUsedPct;
  const totalUsed = Math.min(100, Math.max(ledger.lastUsedPct, ledger.baselineUsedPct + attributedTotal));
  const myWidth = Math.min(100, ledger.myUsedPct);
  const othersWidth = Math.min(Math.max(0, 100 - myWidth), ledger.othersUsedPct);
  const baselineWidth = Math.min(Math.max(0, 100 - myWidth - othersWidth), ledger.baselineUsedPct);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-sm font-medium">{title}</CardTitle>
            <CardDescription className="mt-0.5 text-xs">
              {formatResetCountdown(ledger.resetTime)}
            </CardDescription>
          </div>
          <div className="text-right">
            <div className="text-xl font-semibold tabular-nums">
              {formatPct(ledger.lastRemainingPct)}
            </div>
            <div className="text-[11px] text-muted-foreground">осталось</div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        <div
          className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted"
          role="img"
          aria-label={`Израсходовано ${formatPct(totalUsed)}: я ${formatPct(ledger.myUsedPct)}, остальные ${formatPct(ledger.othersUsedPct)}`}
        >
          {myWidth > 0 ? (
            <div className="h-full bg-emerald-500 transition-all" style={{ width: `${myWidth}%` }} />
          ) : null}
          {othersWidth > 0 ? (
            <div className="h-full bg-amber-500 transition-all" style={{ width: `${othersWidth}%` }} />
          ) : null}
          {baselineWidth > 0 ? (
            <div className="h-full bg-muted-foreground/40 transition-all" style={{ width: `${baselineWidth}%` }} />
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-lg border border-border/70 bg-muted/20 px-2.5 py-2">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <span className="size-2 rounded-full bg-emerald-500" />
              Я (BB)
            </div>
            <div className="mt-1 flex items-baseline justify-between gap-2">
              <span className="text-sm font-semibold tabular-nums">{formatPct(ledger.myUsedPct)}</span>
              <span className="text-[11px] text-muted-foreground tabular-nums">
                доля {shareOf(ledger.myUsedPct, attributedTotal)}
              </span>
            </div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              ходов: {ledger.myTurns}
            </div>
          </div>

          <div className="rounded-lg border border-border/70 bg-muted/20 px-2.5 py-2">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <span className="size-2 rounded-full bg-amber-500" />
              Остальные (семья)
            </div>
            <div className="mt-1 flex items-baseline justify-between gap-2">
              <span className="text-sm font-semibold tabular-nums">{formatPct(ledger.othersUsedPct)}</span>
              <span className="text-[11px] text-muted-foreground tabular-nums">
                доля {shareOf(ledger.othersUsedPct, attributedTotal)}
              </span>
            </div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              всего потрачено: {formatPct(totalUsed)}
            </div>
          </div>
        </div>

        {ledger.baselineUsedPct > 0 ? (
          <p className="text-[11px] text-muted-foreground">
            До начала учёта в этом окне уже было израсходовано {formatPct(ledger.baselineUsedPct)} — после следующего сброса окно начнётся с 0%.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function InlineWindowBreakdown({
  ledger,
  alwaysShow = false,
}: {
  ledger: CurrentWindowLedger | null;
  alwaysShow?: boolean;
}) {
  if (!ledger) return null;
  if (!alwaysShow && ledger.myUsedPct === 0 && ledger.othersUsedPct === 0 && ledger.lastRemainingPct >= 100) {
    return null;
  }
  return (
    <div className="mt-0.5 flex items-center gap-2 whitespace-nowrap text-[11px] leading-4 text-muted-foreground tabular-nums">
      <span className="inline-flex items-center gap-1">
        <span className="size-1.5 rounded-full bg-emerald-500" />
        Я: <strong className="font-medium text-foreground">{formatPct(ledger.myUsedPct)}</strong>
      </span>
      <span aria-hidden="true">·</span>
      <span className="inline-flex items-center gap-1">
        <span className="size-1.5 rounded-full bg-amber-500" />
        Семья: <strong className="font-medium text-foreground">{formatPct(ledger.othersUsedPct)}</strong>
      </span>
    </div>
  );
}

function QuotaOverlay() {
  const anchors = useSyncExternalStore(subscribePopoverAnchors, getPopoverAnchors, () => ({ popover: null, tooltip: null }));
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [modalOpen, setModalOpen] = useState(false);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<string>("Gemini Models");
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    rpc.call("dashboard", {}).then(
      (data) => {
        setDashboard(data);
        setError(null);
      },
      (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (anchors.popover || modalOpen) load();
  }, [anchors.popover, modalOpen, load]);

  useRealtime("quota-updated", load);

  const refresh = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const data = await rpc.call("refresh", {});
      setDashboard(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const resetStats = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const data = await rpc.call("reset", { confirm: true });
      setDashboard(data);
      setConfirmReset(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const activeGroup: GroupDashboard | null = useMemo(() => {
    if (!dashboard || dashboard.groups.length === 0) return null;
    return dashboard.groups.find((g) => g.group === selectedGroup) ?? dashboard.groups[0]!;
  }, [dashboard, selectedGroup]);

  const findLedger = useCallback(
    (groupName: string, kind: "5h" | "weekly"): CurrentWindowLedger | null => {
      const group = dashboard?.groups.find((g) => g.group.toLowerCase() === groupName.toLowerCase());
      if (!group) return null;
      return kind === "5h" ? group.fiveHour : group.weekly;
    },
    [dashboard],
  );

  return (
    <>
      {anchors.popover ? createPortal(
        <button
          type="button"
          className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-[5px] border-0 bg-transparent p-1 text-inherit hover:bg-state-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          aria-label="Статистика расхода квоты Google Antigravity"
          title="Мой и семейный расход (5ч / неделя)"
          onClick={() => {
            setConfirmReset(false);
            setModalOpen(true);
          }}
        >
          <ChartPieIcon className="size-4" />
        </button>,
        anchors.popover.headerNode,
      ) : null}

      {anchors.popover?.windows.map((entry) =>
        createPortal(
          <InlineWindowBreakdown ledger={findLedger(entry.group, entry.window)} />,
          entry.node,
          entry.key,
        ),
      )}

      {anchors.tooltip ? createPortal(
        <InlineWindowBreakdown
          ledger={findLedger(anchors.tooltip.group, anchors.tooltip.window)}
          alwaysShow
        />,
        anchors.tooltip.node,
      ) : null}

      <Dialog open={modalOpen} onOpenChange={(next) => { setModalOpen(next); if (!next) setConfirmReset(false); }}>
        <DialogContent className="z-[80] max-h-[88dvh] max-w-4xl overflow-y-auto p-5 sm:p-6">
          <DialogHeader className="pr-8">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <DialogTitle className="flex items-center gap-2 text-lg">
                  <ChartPieIcon className="size-4 text-muted-foreground" />
                  Квота Google Antigravity
                </DialogTitle>
                <DialogDescription className="mt-1 text-xs">
                  Личный расход в BB и расход семьи/других устройств за 5 часов и неделю по снимкам <code>agy /usage</code>.
                  {dashboard?.trackingSince ? (
                    <>
                      {" "}Учёт с {dateTimeFormat.format(dashboard.trackingSince)}
                      {dashboard.lastPollAt ? ` · обновлено ${dateTimeFormat.format(dashboard.lastPollAt)}` : ""}
                    </>
                  ) : null}
                </DialogDescription>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={busy}>
                  <Icon name="RotateCcw" className={cn("size-3.5", busy && "animate-spin")} />
                  Обновить
                </Button>
                {confirmReset ? (
                  <div className="flex items-center gap-1.5">
                    <Button variant="destructive" size="sm" onClick={() => void resetStats()} disabled={busy}>
                      Точно сбросить
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setConfirmReset(false)} disabled={busy}>
                      Отмена
                    </Button>
                  </div>
                ) : (
                  <Button variant="ghost" size="sm" onClick={() => setConfirmReset(true)} disabled={busy}>
                    <Icon name="Trash2" className="size-3.5" />
                    Сбросить
                  </Button>
                )}
              </div>
            </div>
          </DialogHeader>

          {error || dashboard?.lastError ? (
            <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3.5 py-2.5 text-xs text-destructive">
              {error ?? dashboard?.lastError}
            </div>
          ) : null}

          {!dashboard ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
              Загрузка статистики квоты…
            </div>
          ) : dashboard.groups.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
              Данных пока нет. Нажми «Обновить», чтобы снять первый снимок квоты Antigravity.
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2" role="tablist" aria-label="Группы моделей">
                {dashboard.groups.map((group) => {
                  const isSelected = activeGroup?.group === group.group;
                  return (
                    <button
                      key={group.group}
                      type="button"
                      role="tab"
                      aria-selected={isSelected}
                      onClick={() => setSelectedGroup(group.group)}
                      className={cn(
                        "cursor-pointer rounded-full border px-3 py-1 text-xs font-medium transition",
                        isSelected
                          ? "border-foreground/30 bg-foreground text-background"
                          : "border-border bg-card text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {group.group}
                    </button>
                  );
                })}
              </div>

              {activeGroup ? (
                <>
                  <div className="grid gap-4 md:grid-cols-2">
                    <WindowCard title="Текущий 5-часовик" ledger={activeGroup.fiveHour} />
                    <WindowCard title="Текущая неделя" ledger={activeGroup.weekly} />
                  </div>

                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium">Расход по дням ({activeGroup.group})</CardTitle>
                      <CardDescription className="text-xs">
                        Последние 14 дней с активностью · проценты от 5ч и недельного лимитов
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="pt-0">
                      {activeGroup.daily.length === 0 ? (
                        <p className="py-3 text-xs text-muted-foreground">
                          За последние 14 дней расход пока не зафиксирован.
                        </p>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-left text-xs tabular-nums">
                            <thead>
                              <tr className="border-b border-border text-muted-foreground">
                                <th className="py-2 pr-3 font-medium">Дата</th>
                                <th className="py-2 px-3 font-medium">Я (5ч)</th>
                                <th className="py-2 px-3 font-medium">Семья (5ч)</th>
                                <th className="py-2 px-3 font-medium">Я (нед.)</th>
                                <th className="py-2 px-3 font-medium">Семья (нед.)</th>
                                <th className="py-2 pl-3 text-right font-medium">Мои ходы</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-border/60">
                              {activeGroup.daily.map((row) => (
                                <tr key={row.date}>
                                  <td className="py-2 pr-3 font-mono">{row.date}</td>
                                  <td className="py-2 px-3 text-emerald-500">{formatPct(row.myFiveHourPct)}</td>
                                  <td className="py-2 px-3 text-amber-500">{formatPct(row.othersFiveHourPct)}</td>
                                  <td className="py-2 px-3 font-medium text-emerald-500">{formatPct(row.myWeeklyPct)}</td>
                                  <td className="py-2 px-3 font-medium text-amber-500">{formatPct(row.othersWeeklyPct)}</td>
                                  <td className="py-2 pl-3 text-right text-muted-foreground">{row.myTurns}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium">Последние твои ходы в BB</CardTitle>
                      <CardDescription className="text-xs">
                        Сколько процентов лимита стоил каждый завершённый ход Google Antigravity
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="pt-0">
                      {dashboard.recentTurns.length === 0 ? (
                        <p className="py-3 text-xs text-muted-foreground">
                          Здесь появятся завершённые ходы с заметным расходом квоты.
                        </p>
                      ) : (
                        <ul className="divide-y divide-border/60 text-xs">
                          {dashboard.recentTurns.slice(0, 15).map((turn) => (
                            <li key={turn.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                              <button
                                type="button"
                                onClick={() => {
                                  setModalOpen(false);
                                  navigate.toThread(turn.threadId);
                                }}
                                className="min-w-0 flex-1 cursor-pointer truncate text-left font-medium hover:underline"
                              >
                                {turn.threadTitle}
                              </button>
                              <div className="flex flex-wrap items-center gap-2 tabular-nums">
                                {turn.deltas.map((d) => (
                                  <span
                                    key={`${turn.id}-${d.bucketId}`}
                                    className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-[11px]"
                                  >
                                    {d.group === "Gemini Models" ? "Gemini" : d.group} · {d.window === "5h" ? "5ч" : d.window === "weekly" ? "нед." : d.window}:{" "}
                                    <strong className="text-emerald-500">+{formatPct(d.deltaPct)}</strong>
                                  </span>
                                ))}
                                <span className="text-[11px] text-muted-foreground">
                                  {dateTimeFormat.format(turn.at)}
                                </span>
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </CardContent>
                  </Card>
                </>
              ) : null}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "antigravity-popover-anchor",
    mount: ({ pluginId }) => mountPopoverAnchors(document, pluginId),
  });
  app.slots.experimental_appOverlay({
    id: "quota-modal",
    component: QuotaOverlay,
  });
});
