// «Api модели» — панель: аккордеоны API-адресов, внутри слева доступные модели
// (GET /models минус подключённые), справа подключённые с формой настроек pi.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import { API_TYPES, MODEL_FIELDS, groupProvidersByBaseUrl } from "./lib/schema";
import { groupByFamily } from "./lib/model-groups";
import { shouldAutoLoad } from "./lib/auto-load";
import type { ApiType, ModelPatch, ProviderView } from "./lib/schema";
import type { RelayAccount } from "./lib/relay-accounts";
import { successPercent, groupAccountsByProvider, partitionByQuota, shouldGroupByProvider } from "./lib/relay-accounts";
import { quotaLabel } from "./lib/quota-labels";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type Report = (cause: unknown) => void;

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** Тумблер вкл/выкл модели (role=switch, без новых зависимостей). */
function Switch({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label}
      onClick={(event) => { event.stopPropagation(); onChange(!checked); }}
      className={`relative h-4.5 w-8 shrink-0 rounded-full transition-colors ${checked ? "bg-emerald-500" : "bg-muted-foreground/30"}`}>
      <span className={`absolute top-0.5 left-0.5 size-3.5 rounded-full bg-background shadow-sm transition-transform ${checked ? "translate-x-3.5" : ""}`} />
    </button>
  );
}

/** Двухшаговое подтверждение destructive-действия без модальных диалогов. */
function ConfirmButton({ label, confirmLabel, onConfirm, icon }: { label: string; confirmLabel: string; onConfirm: () => void; icon: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <Button variant="ghost" size="sm" className={armed ? "text-destructive" : "text-muted-foreground"}
      onClick={(event) => { event.stopPropagation(); if (armed) { setArmed(false); onConfirm(); } else setArmed(true); }}>
      <Icon name={icon} className="size-3.5" />{armed ? confirmLabel : label}
    </Button>
  );
}

type Draft = Record<string, string | boolean | string[]>;
function toDraft(model: Record<string, unknown>): Draft {
  const draft: Draft = {};
  for (const field of MODEL_FIELDS) {
    const value = model[field.key];
    if (field.type === "bool") draft[field.key] = value === true;
    else if (field.type === "multiselect") draft[field.key] = Array.isArray(value) ? value.map(String) : ["text"];
    else draft[field.key] = value === undefined || value === null ? "" : String(value);
  }
  return draft;
}

/** Форма настроек модели: контролы генерятся из MODEL_FIELDS (тип → контрол). */
function ModelForm({ providerId, model, rpc, report }: { providerId: string; model: Record<string, unknown>; rpc: Rpc; report: Report }) {
  const initial = useMemo(() => toDraft(model), [model]);
  const [draft, setDraft] = useState<Draft>(initial);
  useEffect(() => setDraft(initial), [initial]);
  const set = (key: string, value: string | boolean | string[]) => setDraft((current) => ({ ...current, [key]: value }));
  const save = () => {
    const patch: Record<string, unknown> = {};
    for (const field of MODEL_FIELDS) {
      const value = draft[field.key];
      if (JSON.stringify(value) === JSON.stringify(initial[field.key])) continue;
      if (field.type === "bool") patch[field.key] = value;
      else if (field.type === "int") {
        if (value === "") patch[field.key] = null;
        else {
          const num = Number(value);
          if (!Number.isInteger(num) || num <= 0) { toast.error(`${field.label}: нужно целое > 0`); return; }
          patch[field.key] = num;
        }
      } else if (field.type === "multiselect") patch[field.key] = (value as string[]).length ? value : null;
      else patch[field.key] = value === "" ? null : value;
    }
    if (!Object.keys(patch).length) { toast("Без изменений"); return; }
    rpc.call("model_update", { providerId, modelId: String(model.id), patch: patch as ModelPatch })
      .then(() => toast.success("Сохранено — pi подхватит при открытии /model"), report);
  };
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/70 bg-background/60 p-3">
      {MODEL_FIELDS.map((field) => (
        <div key={field.key} className="flex items-center justify-between gap-3 text-sm">
          <span className="text-muted-foreground">{field.label}</span>
          {field.type === "bool" ? (
            <Checkbox checked={draft[field.key] === true} onCheckedChange={(v) => set(field.key, v === true)} aria-label={field.label} />
          ) : field.type === "multiselect" ? (
            <span className="flex gap-3">
              {field.options!.map((option) => (
                <span key={option} className="flex items-center gap-1.5 text-xs">
                  <Checkbox checked={(draft[field.key] as string[]).includes(option)}
                    onCheckedChange={(v) => set(field.key, v === true ? [...(draft[field.key] as string[]), option] : (draft[field.key] as string[]).filter((x) => x !== option))}
                    aria-label={option} />
                  {option}
                </span>
              ))}
            </span>
          ) : (
            <Input className="h-8 w-40" type={field.type === "int" ? "number" : "text"} placeholder={field.placeholder}
              value={String(draft[field.key] ?? "")} onChange={(event) => set(field.key, event.target.value)} aria-label={field.label} />
          )}
        </div>
      ))}
      <div className="mt-1 flex justify-end">
        <Button size="sm" onClick={save}><Icon name="Check" className="size-3.5" />Сохранить</Button>
      </div>
    </div>
  );
}

