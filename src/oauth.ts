/**
 * Minimal OAuth 2.1 authorization server for the MCP endpoint, so Claude's connector can sign in
 * (dynamic client registration + authorization code with PKCE + refresh tokens).
 * The owner approves a connection by typing APP_PASSWORD on the consent page.
 *
 * Everything is stateless: client ids, codes and tokens are HMAC-signed blobs, so nothing depends on
 * storage consistency. Changing MCP_TOKEN or APP_PASSWORD invalidates every issued token.
 */
import type { Env } from "./env";
import { hmacHex, json, safeEqual, sleep } from "./util";

const ACCESS_TTL = 24 * 3600;
const REFRESH_TTL = 180 * 24 * 3600;
const CODE_TTL = 300;

type Kind = "client" | "code" | "access" | "refresh";
interface Claims {
  k: Kind;
  exp?: number;
  [key: string]: unknown;
}

const b64u = {
  enc: (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  dec: (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))),
};

function configured(env: Env): boolean {
  return !!(env.MCP_TOKEN && env.APP_PASSWORD);
}

const signingKey = (env: Env) => `oauth:${env.MCP_TOKEN}:${env.APP_PASSWORD}`;

async function seal(env: Env, claims: Claims): Promise<string> {
  const body = b64u.enc(JSON.stringify(claims));
  return `sa1.${body}.${await hmacHex(signingKey(env), body)}`;
}

async function open(env: Env, token: string, kind: Kind): Promise<Claims | null> {
  const m = /^sa1\.([A-Za-z0-9_-]+)\.([0-9a-f]{64})$/.exec(token);
  if (!m || !(await safeEqual(m[2], await hmacHex(signingKey(env), m[1])))) return null;
  try {
    const c = JSON.parse(b64u.dec(m[1])) as Claims;
    if (c.k !== kind) return null;
    if (c.exp !== undefined && c.exp < Date.now() / 1000) return null;
    return c;
  } catch {
    return null;
  }
}

/** True when `token` is an access token issued by this server. */
export async function validAccessToken(env: Env, token: string): Promise<boolean> {
  return configured(env) && (await open(env, token, "access")) !== null;
}

export function challengeHeader(origin: string): string {
  return `Bearer realm="ses-atolyesi", resource_metadata="${origin}/.well-known/oauth-protected-resource"`;
}

const now = () => Math.floor(Date.now() / 1000);
const oauthError = (error: string, description: string, status = 400) => json({ error, error_description: description }, status);

function validRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    return u.protocol === "https:" || (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"));
  } catch {
    return false;
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const FIELDS = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope", "resource"] as const;

function consentPage(params: URLSearchParams, clientName: string, error: boolean): Response {
  const hidden = FIELDS.map((f) => (params.has(f) ? `<input type="hidden" name="${f}" value="${esc(params.get(f)!)}">` : "")).join("");
  const body = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ses Atölyesi — Bağlantı izni</title><link rel="stylesheet" href="/app.css"></head><body><main class="login">
<h1>Ses Atölyesi</h1>
<p><strong>${esc(clientName)}</strong> bu sunucuya bağlanmak ve sizin adınıza ses üretmek istiyor. İzin vermek için panel parolanızı girin.</p>
<form method="post" action="/authorize">${hidden}
<label for="p">Parola</label>
<input id="p" name="password" type="password" autocomplete="current-password" autofocus required>
${error ? '<p class="err" role="alert">Parola hatalı.</p>' : ""}
<button type="submit">İzin ver</button>
</form></main></body></html>`;
  return new Response(body, {
    status: error ? 401 : 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      // no form-action here: the form post ends in a redirect to the client's callback
      "content-security-policy": "default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

/** Handles the OAuth endpoints; returns null for any other path. */
export async function handleOAuth(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const origin = url.origin;
  const path = url.pathname;
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization, mcp-protocol-version" };

  const isMeta = path.startsWith("/.well-known/oauth-");
  const isEndpoint = path === "/register" || path === "/authorize" || path === "/token";
  if (!isMeta && !isEndpoint) return null;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, "access-control-allow-methods": "GET, POST, OPTIONS" } });

  if (path.startsWith("/.well-known/oauth-protected-resource")) {
    return json({ resource: `${origin}/mcp`, authorization_servers: [origin], bearer_methods_supported: ["header"] }, 200, cors);
  }
  if (path.startsWith("/.well-known/oauth-authorization-server")) {
    return json(
      {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      },
      200,
      cors,
    );
  }
  if (!configured(env)) return oauthError("server_error", "MCP_TOKEN and APP_PASSWORD must be set on the server", 503);

  // ---- dynamic client registration (RFC 7591)
  if (path === "/register" && request.method === "POST") {
    const b = (await request.json().catch(() => null)) as { redirect_uris?: unknown; client_name?: unknown } | null;
    const uris = Array.isArray(b?.redirect_uris) ? (b!.redirect_uris as unknown[]).filter((u): u is string => typeof u === "string") : [];
    if (!uris.length || uris.length > 10 || !uris.every(validRedirect)) return oauthError("invalid_redirect_uri", "redirect_uris must be https URLs");
    const name = typeof b?.client_name === "string" ? b.client_name.slice(0, 80) : "MCP client";
    const client_id = await seal(env, { k: "client", r: uris, n: name });
    return json(
      { client_id, client_name: name, redirect_uris: uris, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", client_id_issued_at: now() },
      201,
      cors,
    );
  }

  // ---- authorization endpoint (consent page protected by APP_PASSWORD)
  if (path === "/authorize" && (request.method === "GET" || request.method === "POST")) {
    const form = request.method === "POST" ? await request.formData().catch(() => null) : null;
    const params = form ? new URLSearchParams([...form.entries()].filter(([, v]) => typeof v === "string") as [string, string][]) : url.searchParams;
    const client = await open(env, params.get("client_id") ?? "", "client");
    const redirect = params.get("redirect_uri") ?? "";
    // Never redirect to an unregistered URI: show the problem instead.
    if (!client) return oauthError("invalid_client", "unknown client_id; register again");
    if (!(client.r as string[]).includes(redirect)) return oauthError("invalid_request", "redirect_uri is not registered for this client");
    const back = (q: Record<string, string>) => {
      const u = new URL(redirect);
      for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
      if (params.get("state")) u.searchParams.set("state", params.get("state")!);
      return new Response(null, { status: 302, headers: { location: u.toString(), "cache-control": "no-store" } });
    };
    if (params.get("response_type") !== "code") return back({ error: "unsupported_response_type" });
    const challenge = params.get("code_challenge") ?? "";
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge) || (params.get("code_challenge_method") ?? "S256") !== "S256") {
      return back({ error: "invalid_request", error_description: "PKCE with S256 is required" });
    }
    if (!form) return consentPage(params, String(client.n), false);
    if (!(await safeEqual(String(form.get("password") ?? ""), env.APP_PASSWORD))) {
      await sleep(600);
      return consentPage(params, String(client.n), true);
    }
    const code = await seal(env, { k: "code", c: params.get("client_id"), r: redirect, p: challenge, exp: now() + CODE_TTL });
    return back({ code });
  }

  // ---- token endpoint
  if (path === "/token" && request.method === "POST") {
    const f = await request.formData().catch(() => null);
    const get = (k: string) => (typeof f?.get(k) === "string" ? (f!.get(k) as string) : "");
    const issue = async (clientId: string) =>
      json(
        {
          access_token: await seal(env, { k: "access", c: clientId, exp: now() + ACCESS_TTL }),
          token_type: "Bearer",
          expires_in: ACCESS_TTL,
          refresh_token: await seal(env, { k: "refresh", c: clientId, exp: now() + REFRESH_TTL }),
        },
        200,
        { ...cors, pragma: "no-cache" },
      );
    if (get("grant_type") === "authorization_code") {
      const code = await open(env, get("code"), "code");
      if (!code) return oauthError("invalid_grant", "code is invalid or expired");
      if (code.c !== get("client_id") || code.r !== get("redirect_uri")) return oauthError("invalid_grant", "client_id or redirect_uri mismatch");
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(get("code_verifier")));
      const expected = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      if (!(await safeEqual(expected, String(code.p)))) return oauthError("invalid_grant", "PKCE verification failed");
      return issue(String(code.c));
    }
    if (get("grant_type") === "refresh_token") {
      const r = await open(env, get("refresh_token"), "refresh");
      if (!r || (get("client_id") && r.c !== get("client_id"))) return oauthError("invalid_grant", "refresh token is invalid or expired");
      return issue(String(r.c));
    }
    return oauthError("unsupported_grant_type", "use authorization_code or refresh_token");
  }
  return oauthError("invalid_request", "unsupported method", 405);
}
