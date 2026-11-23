import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { isAntigravityProvider } from "./antigravity-usage.ts";
import { contract, hostContract, preferencesSchema, usageResponseSchema, type Overview, type Usage } from "./contract.ts";
import { orderedProviders, type ProviderPreference } from "./limits.ts";

const ANTIGRAVITY_CACHE_TTL_MS = 60_000;
const externalResourceListSchema = z.object({ resources: z.array(z.object({
  id: z.string(), providerId: z.string(), label: z.string(),
  scope: z.object({ kind: z.enum(["shared", "host"]), hostId: z.string().optional() }),
})) });
const externalUsageSchema = z.object({
  usage: z.object({
    status: z.string(), accountEmail: z.string().nullable().optional(), planLabel: z.string().nullable().optional(),
    message: z.string().optional(),
    windows: z.array(z.object({ label: z.string(), usedPercent: z.number(), resetsAt: z.string().nullable().optional() })).optional(),
  }),
});

interface ExternalResourceEntry {
  providerId: string;
  id: string;
  label: string;
  displayName: string;
  usage: Usage | null;
}

function normalizeExternalUsage(raw: z.infer<typeof externalUsageSchema>["usage"]): Usage {
  if (raw.status === "ok") {
    return {
      status: "ok",
      accountEmail: raw.accountEmail ?? null,
      planLabel: raw.planLabel ?? null,
      windows: (raw.windows ?? []).map(window => ({
        label: window.label,
        usedPercent: window.usedPercent,
        resetsAt: window.resetsAt ?? null,
      })),
    };
  }
  if (raw.status === "not_installed" || raw.status === "unauthenticated" || raw.status === "expired") {
    return raw.message ? { status: raw.status, message: raw.message } : { status: raw.status };
  }
  return { status: "error", message: raw.message ?? "Не удалось получить лимиты." };
}

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("Aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => { signal.removeEventListener("abort", onAbort); resolve(value); },
      error => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

export default function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const antigravityCache = new Map<string, { fetchedAt: number; usage: Usage }>();
  const antigravityInflight = new Map<string, Promise<Usage>>();

  async function readAntigravity(hostId: string, force: boolean, signal?: AbortSignal): Promise<Usage> {
    const cached = antigravityCache.get(hostId);
    if (!force && cached && Date.now() - cached.fetchedAt < ANTIGRAVITY_CACHE_TTL_MS) return cached.usage;
    let pending = !force ? antigravityInflight.get(hostId) : undefined;
    if (!pending) {
      const request = host.call("readAntigravityUsage", {}, { hostId, timeoutMs: 30_000 })
        .then(usage => {
          if (usage.status !== "error") antigravityCache.set(hostId, { fetchedAt: Date.now(), usage });
          else antigravityCache.delete(hostId);
          return usage;
        })
        .catch((): Usage => {
          antigravityCache.delete(hostId);
          return { status: "error", message: "Не удалось получить лимиты Google Antigravity." };
        })
        .finally(() => {
          if (antigravityInflight.get(hostId) === request) antigravityInflight.delete(hostId);
        });
      antigravityInflight.set(hostId, request);
      pending = request;
    }
    return raceAbort(pending, signal);
  }

  async function readExternalUsage(
    hostId: string | null,
    providers: { id: string; displayName: string }[],
    saved: readonly ProviderPreference[],
    refresh = false,
    signal?: AbortSignal,
  ): Promise<ExternalResourceEntry[]> {
    const discover = bb.sdk.plugins.experimental_discoverRpc;
    if (typeof discover !== "function") return [];
    const [listDiscovered, getDiscovered] = await Promise.all([
      discover({ method: "provider-usage.v1.listResources", signal }),
      discover({ method: "provider-usage.v1.getResource", signal }),
    ]);
    const listMethods = listDiscovered.filter(method => method.method === "provider-usage.v1.listResources");
    const getByPlugin = new Map(
      getDiscovered
        .filter(method => method.method === "provider-usage.v1.getResource")
        .map(method => [method.pluginId, method]),
    );
    const disabledIds = new Set(saved.filter(pref => !pref.enabled).map(pref => pref.id));
    const entries = await Promise.all(listMethods.map(async method => {
      const getMethod = getByPlugin.get(method.pluginId);
      if (!getMethod) return [] as ExternalResourceEntry[];
      let listed: z.infer<typeof externalResourceListSchema>;
      try {
        listed = externalResourceListSchema.parse(await bb.sdk.plugins.callRpc({
          pluginId: method.pluginId, method: method.method, input: {}, outputSchema: externalResourceListSchema, signal,
        }));
      } catch {
        return [] as ExternalResourceEntry[];
      }
      const matching = listed.resources.filter(resource => resource.scope.kind !== "host" || resource.scope.hostId === hostId);
      return Promise.all(matching.map(async (resource): Promise<ExternalResourceEntry | null> => {
        const displayName = providers.find(provider => provider.id === resource.providerId)?.displayName ?? resource.label;
        if (disabledIds.has(resource.providerId)) {
          return { providerId: resource.providerId, id: resource.id, label: resource.label, displayName, usage: null };
        }
        try {
          const data = externalUsageSchema.parse(await bb.sdk.plugins.callRpc({
            pluginId: getMethod.pluginId, method: getMethod.method,
            input: { resourceId: resource.id, refresh }, outputSchema: externalUsageSchema, signal,
          }));
          return { providerId: resource.providerId, id: resource.id, label: resource.label, displayName, usage: normalizeExternalUsage(data.usage) };
        } catch {
          /* One external provider must not hide native limits. */
          return null;
        }
      }));
    }));
    return entries.flat().filter((entry): entry is ExternalResourceEntry => entry !== null);
  }

  async function resetTarget(input: { hostId: string | null; accountId: string }, signal?: AbortSignal) {
    const hostId = input.hostId ?? (await bb.sdk.system.config()).primaryHostId;
    if (!hostId) throw new Error("Выберите компьютер с установленным Codex CLI.");
    const data = await read(hostId, false, signal);
    if (data.error) throw new Error(data.error);
    const account = data.providers.find(p => p.id === "codex")?.accounts.find(a => a.id === input.accountId);
    const email = account?.usage?.status === "ok" ? account.usage.accountEmail : null;
    if (!email) throw new Error("Аккаунт Codex не определён. Обновите лимиты и проверьте вход.");
    return { hostId, email };
  }
  async function preferences() {
    return preferencesSchema.parse(await bb.storage.kv.get("providers") ?? []);
  }
  async function read(hostId: string | null, force = false, signal?: AbortSignal): Promise<Overview> {
    const selectedHost = hostId ?? (await bb.sdk.system.config()).primaryHostId;
    const [saved, usageRoster, allProviders] = await Promise.all([
      preferences(),
      bb.sdk.providers.list(selectedHost ? { capability: "usage", hostId: selectedHost } : { capability: "usage" }),
      bb.sdk.providers.list(selectedHost ? { hostId: selectedHost } : {}),
    ]);
    const nativeUsageIds = new Set(usageRoster.map(provider => provider.id));
    const antigravityProviders = allProviders.filter(provider => !nativeUsageIds.has(provider.id) && isAntigravityProvider(provider));
    const antigravityIds = new Set(antigravityProviders.map(provider => provider.id));
    const input = { force: false, machineIds: selectedHost ? [selectedHost] : null, providerIds: [] as string[], maxAgeMs: 60_000 };
    const getUsage = (args: typeof input) => bb.sdk.plugins.callRpc({
      pluginId: "bb--provider-usage", method: "getUsage", input: args, outputSchema: usageResponseSchema, signal,
    });
    let machine: Awaited<ReturnType<typeof getUsage>>["machines"][number] | undefined;
    let antigravityUsage: Usage | null = null;
    let error: string | null = null;
    try {
      const inventory = await getUsage(input);
      machine = selectedHost ? inventory.machines.find(m => m.id === selectedHost) : inventory.machines.find(m => m.status === "connected");
      const enabledNative = usageRoster.filter(provider => saved.find(p => p.id === provider.id)?.enabled
        ?? machine?.providers.some(p => p.providerId === provider.id && p.usage?.status !== "not_installed") ?? false);
      const enabledAntigravity = antigravityProviders.filter(provider => saved.find(p => p.id === provider.id)?.enabled ?? true);
      if (machine?.status === "connected") {
        const machineId = machine.id;
        const [loaded, loadedAntigravity] = await Promise.all([
          enabledNative.length ? getUsage({ ...input, machineIds: [machineId], providerIds: enabledNative.map(p => p.id), force }) : Promise.resolve(null),
          enabledAntigravity.length ? readAntigravity(machineId, force, signal) : Promise.resolve(null),
        ]);
        if (loaded) machine = loaded.machines.find(m => m.id === machineId);
        antigravityUsage = loadedAntigravity;
      }
      error = !machine ? "Компьютер с данными лимитов не найден."
        : machine.status !== "connected" ? "Компьютер отключён. Данные не обновлены."
        : machine.error ? "Не удалось обновить лимиты. Данные могут быть устаревшими." : null;
    } catch {
      error = "Не удалось прочитать лимиты. Проверьте, включён ли встроенный Provider Usage.";
    }
    let external: ExternalResourceEntry[] = [];
    try { external = await readExternalUsage(selectedHost, allProviders, saved, force, signal); } catch { /* Native provider limits remain available. */ }
    const seenRosterIds = new Set([...nativeUsageIds, ...antigravityIds]);
    const externalProviders = [] as { id: string; displayName: string; logoUrl?: string | null; icon?: Overview["providers"][number]["icon"]; strings?: Overview["providers"][number]["strings"] }[];
    for (const resource of external) {
      if (seenRosterIds.has(resource.providerId)) continue;
      seenRosterIds.add(resource.providerId);
      externalProviders.push(allProviders.find(provider => provider.id === resource.providerId) ?? {
        id: resource.providerId, displayName: resource.displayName, logoUrl: null, icon: null, strings: null,
      });
    }
    const roster = [...usageRoster, ...antigravityProviders, ...externalProviders];
    const providers = roster.map(provider => {
      const isCustomAntigravity = antigravityIds.has(provider.id);
      const accounts = isCustomAntigravity
        ? (antigravityUsage ? [{ id: `${provider.id}-account`, accountLabel: null, usage: antigravityUsage }] : [])
        : [
          ...(machine?.providers.filter(p => p.providerId === provider.id) ?? []),
          ...external
            .filter(resource => resource.providerId === provider.id && resource.usage !== null)
            .map(resource => ({ id: resource.id, accountLabel: resource.label, usage: resource.usage! })),
        ];
      return {
        id: provider.id, displayName: provider.displayName, logoUrl: provider.logoUrl ?? null, icon: provider.icon ?? null,
        strings: { iconTint: provider.strings?.iconTint ?? null }, accounts,
        enabled: saved.find(p => p.id === provider.id)?.enabled ?? accounts.some(p => p.usage?.status !== "not_installed"),
      };
    });
    return { providers: orderedProviders(providers, saved), preferences: saved, machineName: machine?.displayName ?? null, error };
  }
  bb.rpc.register(contract, {
    async resets(input, context) {
      const target = await resetTarget(input, context.experimental_signal);
      return host.call("readResets", { expectedEmail: target.email }, { hostId: target.hostId, signal: context.experimental_signal, timeoutMs: 60_000 });
    },
    async consumeReset(input, context) {
      const target = await resetTarget(input, context.experimental_signal);
      try {
        return await host.call("consumeReset", {
          expectedEmail: target.email, expectedAccountId: input.expectedAccountId,
          creditId: input.creditId, idempotencyKey: input.idempotencyKey, confirmed: input.confirmed,
        }, { hostId: target.hostId, signal: context.experimental_signal, timeoutMs: 60_000 });
      } finally { bb.rpc.experimental_invalidate(["usage-rings"]); }
    },
    overview: ({ hostId }, context) => read(hostId, false, context.experimental_signal),
    async savePreferences(rows) {
      await bb.storage.kv.set("providers", rows);
      bb.rpc.experimental_invalidate(["usage-rings"]);
      return rows;
    },
    async refresh({ hostId }, context) {
      const result = await read(hostId, true, context.experimental_signal);
      bb.rpc.experimental_invalidate(["usage-rings"]);
      if (result.error) throw new Error(result.error);
      return null;
    },
  });
  for (const event of ["thread.idle", "thread.failed"] as const) {
    bb.events.on(event, () => {
      antigravityCache.clear();
      bb.rpc.experimental_invalidate(["usage-rings"]);
    });
  }
}
