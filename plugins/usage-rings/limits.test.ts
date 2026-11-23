import assert from "node:assert/strict";
import { test } from "node:test";
import { groupWindows, orderedProviders, remainingPercent, selectWindow } from "./limits.ts";

const weekly = { label: "Weekly limit", usedPercent: 99, resetsAt: null };
const fiveHour = { label: "Five-hour limit", usedPercent: 30, resetsAt: null };

test("5-hour quota wins over a lower weekly remainder, including zero", () => {
  assert.equal(selectWindow([weekly, fiveHour]), fiveHour);
  assert.equal(remainingPercent(selectWindow([weekly, fiveHour])!), 70);
  const exhausted = { ...fiveHour, usedPercent: 100 };
  assert.equal(selectWindow([weekly, exhausted]), exhausted);
});

test("weekly is used only when no 5-hour window exists", () => {
  assert.equal(selectWindow([weekly]), weekly);
  assert.equal(selectWindow([{ ...fiveHour, label: "Daily limit" }]), null);
  assert.equal(selectWindow([]), null);
  assert.equal(selectWindow([{ ...fiveHour, label: "5 hours" }])?.usedPercent, 30);
  assert.equal(selectWindow([{ ...fiveHour, label: "5h · 100% left" }])?.usedPercent, 30);
  assert.equal(selectWindow([{ ...weekly, label: "7d · 100% left" }])?.usedPercent, 99);
  const sonnet = { ...weekly, label: "Weekly · Sonnet", usedPercent: 100 };
  assert.equal(selectWindow([sonnet, weekly]), weekly);
});

test("percentages stay within 0–100", () => {
  assert.equal(remainingPercent({ ...fiveHour, usedPercent: 101 }), 0);
  assert.equal(remainingPercent({ ...fiveHour, usedPercent: -1 }), 100);
  assert.equal(remainingPercent({ ...fiveHour, usedPercent: 10.6 }), 89);
});

test("saved ordering survives disappearing providers and adds new ones last", () => {
  const preferences = [{ id: "claude", enabled: false }, { id: "removed", enabled: true }, { id: "codex", enabled: true }];
  assert.deepEqual(orderedProviders([{ id: "codex" }, { id: "new" }, { id: "claude" }], preferences).map(p => p.id), ["claude", "codex", "new"]);
});


test("a model-specific 5-hour window also takes priority over weekly", () => {
  const modelWindow = { ...fiveHour, label: "Five-hour limit · Sonnet" };
  assert.equal(selectWindow([weekly, modelWindow]), modelWindow);
});

test("grouped Antigravity windows prioritize Gemini Models 5h or weekly over other model groups", () => {
  const geminiWeekly = { group: "Gemini Models", label: "Weekly limit", usedPercent: 12, resetsAt: "2026-11-27T17:12:23Z" };
  const gemini5h = { group: "Gemini Models", label: "Five-hour limit", usedPercent: 4, resetsAt: "2026-11-20T22:12:23Z" };
  const claude5h = { group: "Claude and GPT models", label: "Five-hour limit", usedPercent: 50, resetsAt: "2026-11-20T22:12:23Z" };
  const argonWeekly = { group: "Gemini 4 Argon", label: "Weekly limit", usedPercent: 0, resetsAt: null };

  assert.equal(selectWindow([claude5h, geminiWeekly, gemini5h, argonWeekly]), gemini5h);
  assert.equal(selectWindow([claude5h, geminiWeekly, argonWeekly]), geminiWeekly);

  const grouped = groupWindows([geminiWeekly, gemini5h, claude5h, argonWeekly]);
  assert.deepEqual(grouped.map(g => [g.name, g.windows.length]), [
    ["Gemini Models", 2],
    ["Claude and GPT models", 1],
    ["Gemini 4 Argon", 1],
  ]);
});
