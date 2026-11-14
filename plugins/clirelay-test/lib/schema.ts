import { z } from "zod";

export const API_TYPES = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const;
export const apiTypeSchema = z.enum(API_TYPES);
export type ApiType = (typeof API_TYPES)[number];

export const providerIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "id: строчные буквы/цифры/_/-, до 64 символов");

export const baseUrlSchema = z
  .string()
  .min(1)
  .refine((value) => /^https?:\/\/\S+$/.test(value), "baseUrl: нужен http(s)://адрес");

export const modelIdSchema = z.string().min(1).max(200);

// null = удалить поле из записи модели; отсутствие = не менять.
export const modelPatchSchema = z
  .object({
    name: z.string().min(1).max(200).nullable(),
    reasoning: z.boolean().nullable(),
    contextWindow: z.number().int().positive().nullable(),
    maxTokens: z.number().int().positive().nullable(),
    input: z.array(z.enum(["text", "image"])).min(1).nullable(),
  })
  .strict()
  .partial();
export type ModelPatch = z.infer<typeof modelPatchSchema>;

export type ModelFieldType = "string" | "bool" | "int" | "multiselect";
export interface ModelFieldSpec {
  key: keyof ModelPatch;
  label: string;
  type: ModelFieldType;
  placeholder?: string;
  options?: readonly string[];
}

// v1: базовые поля. Compat/Sampling/Cost добавляются сюда же без переделки рендерера.
export const MODEL_FIELDS: readonly ModelFieldSpec[] = [
  { key: "name", label: "Имя", type: "string" },
  { key: "reasoning", label: "Reasoning (thinking)", type: "bool" },
  { key: "contextWindow", label: "Context window", type: "int", placeholder: "128000" },
  { key: "maxTokens", label: "Max output tokens", type: "int", placeholder: "16384" },
  { key: "input", label: "Вход", type: "multiselect", options: ["text", "image"] },
];

// Вид провайдера для RPC/фронтенда: без apiKey и headers.
export interface ProviderView {
  id: string; name?: string; baseUrl: string; api: string; apiKeySet: boolean;
  models: Array<{ id: string } & Record<string, unknown>>;
  disabled: Array<{ id: string } & Record<string, unknown>>;
}

// Провайдеры на одном адресе показываются вложенно под общей группой.
export function groupProvidersByBaseUrl(providers: ProviderView[]): Array<{ baseUrl: string; providers: ProviderView[] }> {
  const groups: Array<{ baseUrl: string; providers: ProviderView[] }> = [];
  const byUrl = new Map<string, { baseUrl: string; providers: ProviderView[] }>();
  for (const provider of providers) {
    let group = byUrl.get(provider.baseUrl);
    if (!group) {
      group = { baseUrl: provider.baseUrl, providers: [] };
      byUrl.set(provider.baseUrl, group);
      groups.push(group);
    }
    group.providers.push(provider);
  }
  return groups;
}
