export interface UsageWindow {
  label: string;
  usedPercent: number;
  resetsAt: string | null;
  group?: string | null;
}

export interface WindowGroup {
  name: string | null;
  windows: UsageWindow[];
}

export interface ProviderPreference {
  id: string;
  enabled: boolean;
}

function pickWindow(windows: readonly UsageWindow[]): UsageWindow | null {
  return windows.find(w => /^(Five-hour limit|5 hours?|5h)$/i.test(w.label))
    ?? windows.find(w => /^(Five-hour limit|5 hours?|5h)\s*[·:-].+$/i.test(w.label))
    ?? windows.find(w => /^(Weekly limit|Weekly|7d)$/i.test(w.label))
    ?? windows.find(w => /^(Weekly|7d)\s*[·:-].+$/i.test(w.label))
    ?? null;
}

export function selectWindow(windows: readonly UsageWindow[]): UsageWindow | null {
  const gemini = windows.filter(w => w.group && /^Gemini Models$/i.test(w.group));
  if (gemini.length > 0) return pickWindow(gemini) ?? pickWindow(windows);
  return pickWindow(windows);
}

export function groupWindows(windows: readonly UsageWindow[]): WindowGroup[] {
  const groups: WindowGroup[] = [];
  const byName = new Map<string | null, WindowGroup>();
  for (const window of windows) {
    const name = window.group ?? null;
    let entry = byName.get(name);
    if (!entry) {
      entry = { name, windows: [] };
      byName.set(name, entry);
      groups.push(entry);
    }
    entry.windows.push(window);
  }
  return groups;
}

export function remainingPercent(window: UsageWindow): number {
  return Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent)));
}

export function orderedProviders<T extends { id: string }>(providers: readonly T[], preferences: readonly ProviderPreference[]): T[] {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const ordered = preferences.flatMap(({ id }) => {
    const provider = byId.get(id);
    byId.delete(id);
    return provider ? [provider] : [];
  });
  return [...ordered, ...byId.values()];
}
