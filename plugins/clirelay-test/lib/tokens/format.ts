import type { ThreadUsage, TurnUsage } from "./contract";
import { DEFAULT_TOKENS_DISPLAY, type BadgeFields, type ThreadFields } from "./display";

// Текст бейджа и строки треда строится по галочкам вкладки «Настройки»;
// дефолты совпадают с прежним видом token-meter.

/** Бейджу хватает usage последнего вызова: части полей может не быть. */
export type TurnTextInput = Pick<TurnUsage, "input" | "cached" | "output">
  & Partial<Pick<TurnUsage, "reasoning" | "tokPerSec" | "model" | "total" | "durationMs" | "usageSource">>;
export type ThreadTextInput = Pick<ThreadUsage, "total" | "turns" | "modelContextWindow">
  & Partial<Pick<ThreadUsage, "averageTokPerSec" | "currentTokPerSec" | "model">>;

function trimDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

function formatRate(value: number): string {
  return value >= 100 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
}

function formatDuration(durationMs: number): string {
  return `${trimDecimal(durationMs / 1_000)} с`;
}

export function formatCompact(value: number): string {
  if (value < 1_000) return String(Math.round(value));
  const units = ["k", "M", "B"] as const;
  let scaled = value / 1_000;
  let unit = 0;
  while (unit < units.length - 1 && Number(scaled.toFixed(1)) >= 1_000) {
    scaled /= 1_000;
    unit += 1;
  }
  return trimDecimal(scaled) + units[unit];
}

const plural = new Intl.PluralRules("ru");

/** «1 ход», «2 хода», «5 ходов» — склонение берёт Intl, свой алгоритм не нужен. */
function formatTurns(turns: number): string {
  const word = plural.select(turns) === "one" ? "ход" : plural.select(turns) === "few" ? "хода" : "ходов";
  return `${turns} ${word}`;
}

/** Текст бейджа; пустая строка — показывать нечего. */
export function formatTurnText(
  usage: TurnTextInput,
  fields: BadgeFields = DEFAULT_TOKENS_DISPLAY.badge.fields,
): string {
  if (usage.usageSource === "contextWindow") {
    const segments: string[] = [];
    if (fields.input || fields.output || fields.cache) {
      segments.push(`контекст ${formatCompact(usage.total ?? 0)}`);
    }
    if (fields.speed && usage.durationMs != null && usage.durationMs > 0) {
      segments.push(formatDuration(usage.durationMs));
    }
    if (fields.model && usage.model) segments.push(usage.model);
    return segments.join(" · ");
  }
  const segments: string[] = [];
  const arrows = [
    ...(fields.input ? [`↑${formatCompact(usage.input)}`] : []),
    ...(fields.output ? [`↓${formatCompact(usage.output)}`] : []),
  ];
  if (arrows.length > 0) segments.push(arrows.join(" "));
  if (fields.cache) segments.push(`cache ${formatCompact(usage.cached)}`);
  if (fields.reasoning && usage.reasoning !== undefined) segments.push(`reasoning ${formatCompact(usage.reasoning)}`);
  if (fields.speed && usage.tokPerSec !== undefined) segments.push(`${formatRate(usage.tokPerSec)} ток/с (эфф.)`);
  if (fields.model && usage.model) segments.push(usage.model);
  return segments.join(" · ");
}

/** Title бейджа — полные числа и объяснения; от галочек не зависит. */
export function formatTurnTitle(usage: TurnUsage): string {
  const durations = [
    `Последний вызов: ${usage.durationMs == null ? "недоступна" : formatDuration(usage.durationMs)}`,
    ...(usage.turnDurationMs === undefined ? [] : [`Весь ход: ${formatDuration(usage.turnDurationMs)}`]),
  ].join(" · ");
  if (usage.usageSource === "contextWindow") {
    return [
      ...(usage.model ? [`Модель: ${usage.model}`] : []),
      `Контекст (использовано): ${usage.total}`,
      ...(usage.modelContextWindow != null ? [`Окно контекста: ${usage.modelContextWindow}`] : []),
      "Разбивка вход/выход/кеш: не сообщается провайдером",
      durations,
      "Эффективная скорость: недоступна — провайдер не сообщает outputTokens",
    ].join("\n");
  }
  return [
    ...(usage.model ? [`Модель: ${usage.model}`] : []),
    `Вход: ${usage.input}`,
    `Кеш: ${usage.cached}`,
    `Кеш чтение: ${usage.cacheRead ?? "не сообщено"}`,
    `Кеш запись: ${usage.cacheWrite ?? "не сообщено"}`,
    `Выход: ${usage.output}`,
    `Reasoning: ${usage.reasoning}`,
    `Всего за вызов: ${usage.total}`,
    durations,
    `Эффективная скорость последнего вызова: ${usage.tokPerSec === undefined ? "недоступна" : `${formatRate(usage.tokPerSec)} ток/с — выход ÷ время от конца последнего инструмента до конца хода; включает ожидание первого токена (обработка контекста, очередь, скрытое рассуждение)`}`,
  ].join("\n");
}

/** Текст сводки треда; пустая строка — показывать нечего. */
export function formatThreadText(
  usage: ThreadTextInput,
  fields: ThreadFields = DEFAULT_TOKENS_DISPLAY.thread.fields,
): string {
  const segments: string[] = [];
  if (fields.total) segments.push(`Σ ${formatCompact(usage.total)} токенов`);
  if (fields.speed && usage.averageTokPerSec !== undefined) segments.push(`~${formatRate(usage.averageTokPerSec)} ток/с (эфф.)`);
  if (fields.speed && usage.currentTokPerSec !== undefined) segments.push(`шаг ${formatRate(usage.currentTokPerSec)} ток/с`);
  if (fields.model && usage.model) segments.push(usage.model);
  if (fields.turns) segments.push(formatTurns(usage.turns));
  if (fields.contextWindow && usage.modelContextWindow !== null) segments.push(`окно ${formatCompact(usage.modelContextWindow)}`);
  return segments.join(" · ");
}