import { describe, expect, it } from "vitest";
import type { TurnUsage } from "./contract";
import { DEFAULT_TOKENS_DISPLAY } from "./display";
import { formatCompact, formatThreadText, formatTurnText, formatTurnTitle } from "./format";

const BADGE = DEFAULT_TOKENS_DISPLAY.badge.fields;
const THREAD = DEFAULT_TOKENS_DISPLAY.thread.fields;

const SAMPLE_TURN = {
  input: 1_200, cached: 265_000, output: 740, reasoning: 120, tokPerSec: 59.2, model: "example-model",
};
const SAMPLE_THREAD = {
  total: 5_100_000, turns: 12, averageTokPerSec: 51.3, modelContextWindow: 1_000_000, model: "example-model",
};

describe("formatCompact", () => {
  it.each([
    [0, "0"], [999, "999"], [1_000, "1k"], [1_200, "1.2k"],
    [265_000, "265k"], [1_200_000, "1.2M"], [999_999, "1M"],
  ])("%i → %s", (value, expected) => {
    expect(formatCompact(value)).toBe(expected);
  });
});

describe("текст бейджа", () => {
  it("с дефолтами — прежняя строка token-meter", () => {
    expect(formatTurnText(SAMPLE_TURN, BADGE)).toBe("↑1.2k ↓740 · cache 265k · 59.2 ток/с (эфф.)");
    expect(formatTurnText({ input: 1_200, cached: 0, output: 740, tokPerSec: 42 }, BADGE))
      .toBe("↑1.2k ↓740 · cache 0 · 42 ток/с (эфф.)");
  });

  it("все поля включены → reasoning и модель в порядке BADGE_FIELDS", () => {
    expect(formatTurnText(SAMPLE_TURN, {
      input: true, output: true, cache: true, reasoning: true, speed: true, model: true,
    })).toBe("↑1.2k ↓740 · cache 265k · reasoning 120 · 59.2 ток/с (эфф.) · example-model");
  });

  it("частичный набор полей: только выход, только модель", () => {
    expect(formatTurnText(SAMPLE_TURN, { ...BADGE, input: false, output: true, cache: false, speed: false }))
      .toBe("↓740");
    const onlyModel = { ...BADGE, input: false, output: false, cache: false, speed: false, model: true };
    expect(formatTurnText({ input: 1, cached: 0, output: 2 }, onlyModel)).toBe("");
    expect(formatTurnText({ input: 1, cached: 0, output: 2, model: "m" }, onlyModel)).toBe("m");
  });

  it("всё выключено → пустая строка; скорость без tokPerSec → сегмента нет", () => {
    expect(formatTurnText(SAMPLE_TURN, {
      input: false, output: false, cache: false, reasoning: false, speed: false, model: false,
    })).toBe("");
    expect(formatTurnText({ input: 1, cached: 0, output: 2 }, BADGE)).toBe("↑1 ↓2 · cache 0");
  });

  it("округляет эффективную скорость", () => {
    expect(formatTurnText({ input: 1, cached: 0, output: 2, tokPerSec: 134.4 }, BADGE)).toContain("134 ток/с (эфф.)");
    expect(formatTurnText({ input: 1, cached: 0, output: 2, tokPerSec: 99.95 }, BADGE)).toContain("100 ток/с (эфф.)");
    expect(formatTurnText({ input: 1, cached: 0, output: 2, tokPerSec: 9.95 }, BADGE)).toContain("10 ток/с (эфф.)");
  });
});

