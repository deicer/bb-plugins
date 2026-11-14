// Русские лейблы квот: словарь известных label + разбор ключей relay.
const LABEL_DICT: Record<string, string> = {
  "gemini models": "Модели Gemini",
  "claude and gpt models": "Модели Claude и GPT",
};

const TOKEN_RU: Record<string, string> = {
  code: "Код",
  weekly: "неделя",
  week: "неделя",
  daily: "день",
  day: "день",
  monthly: "месяц",
  month: "месяц",
  limit: "лимит",
  five: "5",
  seven: "7",
  hour: "ч",
  model: "модели",
  credits: "кредиты",
  label: "тариф",
  payg: "оплата по факту",
};

const SKIP_TOKENS = new Set(["m", "quota"]);

// Склеиваем число и единицу: «7» + «день» → «7 дн».
const UNIT_SHORT: Record<string, string> = { "ч": "ч", "день": "дн", "неделя": "нед", "месяц": "мес" };

export function quotaLabel(quota: { quota_key: string; quota_label?: string }): string {
  const label = quota.quota_label?.trim();
  // relay иногда шлёт ключ и в quota_label — такие «лейблы» разбираем как ключи
  const labelIsKey = !!label && !/\s/.test(label) && /[._]/.test(label);
  if (label && !labelIsKey) {
    const hours = /^(\d+)-hour limit$/i.exec(label);
    if (hours) return `Лимит ${hours[1]} ч`;
    const dayLimit = /^(\d+)-day limit$/i.exec(label);
    if (dayLimit) return `Лимит ${dayLimit[1]} дн`;
    const dayNamed = /^(\d+)-day (.+)$/i.exec(label);
    if (dayNamed) return `${dayNamed[1]} дн · ${dayNamed[2]}`;
    return LABEL_DICT[label.toLowerCase()] ?? label;
  }
  const source = (labelIsKey ? label! : quota.quota_key).replace(/pay[._:-]as[._:-]you[._:-]go/gi, "payg");
  const tokens = source.toLowerCase().split(/[._\-:]+/).filter((token) => token && !SKIP_TOKENS.has(token));
  const parts: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const mapped = TOKEN_RU[token]
      ?? (/^\d+h$/.test(token) ? token.replace(/h$/, " ч") : /^\d+d$/.test(token) ? token.replace(/d$/, " дн") : token.charAt(0).toUpperCase() + token.slice(1));
    const next = tokens[i + 1] ? TOKEN_RU[tokens[i + 1]!] : undefined;
    if (/^\d+$/.test(mapped) && next && UNIT_SHORT[next]) {
      parts.push(`${mapped} ${UNIT_SHORT[next]}`);
      i++;
    } else {
      parts.push(mapped);
    }
  }
  return parts.length ? parts.join(" · ") : source;
}
