import assert from "node:assert/strict";
import { test } from "node:test";
import { detectWindowKind, parseTooltipSummary } from "./popover-anchor.ts";

test("detects localized and English 5h/weekly window labels", () => {
  assert.equal(detectWindowKind("5 часов"), "5h");
  assert.equal(detectWindowKind("5h"), "5h");
  assert.equal(detectWindowKind("Five-hour limit"), "5h");
  assert.equal(detectWindowKind("Неделя"), "weekly");
  assert.equal(detectWindowKind("Weekly limit"), "weekly");
  assert.equal(detectWindowKind("7d"), "weekly");
  assert.equal(detectWindowKind("Daily"), null);
});

test("parses group and window kind from Antigravity tooltip summary line", () => {
  assert.deepEqual(
    parseTooltipSummary("Gemini Models · 5 часов — осталось 66%"),
    { group: "Gemini Models", window: "5h" },
  );
  assert.deepEqual(
    parseTooltipSummary("Gemini Models · Неделя — осталось 70%"),
    { group: "Gemini Models", window: "weekly" },
  );
  assert.equal(parseTooltipSummary("Лимит недоступен"), null);
});
