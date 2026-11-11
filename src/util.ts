import type { Env } from "./env";

/** Error carrying a stable machine code plus a human readable detail. */
export class AppError extends Error {
  constructor(
    public code: string,
    public detail: string,
    public status?: number,
  ) {
    super(`${code}: ${detail}`);
  }
}

const SECRET_KEYS = ["ELEVENLABS_API_KEY", "MCP_TOKEN", "GITHUB_TOKEN", "GITHUB_REPO", "APP_PASSWORD"] as const;

/** Removes every configured secret value (and anything that looks like a credential) from a string. */
export function redact(env: Env | undefined, input: unknown): string {
  let s = typeof input === "string" ? input : String(input);
  if (env) {
    for (const k of SECRET_KEYS) {
      const v = env[k];
      if (typeof v === "string" && v.length >= 4) s = s.split(v).join("[redacted]");
    }
  }
  return s
    .replace(/\b(sk_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[redacted]")
    .replace(/(Bearer|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [redacted]");
}

export function toErrorPayload(env: Env | undefined, e: unknown): { error: string; detail: string } {
  if (e instanceof AppError) return { error: e.code, detail: redact(env, e.detail).slice(0, 800) };
  const msg = e instanceof Error ? e.message : String(e);
  return { error: "internal_error", detail: redact(env, msg).slice(0, 800) };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const enc = new TextEncoder();

export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison (compares digests so length is not leaked either). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function b64decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64encode(bytes: Uint8Array): string {
  let bin = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step) as unknown as number[]);
  }
  return btoa(bin);
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Number of characters as billed (Unicode code points). */
export function charCount(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

export const round3 = (n: number) => Math.round(n * 1000) / 1000;
export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Runs `worker` over `items` with at most `limit` in flight. `worker` may return false to stop scheduling. */
export async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<boolean | void>): Promise<void> {
  let next = 0;
  let stop = false;
  const run = async () => {
    while (!stop && next < items.length) {
      const item = items[next++];
      if ((await worker(item)) === false) stop = true;
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function monthKey(d = new Date()): string {
  return d.toISOString().slice(0, 7);
}
