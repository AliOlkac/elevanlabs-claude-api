/**
 * Ses Atölyesi — remote MCP server (Streamable HTTP at /mcp) + monitoring panel (/).
 * Secrets live only in Worker secrets and never leave the server.
 */
import type { Env } from "./env";
import { handleMcp } from "./mcp";
import { challengeHeader, handleOAuth, validAccessToken } from "./oauth";
import { handlePanel } from "./panel";
import { json, safeEqual, toErrorPayload } from "./util";

export { JobRunner } from "./job-runner";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/mcp") {
        if (!env.MCP_TOKEN) return json({ error: "not_configured", detail: "MCP_TOKEN is not set on the server" }, 503);
        const m = (request.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
        // Two ways in: the static MCP_TOKEN header, or an OAuth access token issued by /token.
        const token = m?.[1].trim() ?? "";
        if (!token || !((await safeEqual(token, env.MCP_TOKEN)) || (await validAccessToken(env, token)))) {
          return json({ error: "unauthorized", detail: "sign in with OAuth or send Authorization: Bearer <MCP_TOKEN>" }, 401, { "www-authenticate": challengeHeader(url.origin) });
        }
        // Stateless server: no standalone SSE stream and no sessions to delete.
        if (request.method !== "POST") return json({ error: "method_not_allowed", detail: "use POST" }, 405, { allow: "POST" });
        return await handleMcp(request, env);
      }
      if (url.pathname === "/healthz") return json({ ok: true });
      const oauth = await handleOAuth(request, env);
      if (oauth) return oauth;
      return await handlePanel(request, env);
    } catch (e) {
      const p = toErrorPayload(env, e);
      console.error("request failed:", p.detail);
      return json(p, 500);
    }
  },
} satisfies ExportedHandler<Env>;
