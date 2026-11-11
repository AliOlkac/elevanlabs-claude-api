// In-memory stand-in for the ElevenLabs API and the GitHub Git Data API (test only).
import { createHash } from "node:crypto";
import http from "node:http";
import { WebSocketServer } from "ws";

export const FRAME_SEC = 1152 / 44100;
const FRAME = (() => {
  const f = Buffer.alloc(626); // MPEG1 Layer III, 192 kbps, 44.1 kHz, no padding
  f[0] = 0xff; f[1] = 0xfb; f[2] = 0xb0; f[3] = 0x00;
  return f;
})();
const mp3 = (frames) => Buffer.concat(Array.from({ length: Math.max(1, frames) }, () => FRAME));
const chars = (s) => [...s];

export function startMock({ port, elKey, ghToken, repo }) {
  const s = {
    counts: {},
    synthTexts: [],
    flaky: {},
    dictVersion: 1,
    git: { blobs: {}, trees: {}, commits: {}, head: null },
    seenSecretsInBodies: false,
    badAuth: 0,
    lastBodies: {},
  };
  const bump = (k) => (s.counts[k] = (s.counts[k] ?? 0) + 1);
  const sha = (x) => createHash("sha1").update(x).digest("hex");

  const models = [
    { model_id: "eleven_v4_turbo", name: "Eleven v4 Turbo", can_do_text_to_speech: true, maximum_text_length_per_request: 200, languages: [{ language_id: "tr", name: "Turkish" }, { language_id: "en", name: "English" }], model_rates: { character_cost_multiplier: 0.5 } },
    { model_id: "eleven_v4", name: "Eleven v4", can_do_text_to_speech: true, maximum_text_length_per_request: 200, languages: [{ language_id: "tr", name: "Turkish" }], model_rates: { character_cost_multiplier: 1 } },
    { model_id: "eleven_multilingual_v2", name: "Multilingual v2", can_do_text_to_speech: true, maximum_text_length_per_request: 120, languages: [{ language_id: "tr", name: "Turkish" }], token_cost_factor: 1 },
    { model_id: "eleven_english_sts_v2", name: "STS", can_do_text_to_speech: false },
  ];

  const alignment = (text) => {
    const cs = chars(text);
    return {
      characters: cs,
      character_start_times_seconds: cs.map((_, i) => i * FRAME_SEC),
      character_end_times_seconds: cs.map((_, i) => (i + 1) * FRAME_SEC),
    };
  };

  /** Returns an error response object, or null when the request should succeed. */
  const inject = (text, body) => {
    if (text.includes("BAD")) return [400, { detail: { status: "invalid_text", message: "text rejected" } }];
    if (text.includes("FLAKY")) {
      s.flaky[text] = (s.flaky[text] ?? 0) + 1;
      if (s.flaky[text] <= 2) return [s.flaky[text] === 1 ? 429 : 503, { detail: { status: "busy", message: "try again" } }];
    }
    if (text.includes("NOCTX") && (body.previous_text || body.next_text || body.future_text || body.previous_request_ids)) {
      return [400, { detail: { status: "unsupported", message: "previous_text is not supported by this model" } }];
    }
    return null;
  };

  const send = (res, status, body, headers = {}) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    res.writeHead(status, { "content-type": Buffer.isBuffer(body) ? "audio/mpeg" : "application/json", ...headers });
    res.end(buf);
  };

  const treeFiles = (treeSha) => ({ ...(s.git.trees[treeSha] ?? {}) });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    const raw = await new Promise((r) => {
      const c = [];
      req.on("data", (d) => c.push(d));
      req.on("end", () => r(Buffer.concat(c)));
    });
    const text = raw.toString("utf8");
    if (text.includes(elKey) || text.includes(ghToken)) s.seenSecretsInBodies = true;
    if (url.search.includes(elKey)) s.seenSecretsInBodies = true;
    let body = {};
    try { body = JSON.parse(text); } catch {}

    if (p === "/__state") return send(res, 200, s);

    // ------------------------------------------------------------ GitHub
    if (p.startsWith("/repos/")) {
      if (req.headers.authorization !== `Bearer ${ghToken}` || !p.startsWith(`/repos/${repo}`)) { s.badAuth++; return send(res, 401, { message: "Bad credentials" }); }
      const sub = p.slice(`/repos/${repo}`.length);
      bump("gh " + req.method + " " + sub.split("/").slice(0, 3).join("/"));
      const g = s.git;
      if (sub === "" && req.method === "GET") return send(res, 200, { default_branch: "main" });
      if (sub === "/git/ref/heads/main") return g.head ? send(res, 200, { object: { sha: g.head } }) : send(res, 409, { message: "Git Repository is empty." });
      if (sub.startsWith("/git/commits/") && req.method === "GET") return send(res, 200, { sha: sub.slice(13), tree: { sha: g.commits[sub.slice(13)].tree } });
      if (sub === "/git/blobs") {
        const data = Buffer.from(body.content, "base64");
        const id = sha(data);
        g.blobs[id] = data;
        return send(res, 201, { sha: id });
      }
      if (sub === "/git/trees") {
        const files = treeFiles(body.base_tree);
        for (const e of body.tree) e.sha === null ? delete files[e.path] : (files[e.path] = e.sha);
        const id = sha(JSON.stringify(Object.entries(files).sort()));
        g.trees[id] = files;
        return send(res, 201, { sha: id });
      }
      if (sub === "/git/commits") {
        const id = sha(JSON.stringify([body.message, body.tree, body.parents, Object.keys(g.commits).length]));
        g.commits[id] = { message: body.message, tree: body.tree, parents: body.parents };
        return send(res, 201, { sha: id });
      }
      if (sub === "/git/refs/heads/main" && req.method === "PATCH") {
        if (g.commits[body.sha].parents[0] !== g.head) return send(res, 422, { message: "Update is not a fast forward" });
        g.head = body.sha;
        return send(res, 200, { object: { sha: g.head } });
      }
      if (sub.startsWith("/contents/")) {
        const path = decodeURIComponent(sub.slice(10));
        if (req.method === "PUT") {
          const blob = sha(Buffer.from(body.content, "base64"));
          g.blobs[blob] = Buffer.from(body.content, "base64");
          const files = g.head ? treeFiles(g.commits[g.head].tree) : {};
          files[path] = blob;
          const tree = sha(JSON.stringify(Object.entries(files).sort()));
          g.trees[tree] = files;
          const c = sha("init" + tree);
          g.commits[c] = { message: body.message, tree, parents: g.head ? [g.head] : [] };
          g.head = c;
          return send(res, 201, { commit: { sha: c } });
        }
        const files = g.head ? treeFiles(g.commits[g.head].tree) : {};
        if (files[path]) return send(res, 200, g.blobs[files[path]]);
        const inDir = Object.keys(files).filter((f) => f.startsWith(path + "/") && !f.slice(path.length + 1).includes("/"));
        if (inDir.length) return send(res, 200, inDir.map((f) => ({ type: "file", path: f })));
        return send(res, 404, { message: "Not Found" });
      }
      return send(res, 404, { message: "Not Found (mock) " + sub });
    }

    // ------------------------------------------------------------ ElevenLabs
    if (req.headers["xi-api-key"] !== elKey) { s.badAuth++; return send(res, 401, { detail: { status: "invalid_api_key", message: "Invalid API key" } }); }
    bump(`${req.method} ${p.replace(/text-to-speech\/[^/]+/, "text-to-speech/:id").replace(/dictionaries\/pd_[^/]+/, "dictionaries/:id")}`);
    s.lastBodies[p] = body;

    if (p === "/v1/models") return send(res, 200, models);
    if (p === "/v1/user/subscription") return send(res, 200, { tier: "creator", status: "active", character_count: 12000, character_limit: 100000, next_character_count_reset_unix: 1800000000 });
    if (p === "/v2/voices") {
      const all = [
        { voice_id: "voiceA", name: "Ayşe", category: "premade", labels: { language: "tr", gender: "female" }, description: "warm narrator" },
        { voice_id: "voiceB", name: "Burak", category: "generated", labels: { language: "tr", gender: "male" } },
      ];
      const q = (url.searchParams.get("search") ?? "").toLowerCase();
      return send(res, 200, { voices: all.filter((v) => !q || JSON.stringify(v).toLowerCase().includes(q)), has_more: false });
    }

    const tts = p.match(/^\/v1\/text-to-speech\/([^/]+)\/with-timestamps$/);
    if (tts) {
      const err = inject(body.text, body);
      if (err) return send(res, err[0], err[1]);
      if (url.searchParams.get("output_format") !== "mp3_44100_192") return send(res, 400, { detail: "bad output_format" });
      s.synthTexts.push(body.text);
      const n = chars(body.text).length;
      return send(res, 200, { audio_base64: mp3(n).toString("base64"), alignment: alignment(body.text) }, { "request-id": "req_" + s.synthTexts.length, "character-cost": String(n) });
    }

    if (p === "/v1/text-to-dialogue/with-timestamps") {
      if (body.model_id === "eleven_v4_turbo") return send(res, 400, { detail: { status: "model_not_supported", message: "eleven_v4_turbo is only available over the websocket" } });
      const all = body.inputs.map((i) => i.text).join("");
      const err = inject(all, body);
      if (err) return send(res, err[0], err[1]);
      if ((body.previous_text ?? "").length > 100 || (body.future_text ?? "").length > 100) return send(res, 422, { detail: "context too long" });
      if (chars(all).length > 200) return send(res, 400, { detail: { status: "text_too_long", message: "too long" } });
      if (new Set(body.inputs.map((i) => i.voice_id)).size > 10) return send(res, 400, { detail: "too many voices" });
      s.synthTexts.push(...body.inputs.map((i) => i.text));
      let pos = 0;
      const segs = body.inputs.map((inp, i) => {
        const n = chars(inp.text).length;
        const seg = { voice_id: inp.voice_id, dialogue_input_index: i, character_start_index: pos, character_end_index: pos + n, start_time_seconds: pos * FRAME_SEC, end_time_seconds: (pos + n) * FRAME_SEC };
        pos += n;
        return seg;
      });
      return send(res, 200, { audio_base64: mp3(pos).toString("base64"), alignment: alignment(all), voice_segments: segs }, { "request-id": "dlg_" + s.synthTexts.length });
    }

    if (p === "/v1/text-to-voice/design") {
      return send(res, 200, { text: body.text, previews: [1, 2, 3].map((i) => ({ generated_voice_id: "gen" + i, audio_base_64: mp3(20 * i).toString("base64"), media_type: "audio/mpeg", duration_secs: 20 * i * FRAME_SEC })) });
    }
    if (p === "/v1/text-to-voice") return send(res, 200, { voice_id: "saved_" + body.generated_voice_id, name: body.voice_name });
    if (p === "/v1/sound-generation") return send(res, 200, mp3(Math.round((body.duration_seconds ?? 1) / FRAME_SEC)), { "character-cost": "40" });
    if (p === "/v1/music") return send(res, 200, mp3(Math.round(body.music_length_ms / 1000 / FRAME_SEC)));
    if (p === "/v1/pronunciation-dictionaries" && req.method === "GET") return send(res, 200, { pronunciation_dictionaries: [{ id: "pd_1", name: "isimler", latest_version_id: "v" + s.dictVersion, latest_version_rules_num: 2 }] });
    if (p === "/v1/pronunciation-dictionaries/add-from-rules") return send(res, 200, { id: "pd_1", name: body.name, version_id: "v" + s.dictVersion, version_rules_num: body.rules.length });
    const pd = p.match(/^\/v1\/pronunciation-dictionaries\/(pd_\w+)(\/(add|remove)-rules)?$/);
    if (pd) {
      if (pd[2]) s.dictVersion++;
      return send(res, 200, { id: pd[1], name: "isimler", latest_version_id: "v" + s.dictVersion, version_id: "v" + s.dictVersion, version_rules_num: 3 });
    }
    if (p === "/v1/speech-to-text") {
      return send(res, 200, { language_code: "tr", text: "merhaba dünya", words: [{ text: "merhaba", start: 0, end: 0.5, type: "word" }, { text: " ", start: 0.5, end: 0.6, type: "spacing" }, { text: "dünya", start: 0.6, end: 1, type: "word" }] });
    }
    if (p === "/v1/forced-alignment") return send(res, 200, { loss: 0.1, characters: [], words: [{ text: "merhaba", start: 0, end: 0.5, loss: 0.1 }] });
    return send(res, 404, { detail: "mock: unknown endpoint " + p });
  });

  // Text to Dialogue WebSocket: turbo only, exactly one voice per connection.
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, headDat) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname !== "/v1/text-to-dialogue/stream-input" || req.headers["xi-api-key"] !== elKey) return socket.destroy();
    if (url.search.includes(elKey)) s.seenSecretsInBodies = true;
    wss.handleUpgrade(req, socket, headDat, (ws) => {
      bump("WS stream-input");
      const model = url.searchParams.get("model_id");
      let voices = null;
      let text = "";
      ws.on("message", (data) => {
        const m = JSON.parse(data.toString());
        const fail = (error, message) => { ws.send(JSON.stringify({ error, message, code: 1008 })); ws.close(1008, error); };
        if (model !== "eleven_v4_turbo") return fail("model_not_supported", `${model} is not available on this endpoint`);
        if (m.voices) {
          voices = m.voices;
          if (voices.length !== 1) return fail("too_many_voices", "exactly 1 voice is supported for this model");
        }
        for (const i of m.inputs ?? []) {
          if (!voices?.includes(i.voice_id)) return fail("unknown_voice", "voice not registered");
          text += i.text;
        }
        if (m.close_socket) {
          if (text.includes("BAD")) return fail("invalid_text", "text rejected");
          if (text) {
            s.synthTexts.push(text);
            const cs = chars(text);
            const half = Math.ceil(cs.length / 2);
            for (const part of [cs.slice(0, half), cs.slice(half)]) {
              if (!part.length) continue;
              ws.send(JSON.stringify({
                audio: mp3(part.length).toString("base64"),
                alignment: { chars: part, char_start_times_ms: part.map((_, i) => i * FRAME_SEC * 1000), char_durations_ms: part.map(() => FRAME_SEC * 1000) },
              }));
            }
            ws.send(JSON.stringify({ is_final_audio_for_turn: true }));
          }
          ws.send(JSON.stringify({ is_final: true }));
          ws.close(1000);
        }
      });
    });
  });

  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ state: s, close: () => server.close() })));
}
