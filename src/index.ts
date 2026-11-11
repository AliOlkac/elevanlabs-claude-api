/**
 * Ses Atölyesi — remote MCP server (Streamable HTTP at /mcp) + monitoring panel (/).
 * Secrets live only in Worker secrets and never leave the server.
 */
import type { Env } from "./env";
import { handleMcp } from "./mcp";
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
        if (!m || !(await safeEqual(m[1].trim(), env.MCP_TOKEN))) {
          return json({ error: "unauthorized", detail: "send Authorization: Bearer <MCP_TOKEN>" }, 401, { "www-authenticate": 'Bearer realm="ses-atolyesi"' });
        }
        // Stateless server: no standalone SSE stream and no sessions to delete.
        if (request.method !== "POST") return json({ error: "method_not_allowed", detail: "use POST" }, 405, { allow: "POST" });
        return await handleMcp(request, env);
      }
      if (url.pathname === "/healthz") return json({ ok: true });
      return await handlePanel(request, env);
    } catch (e) {
      const p = toErrorPayload(env, e);
      console.error("request failed:", p.detail);
      return json(p, 500);
    }
  },
} satisfies ExportedHandler<Env>;
