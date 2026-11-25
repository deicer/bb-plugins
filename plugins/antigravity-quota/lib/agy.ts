import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { hostSnapshotSchema, type BucketSnapshot, type HostSnapshot } from "./contract.ts";

const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const TIMEOUT_MS = 25_000;
const AGY_ARGS = ["--print", "/usage", "--output-format", "json", "--print-timeout", "20s"] as const;

const agyBucketSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  window: z.string().optional(),
  remaining_fraction: z.number().finite(),
  reset_time: z.string().nullable().optional(),
});

const agyGroupSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  buckets: z.array(agyBucketSchema),
});

const agyOutputSchema = z.object({
  status: z.string(),
  response: z.string().optional(),
  error: z.string().optional(),
  command: z.object({
    name: z.string(),
    data: z.object({
      groups: z.array(agyGroupSchema),
    }).optional(),
  }).optional(),
});

export function isAntigravityProviderId(providerId: string | null | undefined): boolean {
  return typeof providerId === "string" && /^(acp-)?antigravity(-acp)?$/i.test(providerId);
}

function classifyWindow(bucket: z.infer<typeof agyBucketSchema>): "5h" | "weekly" | "other" {
  if (bucket.window && /^(5h|5[- ]?hours?|five[- ]?hour)$/i.test(bucket.window)) return "5h";
  if (bucket.window && /^(weekly|7d|week)$/i.test(bucket.window)) return "weekly";
  if (/five[- ]?hour|5h/i.test(bucket.name)) return "5h";
  if (/weekly/i.test(bucket.name)) return "weekly";
  return "other";
}

function classifyFailure(text: string, observedAt: number): HostSnapshot {
  if (/session expired|token expired|re-?auth|re-?login/i.test(text)) {
    return { status: "expired", observedAt, message: "Сессия Google Antigravity истекла. Войдите снова." };
  }
  if (/not logged in|not authenticated|unauthenticated|unauthorized|sign in|log in|login required|credentials/i.test(text)) {
    return { status: "unauthenticated", observedAt, message: "Войдите в Google Antigravity и обновите данные." };
  }
  return { status: "error", observedAt, message: "Не удалось получить квоту Google Antigravity." };
}

function extractJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch { /* Fall back to scanning lines. */ }
  const lines = trimmed.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{")) continue;
    try { return JSON.parse(line); } catch { /* Keep scanning. */ }
  }
  return null;
}

export function parseAgyQuotaOutput(stdout: string, observedAt = Date.now()): HostSnapshot {
  const raw = extractJson(stdout);
  const parsed = agyOutputSchema.safeParse(raw);
  if (!parsed.success) return classifyFailure(stdout, observedAt);
  const data = parsed.data;
  if (data.status !== "SUCCESS") {
    return classifyFailure([data.error, data.response].filter(Boolean).join("\n"), observedAt);
  }
  const groups = data.command?.name === "usage" ? data.command.data?.groups : undefined;
  if (!groups) {
    return { status: "error", observedAt, message: "Antigravity CLI не вернул данные о квотах." };
  }

  const orderedGroups = [...groups].sort((a, b) => {
    const aGemini = /^Gemini Models$/i.test(a.name) ? 0 : 1;
    const bGemini = /^Gemini Models$/i.test(b.name) ? 0 : 1;
    return aGemini - bGemini;
  });

  const buckets: BucketSnapshot[] = orderedGroups.flatMap((group) =>
    group.buckets.map((bucket) => {
      const window = classifyWindow(bucket);
      const remainingFraction = Math.max(0, Math.min(1, bucket.remaining_fraction));
      const remainingPct = Number((remainingFraction * 100).toFixed(4));
      const usedPct = Number(((1 - remainingFraction) * 100).toFixed(4));
      const untouched = remainingFraction >= 1 && !bucket.description;
      const resetTime = untouched ? null : (bucket.reset_time?.trim() || null);
      const id = bucket.id?.trim() || `${group.name}::${window}`;
      const label = window === "5h" ? "5 часов" : window === "weekly" ? "Неделя" : bucket.name;
      return { id, group: group.name, window, label, remainingPct, usedPct, resetTime };
    }),
  );

  return hostSnapshotSchema.parse({ status: "ok", observedAt, buckets });
}

