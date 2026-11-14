import { describe, expect, it, vi } from "vitest";
import { DiscoverError } from "./discover";
import { fetchAuthFileStates, fetchRelayAccounts, groupAccountsByProvider, partitionByQuota, relayOrigin, setAuthFileDisabled, shouldGroupByProvider, successPercent } from "./relay-accounts";

const SNAPSHOT = {
  items: [
    {
      auth_index: "claude:user@example.com",
      provider: "claude",
      plan_type: "pro",
      restriction_summary: "restricted",
      quotas: [
        { quota_key: "5h", quota_label: "5-hour limit", percent: 100, reset_at: "2026-11-14T05:00:00Z", window_seconds: 18000 },
        { quota_key: "7d-fable", quota_label: "7-day Fable", percent: 13, reset_at: "2026-11-17T00:00:00Z" },
      ],
      usage: { success_rate: 98.9, request_total: 900, cost_total: 26.3 },
    },
  ],
};

const ok = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 });

describe("relayOrigin", () => {
  it("срезает /v1 и хвостовые слэши", () => {
    expect(relayOrigin("http://localhost:4010/v1/")).toBe("http://localhost:4010");
    expect(relayOrigin("http://localhost:4010")).toBe("http://localhost:4010");
  });
});

describe("shouldGroupByProvider", () => {
  it("под-аккордеоны только при фильтрах Все+Все или >20 аккаунтов", () => {
    expect(shouldGroupByProvider({ providerFilter: null, stateFilter: "all", count: 5 })).toBe(true);
    expect(shouldGroupByProvider({ providerFilter: "claude", stateFilter: "all", count: 5 })).toBe(false);
    expect(shouldGroupByProvider({ providerFilter: null, stateFilter: "on", count: 5 })).toBe(false);
    expect(shouldGroupByProvider({ providerFilter: "claude", stateFilter: "on", count: 21 })).toBe(true);
    expect(shouldGroupByProvider({ providerFilter: null, stateFilter: "on", count: 20 })).toBe(false);
  });
});

describe("partitionByQuota", () => {
  it("секции с квотой отдельно, без квот — одним списком", () => {
    const groups = groupAccountsByProvider([
      { auth_index: "q1", provider: "claude", quotas: [{ quota_key: "k" }], disabled: false },
      { auth_index: "n1", provider: "gemini", quotas: [], disabled: false },
      { auth_index: "n2", provider: "openrouter", quotas: [], disabled: false },
      { auth_index: "q2", provider: "claude", quotas: [{ quota_key: "k" }], disabled: false },
    ]);
    const { quotaGroups, quotaless } = partitionByQuota(groups);
    expect(quotaGroups.map((g) => g.provider)).toEqual(["claude"]);
    expect(quotaless.map((a) => a.auth_index)).toEqual(["n1", "n2"]);
  });
  it("все без квот → пустые секции, весь список в quotaless", () => {
    const { quotaGroups, quotaless } = partitionByQuota(groupAccountsByProvider([{ auth_index: "n1", quotas: [], disabled: false }]));
    expect(quotaGroups).toEqual([]);
    expect(quotaless).toHaveLength(1);
  });
});

describe("fetchAuthFileStates", () => {
  it("мапит auth_index → name/disabled", async () => {
    const fetchImpl = vi.fn(ok({ files: [{ name: "f1.json", auth_index: "idx1", disabled: true, email: "u@example.com", label: "my-label" }, { name: "f2.json", auth_index: "idx2" }, { name: "no-index.json" }] }));
    const states = await fetchAuthFileStates("http://localhost:4010/v1", "test-mgmt", fetchImpl);
    expect(states.get("idx1")).toEqual({ name: "f1.json", disabled: true, email: "u@example.com", label: "my-label" });
    expect(states.get("idx2")).toEqual({ name: "f2.json", disabled: false, email: undefined, label: undefined });
    expect(states.size).toBe(2);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:4010/v0/management/auth-files");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-mgmt");
  });
});

