import { describe, expect, it } from "vitest";
import { quotaLabel } from "./quota-labels";

describe("quotaLabel", () => {
  it("ключи relay → русские лейблы", () => {
    expect(quotaLabel({ quota_key: "m_quota.code_5h" })).toBe("Код · 5 ч");
    expect(quotaLabel({ quota_key: "m_quota.code_weekly" })).toBe("Код · неделя");
    expect(quotaLabel({ quota_key: "m_quota.code_daily" })).toBe("Код · день");
    expect(quotaLabel({ quota_key: "m_quota.code_monthly" })).toBe("Код · месяц");
  });
  it("английские label → русские", () => {
    expect(quotaLabel({ quota_key: "x", quota_label: "5-hour limit" })).toBe("Лимит 5 ч");
    expect(quotaLabel({ quota_key: "x", quota_label: "7-day limit" })).toBe("Лимит 7 дн");
    expect(quotaLabel({ quota_key: "x", quota_label: "7-day Fable" })).toBe("7 дн · Fable");
    expect(quotaLabel({ quota_key: "x", quota_label: "Gemini Models" })).toBe("Модели Gemini");
    expect(quotaLabel({ quota_key: "x", quota_label: "Claude and GPT models" })).toBe("Модели Claude и GPT");
  });
  it("составные ключи claude/xai → читаемый русский", () => {
    expect(quotaLabel({ quota_key: "claude_five_hour" })).toBe("Claude · 5 ч");
    expect(quotaLabel({ quota_key: "claude_seven_day" })).toBe("Claude · 7 дн");
    expect(quotaLabel({ quota_key: "claude_model_weekly::fable" })).toBe("Claude · модели · неделя · Fable");
    expect(quotaLabel({ quota_key: "xai_pay_as_you_go_label" })).toBe("Xai · оплата по факту · тариф");
    expect(quotaLabel({ quota_key: "xai_month_credits" })).toBe("Xai · месяц · кредиты");
  });
  it("label-как-ключ разбирается как ключ", () => {
    expect(quotaLabel({ quota_key: "m_quota.code_weekly", quota_label: "m_quota.code_weekly" })).toBe("Код · неделя");
    expect(quotaLabel({ quota_key: "x", quota_label: "m_quota.code_5h" })).toBe("Код · 5 ч");
  });
  it("неизвестный label сохраняется, неизвестный ключ причёсывается", () => {
    expect(quotaLabel({ quota_key: "x", quota_label: "Custom Quota" })).toBe("Custom Quota");
    expect(quotaLabel({ quota_key: "session_limit" })).toBe("Session · лимит");
    expect(quotaLabel({ quota_key: "" })).toBe("");
  });
});
