import assert from "node:assert/strict";
import { test } from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import plugin from "./server.ts";
import { contract } from "./contract.ts";

test("RPC returns JSON with sparse provider artwork, persists selection/order, and respects disabled providers", async () => {
  const values = new Map<string, unknown>();
  const requested: string[][] = [];
  const hostCalls: unknown[] = [];
  let handlers: Record<string, (input: unknown, context: unknown) => Promise<unknown>>;
  const providers = [{ id: "codex", displayName: "Codex" }, { id: "claude", displayName: "Claude" }];
  const bb = {
    hosts: { experimental_client: () => ({ call: async (method: string, input: unknown, options: unknown) => {
      hostCalls.push({ method, input, options });
      return { accountId: "workspace-1", email: "user@example.com", availableCount: 0, credits: [], windows: [] };
    } }) },
    storage: { kv: { get: async (key: string) => values.get(key), set: async (key: string, value: unknown) => { values.set(key, value); } } },
    sdk: {
      system: { config: async () => ({ primaryHostId: "host-1" }) },
      providers: { list: async () => providers },
      plugins: { callRpc: async ({ input }: { input: { providerIds: string[] } }) => {
        requested.push(input.providerIds);
        return { machines: [{ id: "host-1", displayName: "Laptop", status: "connected", error: null,
          providers: providers.map(p => ({ id: `${p.id}-account`, providerId: p.id, displayName: p.displayName,
            usage: { status: "ok", accountEmail: p.id === "codex" ? "user@example.com" : null, planLabel: null, windows: [{ label: "Weekly limit", usedPercent: 11, resetsAt: null }] } })) }] };
      } },
    },
    rpc: { register: (_contract: unknown, registered: typeof handlers) => { handlers = registered; }, experimental_invalidate: () => {} },
    events: { on: () => {} },
  } as unknown as BbPluginApi;
  plugin(bb);
  async function call(method: keyof typeof contract, input: unknown) {
    const parsed = contract[method].input.parse(input);
    const result = await handlers![method]!(parsed, {});
    assert.deepEqual(result, JSON.parse(JSON.stringify(result)), "RPC output must contain no undefined fields");
    return contract[method].output.parse(result);
  }
  const initial = await call("overview", { hostId: null }) as { providers: { id: string; enabled: boolean }[] };
  assert.deepEqual(initial.providers.map(p => p.id), ["codex", "claude"]);
  await call("savePreferences", [{ id: "claude", enabled: true }, { id: "codex", enabled: false }]);
  plugin(bb);
  const after = await call("overview", { hostId: null }) as typeof initial;
  assert.deepEqual(after.providers.map(p => [p.id, p.enabled]), [["claude", true], ["codex", false]]);
  assert.deepEqual(requested.at(-1), ["claude"]);
  const resets = await call("resets", { hostId: "host-1", accountId: "codex-account" });
  assert.equal((resets as { availableCount: number }).availableCount, 0);
  assert.deepEqual(hostCalls, [{ method: "readResets", input: { expectedEmail: "user@example.com" }, options: { hostId: "host-1", signal: undefined, timeoutMs: 60_000 } }]);
  await assert.rejects(() => call("resets", { hostId: "host-1", accountId: "claude-account" }));
  await assert.rejects(() => call("savePreferences", [{ id: "codex", enabled: true }, { id: "codex", enabled: false }]));
});