describe("setAuthFileDisabled", () => {
  it("PATCH status с name/disabled", async () => {
    const fetchImpl = vi.fn(ok({ status: "ok", disabled: true }));
    expect(await setAuthFileDisabled("http://localhost:4010/v1", "test-mgmt", "f1.json", true, fetchImpl)).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:4010/v0/management/auth-files/status");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ name: "f1.json", disabled: true });
  });
  it("401 → ошибка про логин/пароль", async () => {
    const fail = async () => new Response("{}", { status: 401 });
    await expect(setAuthFileDisabled("http://localhost:4010/v1", "bad", "f1.json", true, fail)).rejects.toThrow(/логин и пароль/);
  });
});

describe("groupAccountsByProvider", () => {
  it("секции по провайдеру, алфавит, «Другие» последние", () => {
    const groups = groupAccountsByProvider([
      { auth_index: "a1", provider: "xai", quotas: [], disabled: false },
      { auth_index: "a2", provider: "claude", quotas: [], disabled: false },
      { auth_index: "a3", provider: "xai", quotas: [], disabled: false },
      { auth_index: "a4", quotas: [], disabled: false },
    ]);
    expect(groups.map((g) => g.provider)).toEqual(["claude", "xai", "Другие"]);
    expect(groups[1]!.accounts.map((a) => a.auth_index)).toEqual(["a1", "a3"]);
  });
  it("секции и аккаунты с квотой — первыми, выключенные после включённых", () => {
    const groups = groupAccountsByProvider([
      { auth_index: "noq", provider: "aaa", quotas: [], disabled: false },
      { auth_index: "q-dis", provider: "bbb", quotas: [{ quota_key: "k" }], disabled: true },
      { auth_index: "q-on", provider: "bbb", quotas: [{ quota_key: "k" }], disabled: false },
      { auth_index: "q2", provider: "ccc", quotas: [{ quota_key: "k" }], disabled: false },
    ]);
    expect(groups.map((g) => g.provider)).toEqual(["bbb", "ccc", "aaa"]);
    expect(groups[0]!.accounts.map((a) => a.auth_index)).toEqual(["q-on", "q-dis"]);
  });
  it("пустой список → пусто", () => {
    expect(groupAccountsByProvider([])).toEqual([]);
  });
});

describe("successPercent", () => {
  it("доля 0..1 → проценты, уже проценты не трогаем", () => {
    expect(successPercent(0.989)).toBeCloseTo(98.9);
    expect(successPercent(1)).toBe(100);
    expect(successPercent(0)).toBe(0);
    expect(successPercent(98.9)).toBe(98.9);
    expect(successPercent(undefined)).toBeUndefined();
  });
});

describe("fetchRelayAccounts", () => {
  it("ходит с Bearer managementKey и парсит квоты", async () => {
    const fetchImpl = vi.fn(ok(SNAPSHOT));
    const items = await fetchRelayAccounts("http://localhost:4010/v1", "test-mgmt", fetchImpl);
    expect(items).toHaveLength(1);
    expect(items[0]!.auth_index).toBe("claude:user@example.com");
    expect(items[0]!.quotas[1]!.percent).toBe(13);
    expect(items[0]!.usage?.success_rate).toBe(98.9);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:4010/v0/management/ai-accounts/status");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-mgmt");
  });
  it("401/403 → понятная ошибка без URL", async () => {
    for (const status of [401, 403]) {
      const fail = async () => new Response(JSON.stringify({ error: "invalid management key" }), { status });
      const error = await fetchRelayAccounts("http://localhost:4010/v1", "bad", fail).then(
        () => { throw new Error("ожидалась ошибка"); },
        (cause: Error) => cause,
      );
      expect(error).toBeInstanceOf(DiscoverError);
      expect(error.message).toContain("логин и пароль");
      expect(error.message).not.toContain("localhost");
    }
  });
  it("пустой snapshot и битая форма", async () => {
    expect(await fetchRelayAccounts("http://localhost:4010/v1", "test-mgmt", ok({}))).toEqual([]);
    await expect(fetchRelayAccounts("http://localhost:4010/v1", "test-mgmt", ok({ items: "nope" }))).rejects.toThrow(/формат/);
    const html = async () => new Response("<html>", { status: 200 });
    await expect(fetchRelayAccounts("http://localhost:4010/v1", "test-mgmt", html)).rejects.toThrow(/не JSON/);
  });
});