function killProcessTree(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }, () => {});
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill(); }
    const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }, 1000);
    timer.unref();
    child.once("close", () => clearTimeout(timer));
  }
}

export function defaultAgyCandidates(): string[] {
  const candidates = ["agy"];
  const localBin = join(homedir(), ".local", "bin", process.platform === "win32" ? "agy.exe" : "agy");
  if (existsSync(localBin)) candidates.push(localBin);
  return candidates;
}

type SpawnFn = (command: string, args: readonly string[], options: Record<string, unknown>) => ChildProcess;

interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  notFound: boolean;
  overflow: boolean;
  timedOut: boolean;
  aborted: boolean;
}

function runCandidate(command: string, signal: AbortSignal | undefined, spawnFn: SpawnFn, timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ code: null, stdout: "", stderr: "", notFound: false, overflow: false, timedOut: false, aborted: true });
      return;
    }
    const child = spawnFn(command, AGY_ARGS, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let overflow = false;
    let timedOut = false;
    let aborted = false;

    const finish = (result: ExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const onAbort = () => {
      aborted = true;
      killProcessTree(child);
      finish({ code: null, stdout, stderr, notFound: false, overflow, timedOut, aborted: true });
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
      finish({ code: null, stdout, stderr, notFound: false, overflow, timedOut: true, aborted });
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length + chunk.length > MAX_STDOUT_BYTES) {
        overflow = true;
        killProcessTree(child);
        finish({ code: null, stdout: "", stderr: "", notFound: false, overflow: true, timedOut, aborted });
        return;
      }
      stdout += chunk;
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += chunk.slice(0, MAX_STDERR_BYTES - stderr.length);
    });

    child.once("error", (error: NodeJS.ErrnoException) => {
      finish({ code: null, stdout, stderr, notFound: error.code === "ENOENT", overflow, timedOut, aborted });
    });

    child.once("close", (code) => {
      finish({ code, stdout, stderr, notFound: false, overflow, timedOut, aborted });
    });
  });
}

export async function readAgyQuota(
  signal?: AbortSignal,
  options?: { spawn?: SpawnFn; candidates?: readonly string[]; timeoutMs?: number },
): Promise<HostSnapshot> {
  const spawnFn: SpawnFn = options?.spawn ?? ((cmd, args, opts) => spawn(cmd, [...args], opts));
  const candidates = options?.candidates ?? defaultAgyCandidates();
  const timeoutMs = options?.timeoutMs ?? TIMEOUT_MS;
  const observedAt = Date.now();

  let lastNotFound = false;
  for (const command of candidates) {
    const result = await runCandidate(command, signal, spawnFn, timeoutMs);
    if (result.aborted) {
      throw signal?.reason instanceof Error ? signal.reason : new Error("Запрос квоты Google Antigravity отменён.");
    }
    if (result.notFound) { lastNotFound = true; continue; }
    if (result.overflow) return { status: "error", observedAt, message: "Ответ Antigravity CLI слишком большой." };
    if (result.timedOut) return { status: "error", observedAt, message: "Antigravity CLI не ответил вовремя." };
    if (result.code !== 0) {
      const parsed = result.stdout.trim() ? parseAgyQuotaOutput(result.stdout, observedAt) : null;
      if (parsed && parsed.status !== "error") return parsed;
      return classifyFailure(`${result.stderr}\n${result.stdout}`, observedAt);
    }
    return parseAgyQuotaOutput(result.stdout, observedAt);
  }

  if (lastNotFound) {
    return { status: "not_installed", observedAt, message: "Antigravity CLI (agy) не найден на этом компьютере." };
  }
  return { status: "error", observedAt, message: "Не удалось получить квоту Google Antigravity." };
}
