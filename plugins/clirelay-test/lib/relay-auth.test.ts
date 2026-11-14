import { describe, expect, it, vi } from "vitest";
import { DiscoverError } from "./discover";
import { getManagementToken, loginRelay, refreshUsable, sessionFresh, type RelaySession } from "./relay-auth";

const SESSION: RelaySession = {
  access_token: "test-access",
  refresh_token: "test-refresh",
  expires_at: new Date(Date.now() + 3600_000).toISOString(),
  refresh_expires_at: new Date(Date.now() + 86400_000).toISOString(),
};

const json = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });

function memoryCache(initial: RelaySession | null = null) {
  let value = initial;
  return {
    get: async () => value,
    set: async (session: RelaySession) => { value = session; },
    peek: () => value,
  };
}

describe("loginRelay", () => {
  it("шлёт username/password/remember_me и парсит сессию", async () => {
    const fetchImpl = vi.fn(json(SESSION));
    const session = await loginRelay("http://localhost:4010", { username: "admin", password: "test-pass" }, fetchImpl);
    expect(session.access_token).toBe("test-access");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:4010/v0/auth/login");
    expect(JSON.parse(String(init.body))).toEqual({ username: "admin", password: "test-pass", remember_me: true });
  });
  it("401 → понятная ошибка без URL и пароля", async () => {
    const error = await loginRelay("http://localhost:4010", { username: "admin", password: "test-pass" }, json({ error: "bad" }, 401)).then(
      () => { throw new Error("ожидалась ошибка"); },
      (cause: Error) => cause,
    );
    expect(error).toBeInstanceOf(DiscoverError);
    expect(error.message).toContain("логин и пароль");
    expect(error.message).not.toContain("localhost");
    expect(error.message).not.toContain("test-pass");
  });
});

describe("свежесть сессии", () => {
  it("margin 60с и отсутствие expires_at", () => {
    expect(sessionFresh(SESSION)).toBe(true);
    expect(sessionFresh({ ...SESSION, expires_at: new Date(Date.now() + 30_000).toISOString() })).toBe(false);
    expect(sessionFresh({ access_token: "x" })).toBe(true);
    expect(refreshUsable(SESSION)).toBe(true);
    expect(refreshUsable({ access_token: "x" })).toBe(false);
    expect(refreshUsable({ ...SESSION, refresh_expires_at: new Date(Date.now() + 1000).toISOString() })).toBe(false);
  });
});

describe("getManagementToken", () => {
  it("свежий кэш → без запросов", async () => {
    const fetchImpl = vi.fn(json(SESSION));
    const cache = memoryCache(SESSION);
    expect(await getManagementToken({ origin: "http://localhost:4010", creds: { username: "u", password: "p" }, cache, fetchImpl })).toBe("test-access");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("протухший access + живой refresh → refresh и обновление кэша", async () => {
    const expired = { ...SESSION, access_token: "old", expires_at: new Date(Date.now() - 1000).toISOString() };
    const rotated = { ...SESSION, access_token: "rotated" };
    const fetchImpl = vi.fn(json(rotated));
    const cache = memoryCache(expired);
    expect(await getManagementToken({ origin: "http://localhost:4010", creds: { username: "u", password: "p" }, cache, fetchImpl })).toBe("rotated");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:4010/v0/auth/refresh");
    expect(JSON.parse(String(init.body))).toEqual({ refresh_token: "test-refresh" });
    expect(cache.peek()?.access_token).toBe("rotated");
  });
  it("мёртвый refresh → повторный логин", async () => {
    const expired = { ...SESSION, expires_at: new Date(Date.now() - 1000).toISOString(), refresh_expires_at: new Date(Date.now() - 1000).toISOString() };
    const fetchImpl = vi.fn(json(SESSION));
    const cache = memoryCache(expired);
    expect(await getManagementToken({ origin: "http://localhost:4010", creds: { username: "u", password: "p" }, cache, fetchImpl })).toBe("test-access");
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("http://localhost:4010/v0/auth/login");
  });
  it("пустой кэш → логин", async () => {
    const fetchImpl = vi.fn(json(SESSION));
    const cache = memoryCache(null);
    expect(await getManagementToken({ origin: "http://localhost:4010", creds: { username: "u", password: "p" }, cache, fetchImpl })).toBe("test-access");
    expect(cache.peek()?.access_token).toBe("test-access");
  });
});
