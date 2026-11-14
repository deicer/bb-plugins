import { z } from "zod";
import { DiscoverError } from "./discover";

// Management-доступ clirelay: логин админки → Bearer access_token (+ refresh-ротация).
const sessionSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  expires_at: z.string().optional(),
  refresh_expires_at: z.string().optional(),
});
export type RelaySession = z.infer<typeof sessionSchema>;

export interface RelayCredentials { username: string; password: string }

async function postJson(url: string, body: unknown, fetchImpl: typeof fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (cause) {
    if (cause instanceof Error && cause.name === "AbortError") throw new DiscoverError("таймаут 10с: relay не ответил");
    throw new DiscoverError("не удалось соединиться с relay");
  }
  if (response.status === 401 || response.status === 403) throw new DiscoverError("management-доступ отклонён: проверь логин и пароль");
  if (!response.ok) throw new DiscoverError(`relay ответил HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new DiscoverError("relay вернул не JSON");
  }
}

function parseSession(body: unknown): RelaySession {
  const parsed = sessionSchema.safeParse(body);
  if (!parsed.success) throw new DiscoverError("неожиданный формат ответа auth");
  return parsed.data;
}

export async function loginRelay(origin: string, creds: RelayCredentials, fetchImpl: typeof fetch = fetch): Promise<RelaySession> {
  return parseSession(await postJson(`${origin}/v0/auth/login`, { username: creds.username, password: creds.password, remember_me: true }, fetchImpl));
}

export async function refreshRelay(origin: string, refreshToken: string, fetchImpl: typeof fetch = fetch): Promise<RelaySession> {
  return parseSession(await postJson(`${origin}/v0/auth/refresh`, { refresh_token: refreshToken }, fetchImpl));
}

const MARGIN_MS = 60_000;

export function sessionFresh(session: RelaySession, now: number = Date.now()): boolean {
  if (!session.expires_at) return true;
  const at = new Date(session.expires_at).getTime();
  return Number.isFinite(at) && at - now > MARGIN_MS;
}

export function refreshUsable(session: RelaySession, now: number = Date.now()): boolean {
  if (!session.refresh_token) return false;
  if (!session.refresh_expires_at) return true;
  const at = new Date(session.refresh_expires_at).getTime();
  return Number.isFinite(at) && at - now > MARGIN_MS;
}

export interface TokenCache {
  get(): Promise<RelaySession | null>;
  set(session: RelaySession): Promise<void>;
}

// Кэш сессии живёт только на сервере плагина (kv); фронтенд токенов не видит.
export async function getManagementToken(opts: {
  origin: string;
  creds: RelayCredentials;
  cache: TokenCache;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const cached = await opts.cache.get();
  if (cached && sessionFresh(cached)) return cached.access_token;
  if (cached && refreshUsable(cached)) {
    try {
      const next = await refreshRelay(opts.origin, cached.refresh_token!, fetchImpl);
      await opts.cache.set(next);
      return next.access_token;
    } catch {
      /* refresh умер — логинимся заново */
    }
  }
  const session = await loginRelay(opts.origin, opts.creds, fetchImpl);
  await opts.cache.set(session);
  return session.access_token;
}
