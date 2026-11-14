import { describe, expect, it } from "vitest";
import { groupByFamily, modelFamily } from "./model-groups";

describe("modelFamily", () => {
  it("определяет семейство по id", () => {
    expect(modelFamily("claude-sonnet-5-5")).toBe("Claude");
    expect(modelFamily("gpt-6.1-sol")).toBe("GPT");
    expect(modelFamily("o3-mini")).toBe("GPT");
    expect(modelFamily("gemini-3.8-flash")).toBe("Gemini");
    expect(modelFamily("qwen4-max")).toBe("Qwen");
    expect(modelFamily("kimi-k3.1-pro")).toBe("Kimi");
    expect(modelFamily("deepseek-v4.1")).toBe("DeepSeek");
    expect(modelFamily("grok-4.7")).toBe("Grok");
    expect(modelFamily("llama-4-scout")).toBe("Llama");
    expect(modelFamily("mistral-large")).toBe("Mistral");
    expect(modelFamily("some-unknown-model")).toBe("Другие");
  });
});

describe("groupByFamily", () => {
  it("группирует в порядке первого появления", () => {
    const groups = groupByFamily([
      { id: "gpt-a" }, { id: "claude-a" }, { id: "gpt-b" }, { id: "x-y" },
    ]);
    expect(groups.map((g) => g.family)).toEqual(["GPT", "Claude", "Другие"]);
    expect(groups[0]!.items.map((i) => i.id)).toEqual(["gpt-a", "gpt-b"]);
  });
  it("пустой список → пусто", () => {
    expect(groupByFamily([])).toEqual([]);
  });
});