test("discovers Google Antigravity, caches host usage until refresh/event, skips when disabled, and isolates errors", async () => {
  const values = new Map<string, unknown>();
  const requestedUsageIds: string[][] = [];
  let antigravityReads = 0;
  let shouldFailAntigravity = false;
  let handlers: Record<string, (input: unknown, context: unknown) => Promise<unknown>>;
  const listeners = new Map<string, () => void>();
  const nativeProviders = [{ id: "codex", displayName: "Codex" }];
  const allProviders = [
    { id: "codex", displayName: "Codex" },
    { id: "acp-antigravity-acp", displayName: "Google Antigravity", logoUrl: "/api/v1/system/providers/acp-antigravity-acp/logo" },
  ];
  const bb = {
    hosts: { experimental_client: () => ({ call: async (method: string) => {
      if (method === "readAntigravityUsage") {
        antigravityReads++;
        if (shouldFailAntigravity) throw new Error("boom");
        return {
          status: "ok",
          accountEmail: null,
          planLabel: null,
          windows: [
            { label: "Weekly limit", usedPercent: 2, resetsAt: "2026-11-27T17:12:23Z", group: "Gemini Models" },
            { label: "Five-hour limit", usedPercent: 4, resetsAt: "2026-11-20T22:12:23Z", group: "Gemini Models" },
            { label: "Five-hour limit", usedPercent: 0, resetsAt: null, group: "Claude and GPT models" },
          ],
        };
      }
      throw new Error(`unexpected ${method}`);
    } }) },
    storage: { kv: { get: async (key: string) => values.get(key), set: async (key: string, value: unknown) => { values.set(key, value); } } },
    sdk: {
      system: { config: async () => ({ primaryHostId: "host-1" }) },
      providers: { list: async (args?: { capability?: string }) => args?.capability === "usage" ? nativeProviders : allProviders },
      plugins: { callRpc: async ({ input }: { input: { providerIds: string[] } }) => {
        requestedUsageIds.push(input.providerIds);
        return { machines: [{ id: "host-1", displayName: "Laptop", status: "connected", error: null,
          providers: [{ id: "codex-account", providerId: "codex", displayName: "Codex",
            usage: { status: "ok", accountEmail: "user@example.com", planLabel: null, windows: [{ label: "Weekly limit", usedPercent: 21, resetsAt: null }] } }] }] };
      } },
    },
    rpc: { register: (_contract: unknown, registered: typeof handlers) => { handlers = registered; }, experimental_invalidate: () => {} },
    events: { on: (event: string, listener: () => void) => { listeners.set(event, listener); } },
  } as unknown as BbPluginApi;
  plugin(bb);

  async function call(method: keyof typeof contract, input: unknown) {
    const parsed = contract[method].input.parse(input);
    const result = await handlers![method]!(parsed, {});
    assert.deepEqual(result, JSON.parse(JSON.stringify(result)), "RPC output must contain no undefined fields");
    return contract[method].output.parse(result);
  }

  const first = await call("overview", { hostId: null }) as { providers: { id: string; enabled: boolean; accounts: { usage?: { status: string; windows?: unknown[] } }[] }[] };
  assert.deepEqual(first.providers.map(p => [p.id, p.enabled]), [["codex", true], ["acp-antigravity-acp", true]]);
  assert.equal(first.providers[1]!.accounts[0]!.usage?.status, "ok");
  assert.equal(first.providers[1]!.accounts[0]!.usage?.windows?.length, 3);
  assert.equal(antigravityReads, 1);
  assert.deepEqual(requestedUsageIds.at(-1), ["codex"]);

  // Cached read does not re-invoke agy on host.
  await call("overview", { hostId: null });
  assert.equal(antigravityReads, 1);

  // Manual refresh bypasses cache.
  await call("refresh", { hostId: null });
  assert.equal(antigravityReads, 2);

  // Thread completion clears cache so next overview refreshes.
  listeners.get("thread.idle")?.();
  await call("overview", { hostId: null });
  assert.equal(antigravityReads, 3);

  // Disabling Google Antigravity skips host calls completely.
  await call("savePreferences", [{ id: "codex", enabled: true }, { id: "acp-antigravity-acp", enabled: false }]);
  listeners.get("thread.idle")?.();
  const disabled = await call("overview", { hostId: null }) as typeof first;
  assert.equal(disabled.providers[1]!.enabled, false);
  assert.equal(antigravityReads, 3);

  // Re-enabling with host failure isolates error to Google Antigravity while keeping Codex intact.
  await call("savePreferences", [{ id: "codex", enabled: true }, { id: "acp-antigravity-acp", enabled: true }]);
  shouldFailAntigravity = true;
  const failed = await call("overview", { hostId: null }) as typeof first;
  assert.equal(failed.providers[0]!.accounts[0]!.usage?.status, "ok");
  assert.equal(failed.providers[1]!.accounts[0]!.usage?.status, "error");
});

test("merges provider usage resources so Command Code reaches the rings", async () => {
  let handlers: Record<string, (input: unknown, context: unknown) => Promise<unknown>>;
  const nativeProviders = [{ id: "codex", displayName: "Codex" }];
  const allProviders = [...nativeProviders, { id: "command-code", displayName: "Command Code" }];
  const bb = {
    hosts: { experimental_client: () => ({ call: async () => ({ accountId: "workspace-1", email: "user@example.com", availableCount: 0, credits: [], windows: [] }) }) },
    storage: { kv: { get: async () => undefined, set: async () => {} } },
    sdk: {
      system: { config: async () => ({ primaryHostId: "host-1" }) },
      providers: { list: async (args?: { capability?: string }) => args?.capability === "usage" ? nativeProviders : allProviders },
      plugins: {
        experimental_discoverRpc: async () => [{ pluginId: "command-code", method: "provider-usage.v1.listResources" }, { pluginId: "command-code", method: "provider-usage.v1.getResource" }],
        callRpc: async ({ pluginId, method, input }: { pluginId: string; method: string; input: any }) => {
          if (pluginId === "bb--provider-usage") return { machines: [{ id: "host-1", displayName: "Laptop", status: "connected", error: null, providers: [] }] };
          if (method === "provider-usage.v1.listResources") return { resources: [{ accountKey: null, id: "resource-1", providerId: "command-code", label: "Command Code", scope: { kind: "host", hostId: "host-1", hostName: "Laptop" } }] };
          assert.equal(input.resourceId, "resource-1");
          return { accountKey: null, observedAt: Date.now(), usage: { status: "ok", plan: null, accountEmail: "user@example.com", planLabel: "Individual", windows: [{ kind: "custom", id: "credits", label: "Credits · 39% left", usedPercent: 61, resetsAt: null, model: null, cost: null }] } };
        },
      },
    },
    rpc: { register: (_contract: unknown, registered: typeof handlers) => { handlers = registered; }, experimental_invalidate: () => {} },
    events: { on: () => {} },
  } as unknown as BbPluginApi;
  plugin(bb);
  const result = await handlers!.overview!({ hostId: "host-1" }, {});
  const commandCode = (result as any).providers.find((provider: any) => provider.id === "command-code");
  assert.equal(commandCode.enabled, true);
  assert.equal(commandCode.accounts[0].usage.windows[0].usedPercent, 61);
});