function ModelAccordion({ providerId, model, enabled, onToggle, rpc, report }: { providerId: string; model: Record<string, unknown>; enabled: boolean; onToggle: (value: boolean) => void; rpc: Rpc; report: Report }) {
  const [open, setOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const modelId = String(model.id);
  const runTest = () => {
    setTesting(true);
    rpc.call("model_test", { providerId, modelId }).then(
      (result) => {
        setTesting(false);
        const seconds = (result.latencyMs / 1000).toFixed(1);
        if (result.ok) toast.success(`${modelId}: работает (${seconds}с) — ${result.detail}`);
        else toast.error(`${modelId}: ${result.detail}`);
      },
      (cause) => { setTesting(false); report(cause); },
    );
  };
  return (
    <div className={`rounded-lg border border-border/70 transition-opacity ${enabled ? "" : "opacity-60"}`}>
      <div className="flex items-center gap-1 px-2 py-1.5">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm" onClick={() => setOpen(!open)} aria-expanded={open}>
          <Icon name="ChevronDown" className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`} />
          <span className="truncate font-mono text-xs">{modelId}</span>
          {typeof model.name === "string" ? <span className="truncate text-xs text-muted-foreground">{model.name}</span> : null}
          {!enabled ? <span className="shrink-0 rounded-full border border-border px-1.5 text-[10px] text-muted-foreground">выкл</span> : null}
        </button>
        <Switch checked={enabled} onChange={onToggle} label={`${enabled ? "Выключить" : "Включить"} ${modelId}`} />
        <Button variant="ghost" size="sm" className="shrink-0 text-muted-foreground" disabled={testing} onClick={runTest} aria-label={`Тест ${modelId}`}>
          <Icon name={testing ? "Loading" : "Target"} className={`size-3.5 ${testing ? "animate-spin" : ""}`} />Тест
        </Button>
        <ConfirmButton icon="Trash2" label="" confirmLabel="Точно?"
          onConfirm={() => rpc.call("model_disconnect", { providerId, modelId }).then(() => toast.success(`Отключена ${modelId}`), report)} />
      </div>
      {open ? <div className="px-2 pb-2"><ModelForm providerId={providerId} model={model} rpc={rpc} report={report} /></div> : null}
    </div>
  );
}

function ProviderSection({ provider, rpc, report, onEdit, nested = false }: { provider: ProviderView; rpc: Rpc; report: Report; onEdit: () => void; nested?: boolean }) {
  const [open, setOpen] = useState(false);
  const [discovered, setDiscovered] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [manualId, setManualId] = useState("");
  const [filter, setFilter] = useState<"all" | "on" | "off">("all");
  const connected = useMemo(() => new Set(provider.models.map((model) => String(model.id))), [provider.models]);
  const available = (discovered ?? []).filter((id) => !connected.has(id));
  const leftGroups = groupByFamily(available.map((id) => ({ id })));
  const rightItems = [
    ...(filter === "off" ? [] : provider.models.map((entry) => ({ entry, on: true, id: String(entry.id) }))),
    ...(filter === "on" ? [] : provider.disabled.map((entry) => ({ entry, on: false, id: String(entry.id) }))),
  ];
  const rightGroups = groupByFamily(rightItems);
  const counts = { all: provider.models.length + provider.disabled.length, on: provider.models.length, off: provider.disabled.length };
  const discover = useCallback(() => {
    setBusy(true);
    setDiscoverError(null);
    rpc.call("models_discover", { providerId: provider.id }).then(
      ({ models }) => { setDiscovered(models); setBusy(false); },
      (cause) => { setBusy(false); setDiscoverError(message(cause)); },
    );
  }, [rpc, provider.id]);
  // Автозагрузка один раз: после ошибки не ретраим сам (иначе бесконечный цикл
  // на недоступном эндпоинте); повтор — только кнопкой ⟳.
  useEffect(() => {
    if (shouldAutoLoad({ open, loaded: discovered !== null, busy, error: discoverError })) discover();
  }, [open, discovered, busy, discoverError, discover]);
  const connect = (modelId: string) => {
    if (!modelId.trim()) return;
    rpc.call("model_connect", { providerId: provider.id, modelId: modelId.trim() })
      .then(() => { toast.success(`Подключена ${modelId.trim()}`); setManualId(""); }, report);
  };
  return (
    <section className={nested ? "rounded-lg border border-border/60 bg-background/40" : "rounded-xl bg-muted/30"}>
      <div className="flex items-center gap-2 px-3 py-2">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
          <Icon name="ChevronDown" className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`} />
          <span className="truncate text-sm font-medium">{provider.name || provider.id}</span>
          {!nested ? <span className="truncate font-mono text-xs text-muted-foreground">{provider.baseUrl}</span> : null}
          <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">{provider.models.length} подкл.</span>
          {!provider.apiKeySet ? <span className="shrink-0 text-[10px] text-destructive">ключ не задан</span> : null}
        </button>
        <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" aria-label="Обновить список моделей"
          onClick={() => { setOpen(true); discover(); }}><Icon name={busy ? "Loading" : "Download"} className={`size-3.5 ${busy ? "animate-spin" : ""}`} /></Button>
        <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" aria-label="Настроить адрес" onClick={onEdit}><Icon name="Edit" className="size-3.5" /></Button>
        <ConfirmButton icon="Trash2" label="" confirmLabel="Удалить API?"
          onConfirm={() => rpc.call("provider_delete", { id: provider.id }).then(() => toast.success(`Удалён ${provider.id}`), report)} />
      </div>
      {open ? (
        <div className="grid gap-3 px-3 pb-3 md:grid-cols-2">
          <div className="rounded-lg border border-border/70 p-2">
            <div className="mb-2 px-1 text-xs font-medium text-muted-foreground">Доступные (GET /models)</div>
            {busy ? <div className="px-1 py-2 text-xs text-muted-foreground">Загрузка…</div> : null}
            {discoverError ? <div className="mb-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive" role="alert">{discoverError}</div> : null}
            <div className="flex flex-col gap-1">
              {leftGroups.map((group, groupIndex) => (
                <div key={group.family}>
                  <div className={`mb-1 flex items-center gap-2 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground ${groupIndex === 0 ? "" : "mt-2"}`}>
                    {group.family}<span className="font-normal">{group.items.length}</span>
                  </div>
                  <div className="flex flex-col gap-1">
                    {group.items.map(({ id }) => (
                      <div key={id} className="flex items-center justify-between gap-2 rounded-md px-2 py-1 hover:bg-muted/60">
                        <span className="truncate font-mono text-xs">{id}</span>
                        <Button variant="ghost" size="sm" className="shrink-0 text-muted-foreground" onClick={() => connect(id)} aria-label={`Подключить ${id}`}>
                          <Icon name="Plus" className="size-3.5" />Подключить
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {!busy && !discoverError && available.length === 0 ? <div className="px-2 py-1 text-xs text-muted-foreground">{discovered === null ? "Раскрой адрес — список загрузится сам" : "Все доступные уже подключены"}</div> : null}
            </div>
            <form className="mt-2 flex gap-1.5" onSubmit={(event) => { event.preventDefault(); connect(manualId); }}>
              <Input className="h-8 flex-1 font-mono text-xs" placeholder="добавить по id вручную" value={manualId} onChange={(event) => setManualId(event.target.value)} aria-label="id модели вручную" />
              <Button type="submit" variant="outline" size="sm" className="h-8 shrink-0"><Icon name="Plus" className="size-3.5" /></Button>
            </form>
          </div>
          <div className="rounded-lg border border-border/70 p-2">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1">
              <span className="text-xs font-medium text-muted-foreground">Подключённые (в pi)</span>
              <div className="flex gap-0.5 rounded-md bg-muted/40 p-0.5" role="group" aria-label="Фильтр по состоянию">
                {([["all", "Все"], ["on", "Вкл"], ["off", "Выкл"]] as const).map(([id, label]) => (
                  <button key={id} type="button" onClick={() => setFilter(id)} aria-pressed={filter === id}
                    className={`rounded px-2 py-0.5 text-[11px] transition ${filter === id ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
                    {label} {counts[id]}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              {rightGroups.map((group, groupIndex) => (
                <div key={group.family}>
                  <div className={`mb-1 flex items-center gap-2 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground ${groupIndex === 0 ? "" : "mt-2"}`}>
                    {group.family}<span className="font-normal">{group.items.length}</span>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {group.items.map(({ entry, on }) => (
                      <ModelAccordion key={String(entry.id)} providerId={provider.id} model={entry} enabled={on}
                        onToggle={(value) => rpc.call("model_toggle", { providerId: provider.id, modelId: String(entry.id), enabled: value })
                          .then(() => toast.success(value ? `Включена ${entry.id}` : `Выключена ${entry.id} — настройки сохранены`), report)}
                        rpc={rpc} report={report} />
                    ))}
                  </div>
                </div>
              ))}
              {rightItems.length === 0 ? <div className="px-2 py-1 text-xs text-muted-foreground">{filter === "all" ? "Пока пусто — подключи слева" : "Ничего по фильтру"}</div> : null}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** Несколько провайдеров на одном адресе → общая группа с вложенными аккордеонами. */
function AddressGroup({ baseUrl, providers, rpc, report, onEdit }: { baseUrl: string; providers: ProviderView[]; rpc: Rpc; report: Report; onEdit: (provider: ProviderView) => void }) {
  const [open, setOpen] = useState(true);
  const total = providers.reduce((sum, provider) => sum + provider.models.length, 0);
  return (
    <section className="rounded-xl bg-muted/30">
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name="ChevronDown" className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`} />
        <Icon name="Folder" className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono text-xs">{baseUrl}</span>
        <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">{providers.length} пров. · {total} подкл.</span>
      </button>
      {open ? (
        <div className="flex flex-col gap-2 px-3 pb-3">
          {providers.map((provider) => (
            <ProviderSection key={provider.id} provider={provider} rpc={rpc} report={report} nested onEdit={() => onEdit(provider)} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ProviderDialog({ editing, rpc, report, onClose }: { editing: ProviderView | null; rpc: Rpc; report: Report; onClose: () => void }) {
  const [id, setId] = useState(editing?.id ?? "");
  const [name, setName] = useState(editing?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? "");
  const [api, setApi] = useState<string>(editing?.api ?? "openai-completions");
  const [apiKey, setApiKey] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    rpc.call("provider_save", { id, name: name || undefined, baseUrl, api: api as ApiType, apiKey: apiKey || undefined })
      .then(() => { toast.success("Адрес сохранён"); onClose(); }, report);
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{editing ? "Настроить API" : "Добавить API"}</DialogTitle></DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <label className="flex flex-col gap-1 text-sm"><span className="text-muted-foreground">id (slug)</span>
            <Input value={id} onChange={(event) => setId(event.target.value)} disabled={!!editing} placeholder="my-router" required aria-label="id провайдера" /></label>
          <label className="flex flex-col gap-1 text-sm"><span className="text-muted-foreground">Имя (необязательно)</span>
            <Input value={name} onChange={(event) => setName(event.target.value)} aria-label="имя провайдера" /></label>
          <label className="flex flex-col gap-1 text-sm"><span className="text-muted-foreground">Адрес (baseUrl)</span>
            <Input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="http://host:port/v1" required aria-label="baseUrl" /></label>
          <label className="flex flex-col gap-1 text-sm"><span className="text-muted-foreground">Тип API</span>
            <select className="h-9 rounded-md border border-input bg-transparent px-3 text-sm" value={api} onChange={(event) => setApi(event.target.value)} aria-label="тип API">
              {API_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
            </select></label>
          <label className="flex flex-col gap-1 text-sm"><span className="text-muted-foreground">API-ключ {editing ? "(пусто = не менять)" : ""}</span>
            <Input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" aria-label="API-ключ" /></label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Отмена</Button>
            <Button type="submit"><Icon name="Check" className="size-3.5" />Сохранить</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Countdown до сброса окна: 3d2h / 5h12m / 40m. */
function countdown(resetAt?: string): string | null {
  if (!resetAt) return null;
  const ms = new Date(resetAt).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  return days > 0 ? `${days}d${hours % 24}h` : hours > 0 ? `${hours}h${minutes % 60}m` : `${minutes}m`;
}

/** Карточка аккаунта relay: бейджи + квоты барами с % и сбросом. */
function AccountCard({ account, onToggle, compact = false }: { account: RelayAccount; onToggle?: (enabled: boolean) => void; compact?: boolean }) {
  const success = successPercent(account.usage?.success_rate);
  const displayName = account.email ?? (account.label && account.label !== account.provider ? account.label : undefined) ?? account.auth_index;
  const controls = (
    <span className="flex shrink-0 items-center gap-2">
      {account.health_status && !(onToggle && account.auth_name && ["ok", "active", "disabled"].includes(account.health_status)) ? (
        <span className="rounded-full border border-border px-1.5 py-0 text-[10px] text-muted-foreground">{account.health_status}</span>
      ) : null}
      {onToggle && account.auth_name ? (
        <Switch checked={!account.disabled} onChange={onToggle} label={`${account.disabled ? "Включить" : "Выключить"} аккаунт ${displayName}`} />
      ) : null}
    </span>
  );
  const badges = (
    <>
      {account.plan_type ? <span className="rounded bg-amber-500/15 px-1.5 py-0 text-[10px] font-semibold uppercase text-amber-500">{account.plan_type}</span> : null}
      {account.provider ? <span className="flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0 text-[10px]"><Icon name="Bot" className="size-2.5" />{account.provider}</span> : null}
      {typeof account.usage?.request_total === "number" ? <span className="rounded bg-muted/60 px-1.5 py-0 text-[10px] text-muted-foreground">Cycle {account.usage.request_total}</span> : null}
      {typeof success === "number" ? (
        <span className="rounded bg-muted/60 px-1.5 py-0 text-[10px] text-muted-foreground">
          Success Rate <span className={success >= 95 ? "text-emerald-400" : success >= 80 ? "text-amber-400" : "text-red-400"}>{success.toFixed(1)}%</span>
        </span>
      ) : null}
      {account.restriction_summary ? <span className="flex items-center gap-1 rounded bg-red-500/10 px-1.5 py-0 text-[10px] text-red-400"><Icon name="AlertTriangle" className="size-2.5" />{account.restriction_summary}</span> : null}
    </>
  );
  if (compact) {
    return (
      <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border/60 bg-background/80 px-3 py-1.5 transition-opacity ${account.disabled ? "opacity-60" : ""}`}>
        <span className="min-w-0 truncate text-xs font-medium" title={account.auth_index}>{displayName}</span>
        <span className="flex flex-wrap items-center gap-1">{badges}</span>
        <span className="ml-auto">{controls}</span>
      </div>
    );
  }
  return (
    <article className={`rounded-xl border border-border/60 bg-background/80 p-3 shadow-sm transition-opacity ${account.disabled ? "opacity-60" : ""}`}>
      <header className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold tracking-tight" title={account.auth_index}>{displayName}</h3>
          {displayName !== account.auth_index ? <div className="truncate font-mono text-[10px] text-muted-foreground">{account.auth_index}</div> : null}
        </div>
        {controls}
      </header>
      <div className="mb-2 flex flex-wrap gap-1">{badges}</div>
      <div className="flex flex-col gap-2">
        {account.quotas.map((quota) => {
          const percent = typeof quota.percent === "number" ? Math.max(0, Math.min(100, quota.percent)) : null;
          const reset = countdown(quota.reset_at);
          const tone = percent === null ? "bg-muted" : percent > 20 ? "bg-emerald-400" : "bg-red-400";
          return (
            <div key={quota.quota_key}>
              <div className="mb-0.5 flex items-baseline justify-between gap-2">
                <span className="truncate text-xs text-muted-foreground" title={quota.quota_key}>{quotaLabel(quota)}</span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {reset ? <span className="text-[10px] text-muted-foreground">↺ {reset}</span> : null}
                  <span className={`text-sm font-semibold ${percent === null ? "text-muted-foreground" : percent > 20 ? "text-foreground" : "text-red-400"}`}>
                    {percent === null ? "—" : `${Math.round(percent)}%`}
                  </span>
                </span>
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-muted/60">
                <div className={`h-full rounded-full ${tone} transition-all`} style={{ width: `${percent ?? 0}%` }} />
              </div>
            </div>
          );
        })}
        {account.quotas.length === 0 ? <p className="text-xs text-muted-foreground">Квот нет</p> : null}
      </div>
    </article>
  );
}

function RelayCredsDialog({ providerId, rpc, report, onClose, onSaved }: { providerId: string; rpc: Rpc; report: Report; onClose: () => void; onSaved: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    rpc.call("relay_creds_set", { providerId, username, password })
      .then(() => { toast.success("Креды адреса сохранены"); onSaved(); onClose(); }, report);
  };
  const clear = () => {
    rpc.call("relay_creds_clear", { providerId })
      .then(() => { toast.success("Креды адреса удалены"); onSaved(); onClose(); }, report);
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Креды админки relay</DialogTitle></DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <p className="text-xs text-muted-foreground">Свои логин/пароль для этого адреса. Хранятся только на сервере плагина; плагин сам логинится и продлевает сессию.</p>
          <label className="flex flex-col gap-1 text-sm"><span className="text-muted-foreground">Логин</span>
            <Input value={username} onChange={(event) => setUsername(event.target.value)} required autoComplete="off" aria-label="логин админки relay" /></label>
          <label className="flex flex-col gap-1 text-sm"><span className="text-muted-foreground">Пароль</span>
            <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required autoComplete="off" aria-label="пароль админки relay" /></label>
          <DialogFooter>
            <Button type="button" variant="outline" className="text-destructive" onClick={clear}>Очистить</Button>
            <Button type="button" variant="outline" onClick={onClose}>Отмена</Button>
            <Button type="submit"><Icon name="Check" className="size-3.5" />Сохранить</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RelayAccountsGroup({ baseUrl, providerId, rpc, report }: { baseUrl: string; providerId: string; rpc: Rpc; report: Report }) {
  const [data, setData] = useState<{ configured: boolean; items: RelayAccount[]; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [credsOpen, setCredsOpen] = useState(false);
  const [providerFilter, setProviderFilter] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState<"all" | "on" | "off">("on");
  const load = useCallback(() => {
    setBusy(true);
    rpc.call("relay_accounts", { providerId }).then(
      (result) => { setData(result); setBusy(false); },
      (cause) => { setBusy(false); report(cause); },
    );
  }, [rpc, providerId, report]);
  useEffect(() => { load(); }, [load]);
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <Icon name="Folder" className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono text-xs text-muted-foreground">{baseUrl}</span>
        {data ? <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">{data.configured ? "креды заданы" : "креды не заданы"}</span> : null}
        <Button variant="ghost" size="sm" className="ml-auto shrink-0 text-muted-foreground" onClick={() => setCredsOpen(true)} aria-label="Креды адреса">
          <Icon name="Key" className="size-3.5" />Креды
        </Button>
        <Button variant="ghost" size="icon" className="size-7 shrink-0 text-muted-foreground" aria-label="Обновить квоты" onClick={load}>
          <Icon name={busy ? "Loading" : "Download"} className={`size-3.5 ${busy ? "animate-spin" : ""}`} />
        </Button>
      </div>
      {data === null ? (
        <div className="h-40 animate-pulse rounded-2xl bg-muted/40" />
      ) : !data.configured ? null : data.error ? (
        <div className="rounded-2xl bg-destructive/10 p-4 text-sm text-destructive" role="alert">{data.error}</div>
      ) : data.items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">Аккаунтов нет</div>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-1" role="group" aria-label="Фильтр по состоянию аккаунтов">
            {([["all", "Все"], ["on", "Вкл"], ["off", "Выкл"]] as const).map(([id, label]) => {
              const count = id === "all" ? data.items.length : id === "on" ? data.items.filter((a) => !a.disabled).length : data.items.filter((a) => a.disabled).length;
              return (
                <button key={id} type="button" onClick={() => setStateFilter(id)} aria-pressed={stateFilter === id}
                  className={`rounded-full px-2.5 py-1 text-[11px] transition ${stateFilter === id ? "bg-background font-medium shadow-sm" : "bg-muted/40 text-muted-foreground hover:text-foreground"}`}>
                  {label} {count}
                </button>
              );
            })}
          </div>
          <ProviderSections
            items={data.items.filter((a) => stateFilter === "all" || (stateFilter === "on" ? !a.disabled : a.disabled))}
            filter={providerFilter}
            onFilter={setProviderFilter}
            stateFilter={stateFilter}
            onToggle={(authIndex, enabled) => rpc.call("relay_account_toggle", { providerId, authIndex, enabled })
              .then(() => { toast.success(enabled ? `Аккаунт включён` : `Аккаунт выключен`); load(); }, report)}
          />
        </>
      )}
      {credsOpen ? <RelayCredsDialog providerId={providerId} rpc={rpc} report={report} onClose={() => setCredsOpen(false)} onSaved={load} /> : null}
    </section>
  );
}

/** Секции аккаунтов по провайдеру + фильтр-чипы. */
function ProviderSections({ items, filter, onFilter, stateFilter, onToggle }: { items: RelayAccount[]; filter: string | null; onFilter: (provider: string | null) => void; stateFilter: "all" | "on" | "off"; onToggle: (authIndex: string, enabled: boolean) => void }) {
  const groups = groupAccountsByProvider(items);
  const active = groups.some((group) => group.provider === filter) ? filter : null;
  const visible = active ? groups.filter((group) => group.provider === active) : groups;
  const { quotaGroups, quotaless } = partitionByQuota(visible);
  const withQuota = quotaGroups.flatMap((group) => group.accounts);
  const grouped = shouldGroupByProvider({ providerFilter: active, stateFilter, count: visible.length });
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1" role="group" aria-label="Фильтр по провайдеру">
        <button type="button" onClick={() => onFilter(null)} aria-pressed={active === null}
          className={`rounded-full px-2.5 py-1 text-[11px] transition ${active === null ? "bg-background font-medium shadow-sm" : "bg-muted/40 text-muted-foreground hover:text-foreground"}`}>
          Все {items.length}
        </button>
        {groups.map((group) => (
          <button key={group.provider} type="button" onClick={() => onFilter(group.provider)} aria-pressed={active === group.provider}
            className={`rounded-full px-2.5 py-1 text-[11px] transition ${active === group.provider ? "bg-background font-medium shadow-sm" : "bg-muted/40 text-muted-foreground hover:text-foreground"}`}>
            {group.provider} {group.accounts.length}
          </button>
        ))}
      </div>
      {withQuota.length > 0 ? (
        <QuotaAccordion title="С квотой" icon="Target" accounts={withQuota} groups={quotaGroups} grouped={grouped} onToggle={onToggle} />
      ) : null}
      {quotaless.length > 0 ? (
        <QuotaAccordion
          title="Без квот"
          icon="Archive"
          accounts={quotaless}
          groups={visible.filter((group) => !group.accounts.some((account) => account.quotas.length > 0))}
          grouped={grouped}
          compact
          defaultOpen={false}
          onToggle={onToggle}
        />
      ) : null}
      {visible.length === 0 ? <div className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">Ничего по фильтру</div> : null}
    </div>
  );
}

/** Верхний аккордеон «С квотой» / «Без квот»; внутри — провайдерские под-аккордеоны только когда нужно. */
function QuotaAccordion({ title, icon, accounts, groups, grouped, compact = false, defaultOpen = true, onToggle }: {
  title: string; icon: string; accounts: RelayAccount[]; groups: Array<{ provider: string; accounts: RelayAccount[] }>;
  grouped: boolean; compact?: boolean; defaultOpen?: boolean; onToggle: (authIndex: string, enabled: boolean) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-xl border border-border/60 bg-muted/20 p-3">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="flex w-full items-center gap-2 text-left" aria-label={`Свернуть или развернуть ${title}`}>
        <Icon name="ChevronDown" className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`} />
        <Icon name={icon} className="size-4 shrink-0 text-muted-foreground" />
        <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
        <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">{accounts.length}</span>
        <span className="h-px flex-1 bg-border/60" />
      </button>
      {open ? (
        <div className="mt-3">
          {grouped ? (
            <div className="flex flex-col gap-3">
              {groups.map((group) => <AccountProviderSection key={group.provider} group={group} onToggle={onToggle} compact={compact} />)}
            </div>
          ) : compact ? (
            <div className="flex flex-col gap-1.5">
              {accounts.map((account) => <AccountCard key={account.auth_index} account={account} compact onToggle={(enabled) => onToggle(account.auth_index, enabled)} />)}
            </div>
          ) : (
            <div className="grid items-start gap-3 md:grid-cols-2 xl:grid-cols-3">
              {accounts.map((account) => <AccountCard key={account.auth_index} account={account} onToggle={(enabled) => onToggle(account.auth_index, enabled)} />)}
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

/** Сворачиваемая секция провайдера. */
function AccountProviderSection({ group, onToggle, defaultOpen = true, icon = "Bot", compact = false }: { group: { provider: string; accounts: RelayAccount[] }; onToggle: (authIndex: string, enabled: boolean) => void; defaultOpen?: boolean; icon?: string; compact?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="mb-2 flex w-full items-center gap-2 text-left" aria-label={`Свернуть или развернуть ${group.provider}`}>
        <Icon name="ChevronDown" className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`} />
        <Icon name={icon} className="size-4 shrink-0 text-muted-foreground" />
        <h3 className="text-sm font-semibold capitalize tracking-tight">{group.provider}</h3>
        <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">{group.accounts.length}</span>
        <span className="h-px flex-1 bg-border/60" />
      </button>
      {open ? (
        compact ? (
          <div className="flex flex-col gap-1.5">
            {group.accounts.map((account) => <AccountCard key={account.auth_index} account={account} compact onToggle={(enabled) => onToggle(account.auth_index, enabled)} />)}
          </div>
        ) : (
          <div className="grid items-start gap-3 md:grid-cols-2 xl:grid-cols-3">
            {group.accounts.map((account) => <AccountCard key={account.auth_index} account={account} onToggle={(enabled) => onToggle(account.auth_index, enabled)} />)}
          </div>
        )
      ) : null}
    </section>
  );
}

function AccountsTab({ providers, rpc, report }: { providers: ProviderView[]; rpc: Rpc; report: Report }) {
  const groups = groupProvidersByBaseUrl(providers);
  if (groups.length === 0) {
    return <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">Нет адресов — добавь API во вкладке «Подключение».</div>;
  }
  return (
    <div className="flex flex-col gap-5">
      {groups.map((group) => (
        <RelayAccountsGroup key={group.baseUrl} baseUrl={group.baseUrl} providerId={group.providers[0]!.id} rpc={rpc} report={report} />
      ))}
    </div>
  );
}

function ApiModelsPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [providers, setProviders] = useState<ProviderView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ editing: ProviderView | null } | null>(null);
  const [tab, setTab] = useState<"accounts" | "connect">("accounts");
  const report = useCallback((cause: unknown) => { const text = message(cause); setError(text); toast.error(text); }, []);
  const refetch = useCallback(() => {
    rpc.call("providers_list").then(({ providers }) => { setProviders(providers as ProviderView[]); setError(null); }, report);
  }, [rpc, report]);
  useEffect(() => { refetch(); }, [refetch]);
  useRealtime("api-models-changed", refetch);
  return (
    <div className="h-full min-h-0 flex-1 overflow-auto">
      <div className="mx-auto w-full max-w-[1200px] px-4 pb-6 pt-4 md:px-6">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Api модели</h1>
            <p className="mt-1 text-sm text-muted-foreground">Квоты аккаунтов relay и подключение моделей pi (~/.pi/agent/models.json) в одном месте.</p>
          </div>
          {tab === "connect" ? <Button onClick={() => setDialog({ editing: null })}><Icon name="Plus" className="size-4" />Добавить API</Button> : null}
        </div>
        <div className="mb-4 flex w-fit gap-1 rounded-lg bg-muted/40 p-1" role="tablist" aria-label="Разделы панели">
          <button type="button" role="tab" aria-selected={tab === "accounts"} onClick={() => setTab("accounts")}
            className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition ${tab === "accounts" ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
            <Icon name="Bot" className="size-4" />Аккаунты
          </button>
          <button type="button" role="tab" aria-selected={tab === "connect"} onClick={() => setTab("connect")}
            className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition ${tab === "connect" ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
            <Icon name="Workflow" className="size-4" />Подключение
          </button>
        </div>
        {error ? <p className="mb-4 text-sm text-destructive" role="alert">{error}</p> : null}
        {providers === null ? <p className="text-sm text-muted-foreground">Загрузка…</p> : tab === "accounts" ? (
          <AccountsTab providers={providers} rpc={rpc} report={report} />
        ) : (
          <div className="flex flex-col gap-3">
            {groupProvidersByBaseUrl(providers).map((group) =>
              group.providers.length === 1 ? (
                <ProviderSection key={group.providers[0]!.id} provider={group.providers[0]!} rpc={rpc} report={report} onEdit={() => setDialog({ editing: group.providers[0]! })} />
              ) : (
                <AddressGroup key={group.baseUrl} baseUrl={group.baseUrl} providers={group.providers} rpc={rpc} report={report} onEdit={(provider) => setDialog({ editing: provider })} />
              ),
            )}
            {providers.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                Нет адресов. Нажми «Добавить API», укажи baseUrl и ключ — модели подтянутся сами.
              </div>
            ) : null}
          </div>
        )}
      </div>
      {dialog ? <ProviderDialog editing={dialog.editing} rpc={rpc} report={report} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "api-models", title: "Api модели", icon: "Workflow", path: "api-models", component: ApiModelsPage });
});
