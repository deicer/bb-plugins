// «Api модели» — бэкенд: RPC над ~/.pi/agent/models.json pi.
// Ключи и адреса живут только в этом файле (вне репо); фронтенду apiKey не возвращается.
import { homedir } from "node:os";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { discoverModels, resolveApiKey, testModel } from "./lib/discover";
import {
  addModelEntry, connectModel, deleteProvider, disconnectModel, hasModel, listProviders,
  readModelsFile, removeModelEntry, resolveModelsPath, updateModel, upsertProvider, writeModelsFile,
  type ModelEntry, type ModelsFile,
} from "./lib/models-file";
import { apiTypeSchema, baseUrlSchema, modelIdSchema, modelPatchSchema, providerIdSchema } from "./lib/schema";
import { fetchAuthFileStates, fetchRelayAccounts, relayAccountSchema, relayOrigin, setAuthFileDisabled } from "./lib/relay-accounts";
import { getManagementToken, loginRelay, type RelaySession } from "./lib/relay-auth";

const providerViewSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  baseUrl: z.string(),
  api: z.string(),
  apiKeySet: z.boolean(),
  models: z.array(z.looseObject({ id: z.string() })),
  disabled: z.array(z.looseObject({ id: z.string() })),
});

export const rpcContract = defineRpcContract({
  providers_list: { input: z.null(), output: z.object({ providers: z.array(providerViewSchema) }) },
  provider_save: {
    input: z.object({
      id: providerIdSchema,
      name: z.string().max(200).optional(),
      baseUrl: baseUrlSchema,
      api: apiTypeSchema,
      apiKey: z.string().max(500).optional(),
    }).strict(),
    output: providerViewSchema,
  },
  provider_delete: { input: z.object({ id: providerIdSchema }).strict(), output: z.object({ removed: z.boolean() }) },
  models_discover: { input: z.object({ providerId: providerIdSchema }).strict(), output: z.object({ models: z.array(z.string()) }) },
  model_connect: {
    input: z.object({ providerId: providerIdSchema, modelId: modelIdSchema }).strict(),
    output: z.object({ connected: z.boolean() }),
  },
  model_disconnect: {
    input: z.object({ providerId: providerIdSchema, modelId: modelIdSchema }).strict(),
    output: z.object({ removed: z.boolean() }),
  },
  model_toggle: {
    input: z.object({ providerId: providerIdSchema, modelId: modelIdSchema, enabled: z.boolean() }).strict(),
    output: z.object({ enabled: z.boolean() }),
  },
  model_update: {
    input: z.object({ providerId: providerIdSchema, modelId: modelIdSchema, patch: modelPatchSchema }).strict(),
    output: z.looseObject({ id: z.string() }),
  },
  model_test: {
    input: z.object({ providerId: providerIdSchema, modelId: modelIdSchema }).strict(),
    output: z.object({ ok: z.boolean(), latencyMs: z.number(), detail: z.string() }),
  },
  relay_accounts: {
    input: z.object({ providerId: providerIdSchema }).strict(),
    output: z.object({
      configured: z.boolean(),
      items: z.array(relayAccountSchema),
      error: z.string().optional(),
    }),
  },
  relay_creds_set: {
    input: z.object({
      providerId: providerIdSchema,
      username: z.string().min(1).max(200),
      password: z.string().min(1).max(500),
    }).strict(),
    output: z.object({ stored: z.boolean() }),
  },
  relay_creds_clear: {
    input: z.object({ providerId: providerIdSchema }).strict(),
    output: z.object({ cleared: z.boolean() }),
  },
  relay_account_toggle: {
    input: z.object({ providerId: providerIdSchema, authIndex: z.string().min(1).max(200), enabled: z.boolean() }).strict(),
    output: z.object({ disabled: z.boolean() }),
  },
});

const CHANGED = "api-models-changed";

