/** Monitoring panel: password login (signed cookie) + a small JSON API. */
import { ElevenLabs } from "./elevenlabs";
import type { Env } from "./env";
import { APP_CSS, APP_HTML, APP_JS, LOGIN_HTML } from "./panel-assets";
import { getSettings, listJobSummaries, monthlyUsage, putSettings } from "./store";
import { AppError, hmacHex, json, safeEqual, sleep, toErrorPayload } from "./util";

const COOKIE = "sa_session";
const SESSION_SECONDS = 7 * 24 * 3600;

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; media-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "cache-control": "no-store",
};

function html(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS, ...extra } });
}

async function sign(env: Env, exp: number): Promise<string> {
  return `${exp}.${await hmacHex(`panel:${env.APP_PASSWORD}`, String(exp))}`;
}

async function authed(request: Request, env: Env): Promise<boolean> {
  if (!env.APP_PASSWORD) return false;
  const m = (request.headers.get("cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return false;
  const exp = Number(m[1].split(".")[0]);
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  return safeEqual(m[1], await sign(env, exp));
}

/** CSRF guard for state-changing requests (the session cookie is SameSite=Strict as well). */
function sameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

export async function handlePanel(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  if (pathname === "/app.css") return new Response(APP_CSS, { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=300" } });
  if (pathname === "/app.js") return new Response(APP_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300" } });

  if (pathname === "/login" && method === "POST") {
    if (!sameOrigin(request)) return html(LOGIN_HTML(true), 403);
    const form = await request.formData().catch(() => null);
    const pw = String(form?.get("password") ?? "");
    if (!env.APP_PASSWORD || !(await safeEqual(pw, env.APP_PASSWORD))) {
      await sleep(600);
      return html(LOGIN_HTML(true), 401);
    }
    const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
    const secure = url.protocol === "https:" ? " Secure;" : "";
    return new Response(null, {
      status: 303,
      headers: { location: "/", "set-cookie": `${COOKIE}=${await sign(env, exp)}; Path=/; HttpOnly;${secure} SameSite=Strict; Max-Age=${SESSION_SECONDS}` },
    });
  }
  if (pathname === "/logout" && method === "POST") {
    return new Response(null, { status: 303, headers: { location: "/", "set-cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` } });
  }

  const ok = await authed(request, env);
  if (pathname === "/" && method === "GET") return html(ok ? APP_HTML : LOGIN_HTML(false));
  if (!pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
  if (!ok) return json({ error: "unauthorized", detail: "login required" }, 401);
  if (method !== "GET" && !sameOrigin(request)) return json({ error: "forbidden", detail: "cross-origin request" }, 403);

  try {
    if (pathname === "/api/overview" && method === "GET") {
      const [settings, usage, jobs] = await Promise.all([getSettings(env), monthlyUsage(env), listJobSummaries(env, 50)]);
      let account = null;
      let account_error = false;
      try {
        account = await new ElevenLabs(env).subscription();
      } catch {
        account_error = true;
      }
      return json({ account, account_error, settings, usage, jobs });
    }
    if (pathname === "/api/settings" && method === "PUT") {
      const b = (await request.json()) as Record<string, unknown>;
      const n = (v: unknown) => {
        const x = Number(v);
        if (!Number.isInteger(x) || x < 0 || x > 1e9) throw new AppError("invalid_input", "limits must be whole numbers >= 0");
        return x;
      };
      const s = { per_job_char_limit: n(b.per_job_char_limit), monthly_char_limit: n(b.monthly_char_limit) };
      await putSettings(env, s);
      return json(s);
    }
    const job = pathname.match(/^\/api\/jobs\/([A-Za-z0-9._-]{1,121})(\/cancel)?$/);
    if (job) {
      const stub = env.JOBS.get(env.JOBS.idFromName(job[1]));
      const view = job[2] && method === "POST" ? await stub.cancel() : !job[2] && method === "GET" ? await stub.status(true) : undefined;
      if (view === undefined) return json({ error: "method_not_allowed", detail: method }, 405);
      return view ? json(view) : json({ error: "not_found", detail: "no such job" }, 404);
    }
    const audio = pathname.match(/^\/api\/audio\/([A-Za-z0-9._-]{1,121})\/(\d{1,4})$/);
    if (audio && method === "GET") {
      const key = await env.JOBS.get(env.JOBS.idFromName(audio[1])).audioKey(Number(audio[2]));
      const obj = key ? await env.AUDIO.get(key, { range: request.headers }) : null;
      if (!obj) return json({ error: "not_found", detail: "audio not available" }, 404);
      const headers = new Headers({ "content-type": "audio/mpeg", "accept-ranges": "bytes", "cache-control": "private, max-age=3600", etag: obj.httpEtag });
      const r = obj.range as { offset?: number; length?: number } | undefined;
      if (r && request.headers.has("range") && r.offset !== undefined) {
        const len = r.length ?? obj.size - r.offset;
        headers.set("content-range", `bytes ${r.offset}-${r.offset + len - 1}/${obj.size}`);
        headers.set("content-length", String(len));
        return new Response(obj.body, { status: 206, headers });
      }
      headers.set("content-length", String(obj.size));
      return new Response(obj.body, { headers });
    }
    return json({ error: "not_found", detail: pathname }, 404);
  } catch (e) {
    const p = toErrorPayload(env, e);
    return json(p, e instanceof AppError && e.code === "invalid_input" ? 400 : 500);
  }
}
