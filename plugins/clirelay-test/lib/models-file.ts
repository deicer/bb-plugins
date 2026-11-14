import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ModelPatch, ProviderView } from "./schema";

export type { ProviderView } from "./schema";

export type ProviderEntry = Record<string, unknown>;
export type ModelEntry = { id: string } & Record<string, unknown>;
export interface ModelsFile { providers: Record<string, ProviderEntry>; [key: string]: unknown }

// Приоритет: тестовый env → настройка плагина → дефолт pi.
export function resolveModelsPath(env: NodeJS.ProcessEnv, configured: string | undefined, home: string): string {
  if (env.PI_MODELS_PATH) return env.PI_MODELS_PATH;
  const trimmed = configured?.trim();
  if (trimmed) return trimmed;
  return join(home, ".pi", "agent", "models.json");
}

const CORRUPT = "models.json повреждён или не является объектом — файл не изменён";

export async function readModelsFile(path: string): Promise<ModelsFile> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { providers: {} };
    throw cause;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(CORRUPT);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(CORRUPT);
  const file = parsed as ModelsFile;
  if (file.providers === undefined) file.providers = {};
  if (!file.providers || typeof file.providers !== "object" || Array.isArray(file.providers)) throw new Error(CORRUPT);
  return file;
}

// ponytail: одна ротация .bak; апгрейд при необходимости — нумерованные копии.
export async function writeModelsFile(path: string, data: ModelsFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await copyFile(path, `${path}.bak`);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  const tmp = join(dirname(path), `.models-${process.pid}-${Date.now()}.tmp`);
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

function provider(file: ModelsFile, id: string): ProviderEntry {
  const entry = file.providers[id];
  if (!entry || typeof entry !== "object") throw new Error(`Провайдер не найден: ${id}`);
  return entry;
}

function modelsArray(entry: ProviderEntry): ModelEntry[] {
  if (!Array.isArray(entry.models)) entry.models = [];
  return entry.models as ModelEntry[];
}

export function upsertProvider(
  file: ModelsFile,
  input: { id: string; name?: string; baseUrl: string; api: string; apiKey?: string },
): void {
  const next: ProviderEntry = { ...(file.providers[input.id] ?? {}), baseUrl: input.baseUrl, api: input.api };
  if (input.name) next.name = input.name;
  else delete next.name;
  if (input.apiKey) next.apiKey = input.apiKey; // пусто → прежний ключ сохраняется
  file.providers[input.id] = next;
}

export function deleteProvider(file: ModelsFile, id: string): boolean {
  if (!(id in file.providers)) return false;
  delete file.providers[id];
  return true;
}

export function connectModel(file: ModelsFile, providerId: string, modelId: string): boolean {
  const models = modelsArray(provider(file, providerId));
  if (models.some((model) => model.id === modelId)) return false;
  models.push({ id: modelId });
  return true;
}

export function disconnectModel(file: ModelsFile, providerId: string, modelId: string): boolean {
  const entry = provider(file, providerId);
  const models = modelsArray(entry);
  const next = models.filter((model) => model.id !== modelId);
  if (next.length === models.length) return false;
  entry.models = next;
  return true;
}

// Выключение модели: запись переезжает в kv плагина, настройки сохраняются.
export function removeModelEntry(file: ModelsFile, providerId: string, modelId: string): ModelEntry | null {
  const models = modelsArray(provider(file, providerId));
  const index = models.findIndex((model) => model.id === modelId);
  if (index < 0) return null;
  const [entry] = models.splice(index, 1);
  return entry!;
}

export function addModelEntry(file: ModelsFile, providerId: string, entry: ModelEntry): boolean {
  const models = modelsArray(provider(file, providerId));
  if (models.some((model) => model.id === entry.id)) return false;
  models.push(entry);
  return true;
}

export function hasModel(file: ModelsFile, providerId: string, modelId: string): boolean {
  return modelsArray(provider(file, providerId)).some((model) => model.id === modelId);
}

export function updateModel(
  file: ModelsFile, providerId: string, modelId: string, patch: ModelPatch,
): ModelEntry {
  const model = modelsArray(provider(file, providerId)).find((entry) => entry.id === modelId);
  if (!model) throw new Error(`Модель не найдена: ${modelId}`);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete model[key];
    else if (value !== undefined) model[key] = value;
  }
  return model;
}

export function listProviders(file: ModelsFile): ProviderView[] {
  return Object.entries(file.providers).map(([id, entry]) => ({
    id,
    // RPC-граница требует чистый JSON: отсутствующее имя не пишем вовсе.
    ...(typeof entry.name === "string" ? { name: entry.name } : {}),
    baseUrl: typeof entry.baseUrl === "string" ? entry.baseUrl : "",
    api: typeof entry.api === "string" ? entry.api : "openai-completions",
    apiKeySet: typeof entry.apiKey === "string" && entry.apiKey.length > 0,
    disabled: [],
    models: (Array.isArray(entry.models) ? entry.models : [])
      .filter((model): model is ModelEntry =>
        !!model && typeof model === "object" && typeof (model as Record<string, unknown>).id === "string")
      .map((model) => {
        const { apiKey: _key, headers: _headers, ...rest } = model;
        return rest;
      }),
  }));
}