export default async function plugin(bb: BbPluginApi) {
  // Путь к файлу pi конфигурируется: Settings → Installed plugins → Api модели
  // или `bb plugin config clirelay-test set modelsPath <путь>`. Читается при
  // загрузке — после смены нужен `bb plugin reload clirelay-test`.
  const settings = bb.settings.define({
    modelsPath: { type: "string", label: "Путь к models.json pi (пусто = ~/.pi/agent/models.json)", default: "" },
    managementUser: { type: "string", label: "Логин админки clirelay (для квот аккаунтов)", secret: true },
    managementPassword: { type: "string", label: "Пароль админки clirelay", secret: true },
  });
  const { modelsPath, managementUser, managementPassword } = await settings.get();
  // PI_MODELS_PATH — тестовый шов, важнее настройки.
  const filePath = resolveModelsPath(process.env, modelsPath, homedir());

  // ponytail: внутрипроцессный lock (очередь промисов). Апгрейд при multi-process — файловые блокировки.
  let queue: Promise<unknown> = Promise.resolve();
  function locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn);
    queue = run.catch(() => undefined);
    return run;
  }
  function mutate<T>(fn: (file: ModelsFile) => T): Promise<T> {
    return locked(async () => {
      const file = await readModelsFile(filePath);
      const result = fn(file);
      await writeModelsFile(filePath, file);
      bb.realtime.publish(CHANGED, {});
      return result;
    });
  }
  const disabledKey = (providerId: string) => `disabled-models:${providerId}`;
  const readDisabled = async (providerId: string): Promise<ModelEntry[]> =>
    (await bb.storage.kv.get<ModelEntry[]>(disabledKey(providerId))) ?? [];

  // Management-доступ: креды per-origin (kv) → глобальный fallback; токен из
  // кэша сессии, при отзыве — один повторный логин.
  const credsFor = async (origin: string) =>
    (await bb.storage.kv.get<{ username: string; password: string }>(`relay-creds:${origin}`))
    ?? (managementUser && managementPassword ? { username: managementUser, password: managementPassword } : null);
  async function withManagement<T>(origin: string, fn: (token: string) => Promise<T>): Promise<T> {
    const creds = await credsFor(origin);
    if (!creds) throw new Error("креды админки не заданы");
    const cacheKey = `relay-auth:${origin}`;
    const cache = {
      get: async () => (await bb.storage.kv.get<RelaySession>(cacheKey)) ?? null,
      set: async (session: RelaySession) => { await bb.storage.kv.set(cacheKey, session); },
    };
    const token = await getManagementToken({ origin, creds, cache });
    try {
      return await fn(token);
    } catch (cause) {
      if (cause instanceof Error && /логин и пароль/.test(cause.message)) {
        const session = await loginRelay(origin, creds);
        await cache.set(session);
        return fn(session.access_token);
      }
      throw cause;
    }
  }

  bb.rpc.register(rpcContract, {
    providers_list: async () => {
      const views = listProviders(await readModelsFile(filePath));
      for (const view of views) view.disabled = await readDisabled(view.id);
      return { providers: views };
    },
    provider_save: async (input) =>
      mutate((file) => {
        upsertProvider(file, input);
        return listProviders(file).find((view) => view.id === input.id)!;
      }),
    provider_delete: async ({ id }) => ({ removed: await mutate((file) => deleteProvider(file, id)) }),
    models_discover: async ({ providerId }) => {
      const file = await readModelsFile(filePath);
      const entry = file.providers[providerId];
      if (!entry) throw new Error(`Провайдер не найден: ${providerId}`);
      if (typeof entry.baseUrl !== "string" || !entry.baseUrl) throw new Error("у провайдера не задан baseUrl");
      return { models: await discoverModels(entry.baseUrl, resolveApiKey(entry.apiKey)) };
    },
    model_connect: async ({ providerId, modelId }) => ({ connected: await mutate((file) => connectModel(file, providerId, modelId)) }),
    model_disconnect: async ({ providerId, modelId }) => ({
      removed: await locked(async () => {
        const file = await readModelsFile(filePath);
        let removed = disconnectModel(file, providerId, modelId);
        if (removed) {
          await writeModelsFile(filePath, file);
        } else {
          const disabled = await readDisabled(providerId);
          const next = disabled.filter((model) => model.id !== modelId);
          removed = next.length !== disabled.length;
          if (removed) await bb.storage.kv.set(disabledKey(providerId), next);
        }
        if (removed) bb.realtime.publish(CHANGED, {});
        return removed;
      }),
    }),
    model_toggle: async ({ providerId, modelId, enabled }) => ({
      enabled: await locked(async () => {
        const disabled = await readDisabled(providerId);
        const file = await readModelsFile(filePath);
        let fileChanged = false;
        if (!enabled) {
          const entry = removeModelEntry(file, providerId, modelId);
          if (entry) {
            disabled.push(entry);
            fileChanged = true;
          } else if (!disabled.some((model) => model.id === modelId)) {
            throw new Error(`Модель не найдена: ${modelId}`);
          }
        } else {
          const index = disabled.findIndex((model) => model.id === modelId);
          if (index >= 0) {
            const [entry] = disabled.splice(index, 1);
            addModelEntry(file, providerId, entry!);
            fileChanged = true;
          } else if (!hasModel(file, providerId, modelId)) {
            throw new Error(`Модель не найдена: ${modelId}`);
          }
        }
        await bb.storage.kv.set(disabledKey(providerId), disabled);
        if (fileChanged) await writeModelsFile(filePath, file);
        bb.realtime.publish(CHANGED, {});
        return enabled;
      }),
    }),
    model_update: async ({ providerId, modelId, patch }) =>
      locked(async () => {
        const file = await readModelsFile(filePath);
        if (hasModel(file, providerId, modelId)) {
          const result = updateModel(file, providerId, modelId, patch);
          await writeModelsFile(filePath, file);
          bb.realtime.publish(CHANGED, {});
          return result;
        }
        const disabled = await readDisabled(providerId);
        const entry = disabled.find((model) => model.id === modelId);
        if (!entry) throw new Error(`Модель не найдена: ${modelId}`);
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) delete entry[key];
          else if (value !== undefined) entry[key] = value;
        }
        await bb.storage.kv.set(disabledKey(providerId), disabled);
        bb.realtime.publish(CHANGED, {});
        return entry;
      }),
    model_test: async ({ providerId, modelId }) => {
      const file = await readModelsFile(filePath);
      const entry = file.providers[providerId];
      if (!entry) throw new Error(`Провайдер не найден: ${providerId}`);
      if (typeof entry.baseUrl !== "string" || !entry.baseUrl) throw new Error("у провайдера не задан baseUrl");
      const models = Array.isArray(entry.models) ? entry.models : [];
      const model = models.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).id === modelId) as Record<string, unknown> | undefined;
      if (!model) throw new Error(`Модель не найдена: ${modelId}`);
      const api = typeof model.api === "string" ? model.api : entry.api;
      if (api !== "openai-completions") return { ok: false, latencyMs: 0, detail: "тест поддерживается только для openai-completions" };
      return testModel(entry.baseUrl, resolveApiKey(entry.apiKey), modelId);
    },
    relay_accounts: async ({ providerId }) => {
      const file = await readModelsFile(filePath);
      const entry = file.providers[providerId];
      if (!entry) throw new Error(`Провайдер не найден: ${providerId}`);
      if (typeof entry.baseUrl !== "string" || !entry.baseUrl) throw new Error("у провайдера не задан baseUrl");
      const origin = relayOrigin(entry.baseUrl);
      if (!(await credsFor(origin))) return { configured: false, items: [] };
      try {
        const items = await withManagement(origin, async (token) => {
          const accounts = await fetchRelayAccounts(entry.baseUrl as string, token);
          const states = await fetchAuthFileStates(entry.baseUrl as string, token).catch(() => new Map<string, { name: string; disabled: boolean; email?: string; label?: string }>());
          for (const account of accounts) {
            const state = states.get(account.auth_index);
            // shared-аккаунтов нет в auth-files: disabled берём из health_status
            account.disabled = state ? state.disabled : account.health_status === "disabled";
            if (state) {
              account.auth_name = state.name;
              // undefined не проходит JSON-границу RPC — пишем только наявное
              if (state.email) account.email = state.email;
              if (state.label) account.label = state.label;
            }
          }
          return accounts;
        });
        return { configured: true, items };
      } catch (cause) {
        return { configured: true, items: [], error: cause instanceof Error ? cause.message : String(cause) };
      }
    },
    relay_account_toggle: async ({ providerId, authIndex, enabled }) => {
      const file = await readModelsFile(filePath);
      const entry = file.providers[providerId];
      if (!entry) throw new Error(`Провайдер не найден: ${providerId}`);
      if (typeof entry.baseUrl !== "string" || !entry.baseUrl) throw new Error("у провайдера не задан baseUrl");
      const origin = relayOrigin(entry.baseUrl);
      const disabled = await withManagement(origin, async (token) => {
        const states = await fetchAuthFileStates(entry.baseUrl as string, token);
        const state = states.get(authIndex);
        if (!state) throw new Error(`Аккаунт не найден в auth-files: ${authIndex}`);
        return setAuthFileDisabled(entry.baseUrl as string, token, state.name, !enabled);
      });
      return { disabled };
    },
    relay_creds_set: async ({ providerId, username, password }) => {
      const file = await readModelsFile(filePath);
      const entry = file.providers[providerId];
      if (!entry) throw new Error(`Провайдер не найден: ${providerId}`);
      if (typeof entry.baseUrl !== "string" || !entry.baseUrl) throw new Error("у провайдера не задан baseUrl");
      const origin = relayOrigin(entry.baseUrl);
      await bb.storage.kv.set(`relay-creds:${origin}`, { username, password });
      await bb.storage.kv.set(`relay-auth:${origin}`, null);
      return { stored: true };
    },
    relay_creds_clear: async ({ providerId }) => {
      const file = await readModelsFile(filePath);
      const entry = file.providers[providerId];
      if (!entry) throw new Error(`Провайдер не найден: ${providerId}`);
      if (typeof entry.baseUrl !== "string" || !entry.baseUrl) throw new Error("у провайдера не задан baseUrl");
      const origin = relayOrigin(entry.baseUrl);
      await bb.storage.kv.set(`relay-creds:${origin}`, null);
      await bb.storage.kv.set(`relay-auth:${origin}`, null);
      return { cleared: true };
    },
  });

  bb.log.info("api-models loaded");
}
