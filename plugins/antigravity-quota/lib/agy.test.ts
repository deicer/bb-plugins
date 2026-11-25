import assert from "node:assert/strict";
import { test } from "node:test";
import { isAntigravityProviderId, parseAgyQuotaOutput } from "./agy.ts";

test("detects Antigravity provider IDs", () => {
  assert.equal(isAntigravityProviderId("acp-antigravity-acp"), true);
  assert.equal(isAntigravityProviderId("antigravity"), true);
  assert.equal(isAntigravityProviderId("codex"), false);
  assert.equal(isAntigravityProviderId(null), false);
});

test("parses high-precision remaining_fraction and hides untouched reset_time", () => {
  const raw = JSON.stringify({
    status: "SUCCESS",
    command: {
      name: "usage",
      data: {
        groups: [
          {
            name: "Claude and GPT models",
            buckets: [
              { id: "3p-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 1, reset_time: "2026-12-02T10:00:00Z" },
            ],
          },
          {
            name: "Gemini Models",
            buckets: [
              { id: "gemini-5h", name: "Five Hour Limit Remaining", description: "Used.", window: "5h", remaining_fraction: 0.95814669, reset_time: "2026-11-25T18:00:00Z" },
              { id: "gemini-weekly", name: "Weekly Limit Remaining", description: "Used.", window: "weekly", remaining_fraction: 0.97998095, reset_time: "2026-12-02T10:00:00Z" },
            ],
          },
        ],
      },
    },
  });

  const parsed = parseAgyQuotaOutput(raw, 1_700_000_000_000);
  assert.equal(parsed.status, "ok");
  assert.equal(parsed.buckets.length, 3);
  assert.equal(parsed.buckets[0]!.group, "Gemini Models");
  assert.equal(parsed.buckets[0]!.usedPct, 4.1853);
  assert.equal(parsed.buckets[0]!.remainingPct, 95.8147);
  assert.equal(parsed.buckets[0]!.resetTime, "2026-11-25T18:00:00Z");

  const untouched = parsed.buckets.find((b) => b.id === "3p-weekly")!;
  assert.equal(untouched.usedPct, 0);
  assert.equal(untouched.resetTime, null);
});
