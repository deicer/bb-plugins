import { z } from "zod";
import { DiscoverError } from "./discover";

// Management API clirelay (codeProxy): GET {origin}/v0/management/ai-accounts/status.
const quotaSchema = z.object({
  quota_key: z.string(),
  quota_label: z.string().optional(),
  percent: z.number().nullable().optional(),
  reset_at: z.string().optional(),
  window_seconds: z.number().optional(),
  used_cost_usd: z.number().optional(),
});

export const relayAccountSchema = z.object({
  auth_index: z.string(),
  provider: z.string().optional(),
  plan_type: z.string().nullable().optional(),
  restriction_summary: z.string().nullable().optional(),
  health_status: z.string().optional(),
  disabled: z.boolean().default(false),
  auth_name: z.string().optional(),
  email: z.string().optional(),
  label: z.string().optional(),
  quotas: z.array(quotaSchema).default([]),
  usage: z
    .object({
      success_rate: z.number().optional(),
      request_total: z.number().optional(),
      cost_total: z.number().optional(),
    })
    .nullable()
    .optional(),
});
export type RelayAccount = z.infer<typeof relayAccountSchema>;

const snapshotSchema = z.object({ items: z.array(relayAccountSchema).default([]) });

// ponytail: origin = baseUrl без хвостового /v1; апгрейд — явная настройка origin.
export function relayOrigin(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

// Состояния аккаунтов: GET /auth-files → auth_index → {name, disabled}.
export async function fetchAuthFileStates(
  baseUrl: string,
  managementKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, { name: string; disabled: boolean; email?: string; label?: string }>> {
  const url = `${relayOrigin(baseUrl)}/v0/management/auth-files`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${managementKey}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (cause) {
    if (cause instanceof Error && cause.name === "AbortError") throw new DiscoverError("таймаут 10с: relay не ответил");
    throw new DiscoverError("не удалось соединиться с relay");
  }
  if (response.status === 401 || response.status === 403) throw new DiscoverError("management-доступ отклонён: проверь логин и пароль");
  if (!response.ok) throw new DiscoverError(`relay ответил HTTP ${response.status}`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new DiscoverError("relay вернул не JSON");
  }
  const files = (body as { files?: unknown })?.files;
  const states = new Map<string, { name: string; disabled: boolean; email?: string; label?: string }>();
  if (Array.isArray(files)) {
    for (const file of files) {
      if (!file || typeof file !== "object") continue;
      const record = file as Record<string, unknown>;
      const index = record.auth_index ?? record.authIndex;
      const name = record.name;
      if ((typeof index !== "string" && typeof index !== "number") || typeof name !== "string" || !name) continue;
      states.set(String(index), {
        name,
        disabled: record.disabled === true,
        email: typeof record.email === "string" && record.email ? record.email : undefined,
        label: typeof record.label === "string" && record.label ? record.label : undefined,
      });
    }
  }
  return states;
}

// Вкл/выкл аккаунта: PATCH /auth-files/status {name, disabled}.
export async function setAuthFileDisabled(
  baseUrl: string,
  managementKey: string,
  name: string,
  disabled: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const url = `${relayOrigin(baseUrl)}/v0/management/auth-files/status`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${managementKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name, disabled }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (cause) {
    if (cause instanceof Error && cause.name === "AbortError") throw new DiscoverError("таймаут 10с: relay не ответил");
    throw new DiscoverError("не удалось соединиться с relay");
  }
  if (response.status === 401 || response.status === 403) throw new DiscoverError("management-доступ отклонён: проверь логин и пароль");
  if (!response.ok) throw new DiscoverError(`relay ответил HTTP ${response.status}`);
  const body = (await response.json().catch(() => null)) as { disabled?: unknown } | null;
  return body?.disabled === true ? true : disabled;
}

// Секции аккаунтов по провайдеру: сначала с квотой, внутри — включённые
// перед выключенными; секции без квот в конце, «Другие» последние.
export function groupAccountsByProvider(accounts: RelayAccount[]): Array<{ provider: string; accounts: RelayAccount[] }> {
  const byProvider = new Map<string, { provider: string; accounts: RelayAccount[] }>();
  for (const account of accounts) {
    const provider = account.provider?.trim() || "Другие";
    let group = byProvider.get(provider);
    if (!group) {
      group = { provider, accounts: [] };
      byProvider.set(provider, group);
    }
    group.accounts.push(account);
  }
  const rank = (account: RelayAccount) => (account.quotas.length > 0 ? 0 : 1) * 2 + (account.disabled ? 1 : 0);
  for (const group of byProvider.values()) {
    group.accounts.sort((a, b) => rank(a) - rank(b) || a.auth_index.localeCompare(b.auth_index));
  }
  return [...byProvider.values()].sort((a, b) => {
    const tier = (g: { accounts: RelayAccount[] }) => (g.accounts.some((x) => x.quotas.length > 0) ? 0 : 1);
    if (tier(a) !== tier(b)) return tier(a) - tier(b);
    if (a.provider === "Другие") return 1;
    if (b.provider === "Другие") return -1;
    return a.provider.localeCompare(b.provider);
  });
}

// Под-аккордеоны провайдеров нужны только когда фильтры «Все»+«Все»,
// либо аккаунтов много (>20) — иначе плоский список компактнее.
export const PROVIDER_GROUP_THRESHOLD = 20;

export function shouldGroupByProvider(opts: { providerFilter: string | null; stateFilter: "all" | "on" | "off"; count: number }): boolean {
  return (opts.providerFilter === null && opts.stateFilter === "all") || opts.count > PROVIDER_GROUP_THRESHOLD;
}

// Секции с квотой отдельно; аккаунты без квот — одним списком под общий аккордеон.
export function partitionByQuota(groups: Array<{ provider: string; accounts: RelayAccount[] }>): {
  quotaGroups: Array<{ provider: string; accounts: RelayAccount[] }>;
  quotaless: RelayAccount[];
} {
  const hasQuota = (group: { accounts: RelayAccount[] }) => group.accounts.some((account) => account.quotas.length > 0);
  return {
    quotaGroups: groups.filter(hasQuota),
    quotaless: groups.filter((group) => !hasQuota(group)).flatMap((group) => group.accounts),
  };
}

// relay отдаёт success_rate долей 0..1; старые сборки могли слать проценты.
export function successPercent(rate: number | undefined): number | undefined {
  if (typeof rate !== "number" || !Number.isFinite(rate)) return undefined;
  return rate <= 1 ? rate * 100 : rate;
}

export async function fetchRelayAccounts(
  baseUrl: string,
  managementKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RelayAccount[]> {
  const url = `${relayOrigin(baseUrl)}/v0/management/ai-accounts/status`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${managementKey}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (cause) {
    if (cause instanceof Error && cause.name === "AbortError") throw new DiscoverError("таймаут 10с: relay не ответил");
    throw new DiscoverError("не удалось соединиться с relay");
  }
  if (response.status === 401 || response.status === 403) throw new DiscoverError("management-доступ отклонён: проверь логин и пароль");
  if (!response.ok) throw new DiscoverError(`relay ответил HTTP ${response.status}`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new DiscoverError("relay вернул не JSON");
  }
  const parsed = snapshotSchema.safeParse(body);
  if (!parsed.success) throw new DiscoverError("неожиданный формат ai-accounts status");
  return parsed.data.items;
}
