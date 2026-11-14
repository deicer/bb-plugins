// Семейство модели по id — для группировки списков в панели.
const FAMILIES: Array<[RegExp, string]> = [
  [/^claude/, "Claude"],
  [/^(gpt|chatgpt|o[134]|codex)/, "GPT"],
  [/^gemini/, "Gemini"],
  [/^qwen/, "Qwen"],
  [/^(kimi|moonshot)/, "Kimi"],
  [/^deepseek/, "DeepSeek"],
  [/^grok/, "Grok"],
  [/^llama/, "Llama"],
  [/^(mistral|mixtral)/, "Mistral"],
];

export function modelFamily(id: string): string {
  const lower = id.toLowerCase();
  for (const [pattern, family] of FAMILIES) {
    if (pattern.test(lower)) return family;
  }
  return "Другие";
}

export function groupByFamily<T extends { id: string }>(items: T[]): Array<{ family: string; items: T[] }> {
  const groups: Array<{ family: string; items: T[] }> = [];
  const byFamily = new Map<string, { family: string; items: T[] }>();
  for (const item of items) {
    const family = modelFamily(item.id);
    let group = byFamily.get(family);
    if (!group) {
      group = { family, items: [] };
      byFamily.set(family, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}
