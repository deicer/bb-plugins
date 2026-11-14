import { describe, expect, it } from "vitest";
import { groupProvidersByBaseUrl, MODEL_FIELDS, modelPatchSchema, providerIdSchema, type ProviderView } from "./schema";

const view = (id: string, baseUrl: string): ProviderView => ({ id, baseUrl, api: "openai-completions", apiKeySet: true, models: [], disabled: [] });

describe("groupProvidersByBaseUrl", () => {
  it("одинаковый адрес → одна группа, порядок провайдеров и групп сохранён", () => {
    const groups = groupProvidersByBaseUrl([
      view("a", "http://localhost:4010/v1"),
      view("b", "http://localhost:4010/v1"),
      view("c", "http://localhost:4011/v1"),
    ]);
    expect(groups.map((g) => g.baseUrl)).toEqual(["http://localhost:4010/v1", "http://localhost:4011/v1"]);
    expect(groups[0]!.providers.map((p) => p.id)).toEqual(["a", "b"]);
    expect(groups[1]!.providers.map((p) => p.id)).toEqual(["c"]);
  });
  it("пустой список → пусто", () => {
    expect(groupProvidersByBaseUrl([])).toEqual([]);
  });
});

describe("modelPatchSchema", () => {
  it("принимает типы полей и null-удаление", () => {
    const patch = { reasoning: true, contextWindow: 400000, input: ["text", "image"], name: null };
    expect(modelPatchSchema.parse(patch)).toEqual(patch);
  });
  it("отклоняет неверные типы, пустой input, неизвестные поля", () => {
    expect(modelPatchSchema.safeParse({ contextWindow: "много" }).success).toBe(false);
    expect(modelPatchSchema.safeParse({ reasoning: 1 }).success).toBe(false);
    expect(modelPatchSchema.safeParse({ input: [] }).success).toBe(false);
    expect(modelPatchSchema.safeParse({ compat: {} }).success).toBe(false);
  });
  it("форма покрывает все поля патча", () => {
    expect(MODEL_FIELDS.map((f) => f.key).sort()).toEqual(["contextWindow", "input", "maxTokens", "name", "reasoning"]);
  });
});

describe("providerIdSchema", () => {
  it("только slug", () => {
    expect(providerIdSchema.safeParse("router-gpt").success).toBe(true);
    expect(providerIdSchema.safeParse("Router GPT").success).toBe(false);
    expect(providerIdSchema.safeParse("").success).toBe(false);
  });
});