describe("текст строки треда", () => {
  it("с дефолтами — прежняя сводка; при активном ходе добавляет скорость шага без дубля на 1-м ходе", () => {
    expect(formatThreadText(SAMPLE_THREAD, THREAD)).toBe("Σ 5.1M токенов · ~51.3 ток/с (эфф.)");
    expect(formatThreadText({ ...SAMPLE_THREAD, currentTokPerSec: 89.2 }, THREAD))
      .toBe("Σ 5.1M токенов · ~51.3 ток/с (эфф.) · шаг 89.2 ток/с");
    expect(formatThreadText({ total: 134_700, turns: 1, averageTokPerSec: 99.8, currentTokPerSec: 99.8, modelContextWindow: null }, THREAD))
      .toBe("Σ 134.7k токенов · шаг 99.8 ток/с");
    expect(formatThreadText({ total: 531_000, turns: 4, modelContextWindow: null }, THREAD)).toBe("Σ 531k токенов");
  });

  it("все поля включены → модель, ходы, окно в порядке THREAD_FIELDS", () => {
    expect(formatThreadText(SAMPLE_THREAD, {
      total: true, speed: true, model: true, turns: true, contextWindow: true,
    })).toBe("Σ 5.1M токенов · ~51.3 ток/с (эфф.) · example-model · 12 ходов · окно 1M");
  });

  it.each([
    [1, "1 ход"], [2, "2 хода"], [5, "5 ходов"], [11, "11 ходов"], [21, "21 ход"],
  ])("склоняет %i → %s", (turns, expected) => {
    expect(formatThreadText({ total: 10, turns, modelContextWindow: null }, { ...THREAD, turns: true })).toContain(expected);
  });

  it("окно контекста null → сегмента нет; всё выключено → пустая строка", () => {
    expect(formatThreadText({ total: 10, turns: 1, modelContextWindow: null }, { ...THREAD, contextWindow: true }))
      .not.toContain("окно");
    expect(formatThreadText(SAMPLE_THREAD, {
      total: false, speed: false, model: false, turns: false, contextWindow: false,
    })).toBe("");
  });
});

describe("title бейджа", () => {
  const usage: TurnUsage = {
    threadId: "thr_1", turnId: "turn-1", input: 1_200, cached: 265_000,
    cacheRead: 260_000, cacheWrite: 5_000, output: 740, reasoning: 120,
    total: 2_060, durationMs: 12_500, turnDurationMs: 20_000, tokPerSec: 59.2,
    model: "test-model", providerId: "test-provider", at: 1_000,
  };

  it("объясняет эффективную скорость, не зависит от галочек и начинается с модели", () => {
    const title = formatTurnTitle(usage);
    expect(title.startsWith("Модель: test-model\n")).toBe(true);
    expect(title).toContain("Эффективная скорость последнего вызова: 59.2 ток/с — выход ÷ время от конца последнего инструмента до конца хода; включает ожидание первого токена (обработка контекста, очередь, скрытое рассуждение)");
    expect(title).toContain("Последний вызов: 12.5 с · Весь ход: 20 с");
    expect(title).not.toContain("Чистая генерация");
    expect(title).not.toContain("модель ~");
  });

  it("без модели строка модели не появляется", () => {
    const { model: _model, ...bare } = usage;
    expect(formatTurnTitle(bare).startsWith("Вход: ")).toBe(true);
  });

  it("форматирует contextWindow-only usage (ACP/Gemini)", () => {
    expect(formatTurnText({
      usageSource: "contextWindow",
      input: 0, cached: 0, output: 0, total: 15_813, durationMs: 4_497,
    })).toBe("контекст 15.8k · 4.5 с");
    const title = formatTurnTitle({
      threadId: "thr_1", turnId: "turn-1", usageSource: "contextWindow",
      input: 0, cached: 0, output: 0, reasoning: 0, total: 15_813,
      modelContextWindow: 1_048_576, durationMs: 4_500, turnDurationMs: 4_500,
      model: "gemini-4-neon", providerId: "acp-antigravity-acp", at: 1_000,
    });
    expect(title).toContain("Контекст (использовано): 15813");
    expect(title).toContain("Окно контекста: 1048576");
    expect(title).toContain("Эффективная скорость: недоступна — провайдер не сообщает outputTokens");
  });
});