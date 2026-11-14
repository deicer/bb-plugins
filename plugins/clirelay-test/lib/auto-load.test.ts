import { describe, expect, it } from "vitest";
import { shouldAutoLoad } from "./auto-load";

describe("shouldAutoLoad", () => {
  const base = { open: true, loaded: false, busy: false, error: null };
  it("грузит один раз при раскрытии", () => {
    expect(shouldAutoLoad(base)).toBe(true);
  });
  it("после ошибки сам не ретраит (регрессия бесконечного цикла)", () => {
    expect(shouldAutoLoad({ ...base, error: "не удалось соединиться" })).toBe(false);
  });
  it("не грузит когда закрыто, загружено или занято", () => {
    expect(shouldAutoLoad({ ...base, open: false })).toBe(false);
    expect(shouldAutoLoad({ ...base, loaded: true })).toBe(false);
    expect(shouldAutoLoad({ ...base, busy: true })).toBe(false);
  });
});
