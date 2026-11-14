import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./server.js";

type Host = ReturnType<typeof createFakePluginHost>;
const hosts: Host[] = [];

async function load(content?: string) {
  const dir = await mkdtemp(join(tmpdir(), "api-models-rpc-"));
  const path = join(dir, "models.json");
  if (content !== undefined) await writeFile(path, content);
  process.env.PI_MODELS_PATH = path;
  const host = createFakePluginHost({ pluginId: "clirelay-test" });
  await plugin(host.bb);
  hosts.push(host);
  return { host, path };
}

afterEach(async () => {
  delete process.env.PI_MODELS_PATH;
  vi.unstubAllGlobals();
  await Promise.all(hosts.splice(0).map((host) => host.harness.lifecycle.dispose()));
});

describe("RPC", () => {
  it("пустой файл → пустой список", async () => {
    const { host } = await load();
    expect(await host.harness.behavior.callRpc("providers_list", null)).toEqual({ providers: [] });
  });
  it("provider_save → apiKeySet, ключ не утекает; model_connect/update/disconnect", async () => {
    const { host, path } = await load();
    const saved = await host.harness.behavior.callRpc("provider_save", {
      id: "router-test", name: "Test", baseUrl: "http://localhost:4010/v1", api: "openai-completions", apiKey: "test-key",
    }) as Record<string, unknown>;
    expect(saved.apiKeySet).toBe(true);
    expect(JSON.stringify(saved)).not.toContain("test-key");
    expect(await host.harness.behavior.callRpc("model_connect", { providerId: "router-test", modelId: "m1" })).toEqual({ connected: true });
    expect(await host.harness.behavior.callRpc("model_connect", { providerId: "router-test", modelId: "m1" })).toEqual({ connected: false });
    await host.harness.behavior.callRpc("model_update", { providerId: "router-test", modelId: "m1", patch: { reasoning: true, contextWindow: 400000 } });
    const { providers } = await host.harness.behavior.callRpc("providers_list", null) as { providers: Array<{ models: Array<Record<string, unknown>> }> };
    expect(providers[0]!.models[0]).toMatchObject({ id: "m1", reasoning: true, contextWindow: 400000 });
    expect(JSON.parse(await readFile(path, "utf8")).providers["router-test"].apiKey).toBe("test-key");
    expect(await host.harness.behavior.callRpc("model_disconnect", { providerId: "router-test", modelId: "m1" })).toEqual({ removed: true });
    expect(await host.harness.behavior.callRpc("provider_delete", { id: "router-test" })).toEqual({ removed: true });
  });
  it("пустой apiKey при правке сохраняет прежний", async () => {
    const { host, path } = await load();
    await host.harness.behavior.callRpc("provider_save", { id: "p", baseUrl: "http://localhost:4010/v1", api: "openai-completions", apiKey: "test-key" });
    await host.harness.behavior.callRpc("provider_save", { id: "p", baseUrl: "http://localhost:4011/v1", api: "openai-completions" });
    expect(JSON.parse(await readFile(path, "utf8")).providers.p.apiKey).toBe("test-key");
  });
  it("битый файл не перезаписывается", async () => {
    const { host, path } = await load("{oops");
    await expect(host.harness.behavior.callRpc("providers_list", null)).rejects.toThrow(/повреждён/);
    await expect(host.harness.behavior.callRpc("provider_save", { id: "p", baseUrl: "http://localhost:4010/v1", api: "openai-completions" })).rejects.toThrow(/повреждён/);
    expect(await readFile(path, "utf8")).toBe("{oops");
  });
  it("невалидный вход отклоняется zod", async () => {
    const { host } = await load();
    await expect(host.harness.behavior.callRpc("provider_save", { id: "Bad Id", baseUrl: "http://localhost:4010/v1", api: "openai-completions" })).rejects.toThrow();
    await expect(host.harness.behavior.callRpc("model_update", { providerId: "p", modelId: "m", patch: { reasoning: "yes" } })).rejects.toThrow();
  });
  it("путь берётся из настройки плагина, когда env не задан", async () => {
    const dir = await mkdtemp(join(tmpdir(), "api-models-cfg-"));
    const path = join(dir, "models.json");
    await writeFile(path, JSON.stringify({ providers: { cfg: { baseUrl: "http://localhost:4010/v1", api: "openai-completions", models: [] } } }));
    delete process.env.PI_MODELS_PATH;
    const host = createFakePluginHost({ pluginId: "clirelay-test", settings: { modelsPath: path } });
    await plugin(host.bb);
    hosts.push(host);
    const { providers } = await host.harness.behavior.callRpc("providers_list", null) as { providers: Array<{ id: string }> };
    expect(providers.map((p) => p.id)).toEqual(["cfg"]);
  });
  it("model_test: ok через chat/completions; неподдерживаемый api → отказ", async () => {
    const { host } = await load();
    await host.harness.behavior.callRpc("provider_save", { id: "p", baseUrl: "http://localhost:4010/v1", api: "openai-completions", apiKey: "test-key" });
    await host.harness.behavior.callRpc("model_connect", { providerId: "p", modelId: "m1" });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await host.harness.behavior.callRpc("model_test", { providerId: "p", modelId: "m1" }) as { ok: boolean; detail: string };
    expect(result.ok).toBe(true);
    expect(result.detail).toBe("OK");
    await host.harness.behavior.callRpc("provider_save", { id: "p", baseUrl: "http://localhost:4010/v1", api: "anthropic-messages" });
    const refused = await host.harness.behavior.callRpc("model_test", { providerId: "p", modelId: "m1" }) as { ok: boolean; detail: string };
    expect(refused.ok).toBe(false);
    expect(refused.detail).toContain("openai-completions");
  });
  it("relay_accounts: без кредов configured:false, с кредами — login + Bearer и квоты без утечки", async () => {
    const { host } = await load();
    await host.harness.behavior.callRpc("provider_save", { id: "p", baseUrl: "http://localhost:4010/v1", api: "openai-completions", apiKey: "test-key" });
    const empty = await host.harness.behavior.callRpc("relay_accounts", { providerId: "p" }) as { configured: boolean; items: unknown[] };
    expect(empty.configured).toBe(false);
    expect(empty.items).toEqual([]);
    const host2 = createFakePluginHost({ pluginId: "clirelay-test", settings: { managementUser: "admin", managementPassword: "test-pass" } });
    await plugin(host2.bb);
    hosts.push(host2);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "test-access", refresh_token: "test-refresh", expires_at: new Date(Date.now() + 3600_000).toISOString() }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ auth_index: "claude:u@example.com", quotas: [{ quota_key: "5h", percent: 100 }] }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await host2.harness.behavior.callRpc("relay_accounts", { providerId: "p" }) as { configured: boolean; items: Array<{ auth_index: string }> };
    expect(result.configured).toBe(true);
    expect(result.items[0]!.auth_index).toBe("claude:u@example.com");
    expect(JSON.stringify(result)).not.toContain("test-pass");
    expect(JSON.stringify(result)).not.toContain("test-access");
    const [loginUrl, loginInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(loginUrl).toBe("http://localhost:4010/v0/auth/login");
    expect(JSON.parse(String(loginInit.body))).toMatchObject({ username: "admin", password: "test-pass" });
    const [accountsUrl, accountsInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(accountsUrl).toBe("http://localhost:4010/v0/management/ai-accounts/status");
    expect((accountsInit.headers as Record<string, string>).Authorization).toBe("Bearer test-access");
  });
  it("model_toggle выкл/вкл сохраняет настройки; update/disconnect работают с выключенными", async () => {
    const { host, path } = await load();
    await host.harness.behavior.callRpc("provider_save", { id: "p", baseUrl: "http://localhost:4010/v1", api: "openai-completions" });
    await host.harness.behavior.callRpc("model_connect", { providerId: "p", modelId: "m1" });
    await host.harness.behavior.callRpc("model_update", { providerId: "p", modelId: "m1", patch: { reasoning: true, contextWindow: 400000 } });
    expect(await host.harness.behavior.callRpc("model_toggle", { providerId: "p", modelId: "m1", enabled: false })).toEqual({ enabled: false });
    let view = (await host.harness.behavior.callRpc("providers_list", null) as { providers: Array<{ models: Array<Record<string, unknown>>; disabled: Array<Record<string, unknown>> }> }).providers[0]!;
    expect(view.models).toEqual([]);
    expect(view.disabled[0]).toMatchObject({ id: "m1", reasoning: true, contextWindow: 400000 });
    expect(JSON.parse(await readFile(path, "utf8")).providers.p.models).toEqual([]);
    await host.harness.behavior.callRpc("model_update", { providerId: "p", modelId: "m1", patch: { maxTokens: 999 } });
    expect(await host.harness.behavior.callRpc("model_toggle", { providerId: "p", modelId: "m1", enabled: true })).toEqual({ enabled: true });
    view = (await host.harness.behavior.callRpc("providers_list", null) as { providers: Array<{ models: Array<Record<string, unknown>>; disabled: Array<Record<string, unknown>> }> }).providers[0]!;
    expect(view.disabled).toEqual([]);
    expect(view.models[0]).toMatchObject({ id: "m1", reasoning: true, contextWindow: 400000, maxTokens: 999 });
    await host.harness.behavior.callRpc("model_toggle", { providerId: "p", modelId: "m1", enabled: false });
    expect(await host.harness.behavior.callRpc("model_disconnect", { providerId: "p", modelId: "m1" })).toEqual({ removed: true });
    view = (await host.harness.behavior.callRpc("providers_list", null) as { providers: Array<{ models: Array<Record<string, unknown>>; disabled: Array<Record<string, unknown>> }> }).providers[0]!;
    expect(view.disabled).toEqual([]);
  });
  it("relay_accounts: label fallback когда email нет", async () => {
    const { host } = await load();
    await host.harness.behavior.callRpc("provider_save", { id: "p", baseUrl: "http://localhost:4010/v1", api: "openai-completions" });
    await host.harness.behavior.callRpc("relay_creds_set", { providerId: "p", username: "u", password: "p" });
    const session = { access_token: "test-access", expires_at: new Date(Date.now() + 3600_000).toISOString() };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(session), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ auth_index: "k1", provider: "kimi", quotas: [] }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [{ name: "kimi-1.json", auth_index: "k1", label: "kimi" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const view = await host.harness.behavior.callRpc("relay_accounts", { providerId: "p" }) as { items: Array<{ label?: string; email?: string }> };
    expect(view.items[0]!.label).toBe("kimi");
    expect(view.items[0]!.email).toBeUndefined();
  });
  it("relay_accounts: health_status disabled без auth-files записи → disabled:true без тумблера", async () => {
    const { host } = await load();
    await host.harness.behavior.callRpc("provider_save", { id: "p", baseUrl: "http://localhost:4010/v1", api: "openai-completions" });
    await host.harness.behavior.callRpc("relay_creds_set", { providerId: "p", username: "u", password: "p" });
    const session = { access_token: "test-access", expires_at: new Date(Date.now() + 3600_000).toISOString() };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(session), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ auth_index: "shared1", health_status: "disabled", quotas: [] }, { auth_index: "own1", health_status: "ok", quotas: [] }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [{ name: "own1.json", auth_index: "own1", disabled: false }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const view = await host.harness.behavior.callRpc("relay_accounts", { providerId: "p" }) as { items: Array<{ auth_index: string; disabled: boolean; auth_name?: string }> };
    expect(view.items[0]).toMatchObject({ auth_index: "shared1", disabled: true });
    expect(view.items[0]!.auth_name).toBeUndefined();
    expect(view.items[1]).toMatchObject({ auth_index: "own1", disabled: false, auth_name: "own1.json" });
  });
  it("relay_accounts мержит disabled/auth_name; relay_account_toggle патчит auth-files", async () => {
    const { host } = await load();
    await host.harness.behavior.callRpc("provider_save", { id: "p", baseUrl: "http://localhost:4010/v1", api: "openai-completions" });
    await host.harness.behavior.callRpc("relay_creds_set", { providerId: "p", username: "u", password: "p" });
    const session = { access_token: "test-access", expires_at: new Date(Date.now() + 3600_000).toISOString() };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(session), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ auth_index: "idx1", quotas: [] }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [{ name: "f1.json", auth_index: "idx1", disabled: true, email: "u@example.com" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [{ name: "f1.json", auth_index: "idx1", disabled: true, email: "u@example.com" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok", disabled: false }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const view = await host.harness.behavior.callRpc("relay_accounts", { providerId: "p" }) as { items: Array<{ auth_index: string; disabled: boolean; auth_name?: string }> };
    expect(view.items[0]).toMatchObject({ auth_index: "idx1", disabled: true, auth_name: "f1.json", email: "u@example.com" });
    const toggled = await host.harness.behavior.callRpc("relay_account_toggle", { providerId: "p", authIndex: "idx1", enabled: true }) as { disabled: boolean };
    expect(toggled).toEqual({ disabled: false });
    const patchCall = fetchMock.mock.calls[4] as unknown as [string, RequestInit];
    expect(patchCall[0]).toBe("http://localhost:4010/v0/management/auth-files/status");
    expect(patchCall[1].method).toBe("PATCH");
    expect(JSON.parse(String(patchCall[1].body))).toEqual({ name: "f1.json", disabled: false });
  });
  it("relay_creds_set per-origin: login с кредами адреса, clear → configured:false", async () => {
    const { host } = await load();
    await host.harness.behavior.callRpc("provider_save", { id: "p", baseUrl: "http://localhost:4010/v1", api: "openai-completions", apiKey: "test-key" });
    await host.harness.behavior.callRpc("relay_creds_set", { providerId: "p", username: "addr-user", password: "addr-pass" });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "test-access", expires_at: new Date(Date.now() + 3600_000).toISOString() }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await host.harness.behavior.callRpc("relay_accounts", { providerId: "p" }) as { configured: boolean };
    expect(result.configured).toBe(true);
    const [, loginInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(loginInit.body))).toMatchObject({ username: "addr-user", password: "addr-pass" });
    expect(JSON.stringify(result)).not.toContain("addr-pass");
    await host.harness.behavior.callRpc("relay_creds_clear", { providerId: "p" });
    const after = await host.harness.behavior.callRpc("relay_accounts", { providerId: "p" }) as { configured: boolean };
    expect(after.configured).toBe(false);
  });
  it("models_discover ходит с Bearer и отдаёт id", async () => {
    const { host } = await load();
    await host.harness.behavior.callRpc("provider_save", { id: "p", baseUrl: "http://localhost:4010/v1", api: "openai-completions", apiKey: "test-key" });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "m2" }, { id: "m1" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await host.harness.behavior.callRpc("models_discover", { providerId: "p" })).toEqual({ models: ["m1", "m2"] });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:4010/v1/models");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
  });
});
