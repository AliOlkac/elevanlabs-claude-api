/**
 * Thin ElevenLabs API client (fetch based, runs on Workers).
 *
 * Endpoint/field names follow the official API definition shipped with @elevenlabs/elevenlabs-js 2.77
 * (Nov 2026) and the public model docs:
 *   - eleven_v4        -> Text to Dialogue REST   POST /v1/text-to-dialogue/with-timestamps
 *   - eleven_v4_turbo  -> Text to Dialogue WebSocket  /v1/text-to-dialogue/stream-input (one voice per connection)
 *   - eleven_v3        -> Text to Dialogue REST (multi speaker) — also accepted by Text to Speech
 *   - everything else  -> Text to Speech REST     POST /v1/text-to-speech/{voice_id}/with-timestamps
 * The table can be overridden without a code change through the MODEL_ROUTES variable.
 */
import { MAX_RETRIES, OUTPUT_FORMAT, type Env } from "./env";
import type { Alignment } from "./text";
import { AppError, b64decode, concatBytes, redact, sleep } from "./util";

export type Route = "tts_rest" | "dialogue_rest" | "dialogue_ws";

const BUILTIN_ROUTES: Record<string, Route> = {
  eleven_v4: "dialogue_rest",
  eleven_v4_turbo: "dialogue_ws",
  eleven_v3: "dialogue_rest",
};

export function routeFor(env: Env, modelId: string): Route {
  if (env.MODEL_ROUTES) {
    try {
      const o = JSON.parse(env.MODEL_ROUTES) as Record<string, Route>;
      const r = o[modelId];
      if (r === "tts_rest" || r === "dialogue_rest" || r === "dialogue_ws") return r;
    } catch {
      /* ignore malformed override */
    }
  }
  return BUILTIN_ROUTES[modelId] ?? "tts_rest";
}

export interface ModelInfo {
  model_id: string;
  name: string;
  languages: string[];
  max_characters_per_request: number | null;
  credit_multiplier: number;
  route: Route;
}

export interface Synthesis {
  audio: Uint8Array;
  alignment: Alignment | null;
  /** Only for multi-input dialogue requests. */
  segments?: { input: number; from: number; to: number; start: number; end: number }[];
  requestId: string | null;
  /** Credits reported by the API for this request, when the response carries them. */
  cost: number | null;
}

export interface VoiceSettingsInput {
  stability?: number;
  similarity_boost?: number;
  speed?: number;
}

export interface DictionaryLocator {
  pronunciation_dictionary_id: string;
  version_id?: string;
}

/** Error from the ElevenLabs API. `retryable` errors were already retried. */
export class ElevenLabsError extends AppError {
  constructor(
    status: number,
    detail: string,
    public apiCode: string | null = null,
  ) {
    super(status === 401 ? "elevenlabs_unauthorized" : status === 429 ? "elevenlabs_rate_limited" : "elevenlabs_error", detail, status);
  }
  /** Errors that will fail the same way for every remaining line of a job. */
  get fatal(): boolean {
    return this.status === 401 || this.status === 402 || this.status === 403 || this.apiCode === "quota_exceeded";
  }
}

interface ReqOpts {
  query?: Record<string, string | number | boolean | undefined>;
  json?: unknown;
  form?: FormData;
  /** Counts every HTTP attempt (used for per-invocation subrequest budgeting). */
  onAttempt?: () => void;
}

export class ElevenLabs {
  private base: string;
  private retryBase: number;

  constructor(private env: Env) {
    this.base = (env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io").replace(/\/+$/, "");
    this.retryBase = Number(env.RETRY_BASE_MS) > 0 ? Number(env.RETRY_BASE_MS) : 1000;
    if (!env.ELEVENLABS_API_KEY) throw new AppError("not_configured", "ELEVENLABS_API_KEY is not set on the server");
  }

  private url(path: string, query?: ReqOpts["query"]): string {
    const u = new URL(this.base + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== "") u.searchParams.set(k, String(v));
    return u.toString();
  }

  /** Performs a request with up to MAX_RETRIES retries (exponential backoff) on 429 / 5xx / network errors. */
  async request(method: string, path: string, opts: ReqOpts = {}): Promise<Response> {
    let lastErr: ElevenLabsError | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const wait = this.retryBase * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5);
        await sleep(Math.min(wait, 30_000));
      }
      opts.onAttempt?.();
      let res: Response;
      try {
        const headers: Record<string, string> = { "xi-api-key": this.env.ELEVENLABS_API_KEY, accept: "*/*" };
        let body: BodyInit | undefined;
        if (opts.json !== undefined) {
          headers["content-type"] = "application/json";
          body = JSON.stringify(opts.json);
        } else if (opts.form) body = opts.form;
        res = await fetch(this.url(path, opts.query), { method, headers, body });
      } catch (e) {
        lastErr = new ElevenLabsError(0, `network error: ${redact(this.env, e instanceof Error ? e.message : String(e))}`);
        continue;
      }
      if (res.ok) return res;
      const err = await this.toError(res);
      if (res.status === 429 || res.status >= 500) {
        lastErr = err;
        const ra = Number(res.headers.get("retry-after"));
        if (ra > 0 && attempt < MAX_RETRIES) await sleep(Math.min(ra * 1000, 20_000));
        continue;
      }
      throw err;
    }
    throw lastErr ?? new ElevenLabsError(0, "request failed");
  }

  private async toError(res: Response): Promise<ElevenLabsError> {
    let detail = `HTTP ${res.status}`;
    let code: string | null = null;
    try {
      const text = await res.text();
      try {
        const j = JSON.parse(text) as any;
        const d = j?.detail ?? j;
        if (typeof d === "string") detail += `: ${d}`;
        else if (Array.isArray(d)) detail += `: ${d.map((x) => `${(x?.loc ?? []).join(".")} ${x?.msg ?? ""}`.trim()).join("; ")}`;
        else if (d && typeof d === "object") {
          code = typeof d.status === "string" ? d.status : typeof d.code === "string" ? d.code : null;
          detail += `: ${code ? code + " — " : ""}${d.message ?? JSON.stringify(d)}`;
        }
      } catch {
        if (text) detail += `: ${text.slice(0, 300)}`;
      }
    } catch {
      /* body unreadable */
    }
    return new ElevenLabsError(res.status, redact(this.env, detail).slice(0, 600), code);
  }

  async getJson<T = any>(path: string, query?: ReqOpts["query"]): Promise<T> {
    return (await this.request("GET", path, { query })).json() as Promise<T>;
  }

  async postJson<T = any>(path: string, body: unknown, query?: ReqOpts["query"]): Promise<T> {
    return (await this.request("POST", path, { json: body, query })).json() as Promise<T>;
  }

  // ---------------------------------------------------------------- account / catalog

  async subscription() {
    const s = await this.getJson("/v1/user/subscription");
    return {
      plan: s.tier as string,
      status: (s.status ?? null) as string | null,
      credits_used: s.character_count as number,
      credits_limit: s.character_limit as number,
      credits_remaining: Math.max(0, (s.character_limit ?? 0) - (s.character_count ?? 0)),
      period_ends_at: s.next_character_count_reset_unix ? new Date(s.next_character_count_reset_unix * 1000).toISOString() : null,
    };
  }

  /** Text-to-speech capable models, straight from GET /v1/models (cached for 10 minutes in KV). */
  async models(): Promise<ModelInfo[]> {
    const cached = await this.env.STORE.get<ModelInfo[]>("cache:models", "json");
    if (cached) return cached.map((m) => ({ ...m, route: routeFor(this.env, m.model_id) }));
    const raw = await this.getJson<any[]>("/v1/models");
    const list: ModelInfo[] = raw
      .filter((m) => m.can_do_text_to_speech !== false)
      .map((m) => ({
        model_id: m.model_id,
        name: m.name ?? m.model_id,
        languages: (m.languages ?? []).map((l: any) => l.language_id),
        max_characters_per_request: typeof m.maximum_text_length_per_request === "number" ? m.maximum_text_length_per_request : null,
        credit_multiplier:
          (m.model_rates?.character_cost_multiplier ?? m.token_cost_factor ?? 1) * (m.model_rates?.cost_discount_multiplier ?? 1),
        route: routeFor(this.env, m.model_id),
      }));
    await this.env.STORE.put("cache:models", JSON.stringify(list), { expirationTtl: 600 });
    return list;
  }

  async voices(search?: string) {
    const out: any[] = [];
    let token: string | undefined;
    for (let page = 0; page < 5; page++) {
      const r = await this.getJson("/v2/voices", { search, page_size: 100, next_page_token: token });
      for (const v of r.voices ?? []) {
        out.push({
          voice_id: v.voice_id,
          name: v.name,
          category: v.category ?? null,
          labels: v.labels ?? {},
          language: v.labels?.language ?? v.verified_languages?.[0]?.language ?? null,
          languages: [...new Set((v.verified_languages ?? []).map((l: any) => l.language))],
          description: v.description ?? null,
        });
      }
      if (!r.has_more || !r.next_page_token) break;
      token = r.next_page_token;
    }
    return out;
  }

  async dictionary(id: string): Promise<{ id: string; latest_version_id: string | null; name: string }> {
    const d = await this.getJson(`/v1/pronunciation-dictionaries/${encodeURIComponent(id)}`);
    return { id: d.id ?? id, latest_version_id: d.latest_version_id ?? null, name: d.name ?? "" };
  }

  // ---------------------------------------------------------------- speech

  private synthMeta(res: Response): { requestId: string | null; cost: number | null } {
    const cost = Number(res.headers.get("character-cost") ?? res.headers.get("x-character-count"));
    return { requestId: res.headers.get("request-id"), cost: Number.isFinite(cost) && cost > 0 ? cost : null };
  }

  private static alignment(a: any): Alignment | null {
    if (!a?.characters?.length) return null;
    return { characters: a.characters, starts: a.character_start_times_seconds ?? [], ends: a.character_end_times_seconds ?? [] };
  }

  /** POST /v1/text-to-speech/{voice_id}/with-timestamps */
  async tts(p: {
    model: string;
    voiceId: string;
    text: string;
    language?: string;
    settings?: VoiceSettingsInput;
    dictionary?: DictionaryLocator;
    previousText?: string;
    nextText?: string;
    previousRequestIds?: string[];
    onAttempt?: () => void;
  }): Promise<Synthesis> {
    const body: Record<string, unknown> = { text: p.text, model_id: p.model };
    if (p.language) body.language_code = p.language;
    if (p.settings && Object.keys(p.settings).length) body.voice_settings = p.settings;
    if (p.dictionary) body.pronunciation_dictionary_locators = [p.dictionary];
    if (p.previousText) body.previous_text = p.previousText;
    if (p.nextText) body.next_text = p.nextText;
    if (p.previousRequestIds?.length) body.previous_request_ids = p.previousRequestIds.slice(-3);
    const res = await this.request("POST", `/v1/text-to-speech/${encodeURIComponent(p.voiceId)}/with-timestamps`, {
      json: body,
      query: { output_format: OUTPUT_FORMAT },
      onAttempt: p.onAttempt,
    });
    const j = (await res.json()) as any;
    return { audio: b64decode(j.audio_base64), alignment: ElevenLabs.alignment(j.alignment), ...this.synthMeta(res) };
  }

  /** POST /v1/text-to-dialogue/with-timestamps — one or many speakers in a single render. */
  async dialogue(p: {
    model: string;
    inputs: { text: string; voice_id: string }[];
    language?: string;
    settings?: VoiceSettingsInput;
    dictionary?: DictionaryLocator;
    previousText?: string;
    futureText?: string;
    previousRequestIds?: string[];
    onAttempt?: () => void;
  }): Promise<Synthesis> {
    const body: Record<string, unknown> = { inputs: p.inputs, model_id: p.model };
    if (p.language) body.language_code = p.language;
    const settings: Record<string, number> = {};
    if (p.settings?.stability !== undefined) settings.stability = p.settings.stability;
    if (p.settings?.similarity_boost !== undefined) settings.similarity = p.settings.similarity_boost;
    if (Object.keys(settings).length) body.settings = settings;
    if (p.dictionary) body.pronunciation_dictionary_locators = [p.dictionary];
    if (p.previousText) body.previous_text = p.previousText;
    if (p.futureText) body.future_text = p.futureText;
    if (p.previousRequestIds?.length) body.previous_request_ids = p.previousRequestIds.slice(-3);
    const res = await this.request("POST", "/v1/text-to-dialogue/with-timestamps", {
      json: body,
      query: { output_format: OUTPUT_FORMAT },
      onAttempt: p.onAttempt,
    });
    const j = (await res.json()) as any;
    return {
      audio: b64decode(j.audio_base64),
      alignment: ElevenLabs.alignment(j.alignment),
      segments: (j.voice_segments ?? []).map((s: any) => ({
        input: s.dialogue_input_index,
        from: s.character_start_index,
        to: s.character_end_index,
        start: s.start_time_seconds,
        end: s.end_time_seconds,
      })),
      ...this.synthMeta(res),
    };
  }

  private wsUrl(model: string, language?: string): string {
    return this.url("/v1/text-to-dialogue/stream-input", {
      model_id: model,
      output_format: OUTPUT_FORMAT,
      sync_alignment: true,
      language_code: language,
    });
  }

  private async openWs(model: string, language?: string): Promise<WebSocket> {
    // Workers open outbound WebSockets through fetch(); the key travels in a header, never in the URL.
    const res = await fetch(this.wsUrl(model, language), {
      headers: { Upgrade: "websocket", "xi-api-key": this.env.ELEVENLABS_API_KEY },
    });
    const ws = (res as any).webSocket as WebSocket | null;
    if (!ws) throw await this.toError(res);
    (ws as any).accept();
    return ws;
  }

  /**
   * Text to Dialogue WebSocket, used as a one-shot renderer for a single voice (eleven_v4_turbo):
   * open, send the line, close_socket, collect audio + alignment until is_final.
   */
  async dialogueWs(p: {
    model: string;
    voiceId: string;
    text: string;
    language?: string;
    settings?: VoiceSettingsInput;
    dictionary?: DictionaryLocator;
    onAttempt?: () => void;
  }): Promise<Synthesis> {
    let lastErr: ElevenLabsError | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) await sleep(Math.min(this.retryBase * 2 ** (attempt - 1), 30_000));
      p.onAttempt?.();
      try {
        return await this.dialogueWsOnce(p);
      } catch (e) {
        const err = e instanceof ElevenLabsError ? e : new ElevenLabsError(0, redact(this.env, e instanceof Error ? e.message : String(e)));
        const retryable = err.status === 0 || err.status === 429 || (err.status ?? 0) >= 500;
        if (!retryable) throw err;
        lastErr = err;
      }
    }
    throw lastErr!;
  }

  private async dialogueWsOnce(p: {
    model: string;
    voiceId: string;
    text: string;
    language?: string;
    settings?: VoiceSettingsInput;
    dictionary?: DictionaryLocator;
  }): Promise<Synthesis> {
    const ws = await this.openWs(p.model, p.language);
    const chunks: Uint8Array[] = [];
    const al: Alignment = { characters: [], starts: [], ends: [] };
    let bytesSoFar = 0;
    let lastEnd = 0;
    let absolute: boolean | null = null;

    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          ws.close(1000);
        } catch {}
        reject(new ElevenLabsError(0, "websocket timed out after 120s"));
      }, 120_000);
      const finish = (err?: Error) => {
        clearTimeout(timer);
        err ? reject(err) : resolve();
      };
      ws.addEventListener("message", (ev: MessageEvent) => {
        let m: any;
        try {
          m = JSON.parse(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer));
        } catch {
          return;
        }
        if (m.error || (m.message && m.code)) {
          const code = Number(m.code);
          // WebSocket close codes: 1008 policy / 1003 unsupported are permanent, 1011/1013 are transient.
          const status = code === 1011 || code === 1013 ? 503 : code === 1008 && /auth/i.test(String(m.error)) ? 401 : 400;
          finish(new ElevenLabsError(status, redact(this.env, `websocket: ${m.error ?? "error"} — ${m.message ?? ""}`).slice(0, 500), m.error ?? null));
          return;
        }
        const a = m.alignment;
        if (a?.chars?.length) {
          const starts: number[] = a.char_start_times_ms ?? [];
          const durs: number[] = a.char_durations_ms ?? [];
          // Chunk timings are relative to the chunk unless the server sends a running clock; detect once.
          if (absolute === null && chunks.length > 0) absolute = (starts[0] ?? 0) / 1000 >= lastEnd - 0.05 && lastEnd > 0.2;
          const base = absolute ? 0 : (bytesSoFar * 8) / 192_000; // CBR 192 kbps
          for (let i = 0; i < a.chars.length; i++) {
            const s = base + (starts[i] ?? 0) / 1000;
            al.characters.push(a.chars[i]);
            al.starts.push(s);
            al.ends.push(s + (durs[i] ?? 0) / 1000);
          }
          lastEnd = al.ends[al.ends.length - 1] ?? lastEnd;
        }
        if (typeof m.audio === "string" && m.audio.length) {
          const b = b64decode(m.audio);
          chunks.push(b);
          bytesSoFar += b.length;
        }
        if (m.is_final === true || m.isFinal === true) finish();
      });
      ws.addEventListener("close", (ev: CloseEvent) => {
        if (chunks.length) finish();
        else finish(new ElevenLabsError(ev.code === 1011 ? 503 : 400, `websocket closed (${ev.code}) ${redact(this.env, ev.reason || "without audio")}`));
      });
      ws.addEventListener("error", () => finish(new ElevenLabsError(0, "websocket connection error")));
    });

    const first: Record<string, unknown> = {
      voices: [p.voiceId],
      inputs: [{ text: p.text, voice_id: p.voiceId }],
    };
    if (p.settings?.stability !== undefined) first.voice_settings = { stability: p.settings.stability };
    if (p.dictionary) first.pronunciation_dictionary_locators = [p.dictionary];
    ws.send(JSON.stringify(first));
    ws.send(JSON.stringify({ close_socket: true }));
    await done;
    try {
      ws.close(1000);
    } catch {}
    return { audio: concatBytes(chunks), alignment: al.characters.length ? al : null, requestId: null, cost: null };
  }

  /**
   * Zero-cost check that the dialogue WebSocket accepts this model + voice (no text is sent, nothing is rendered).
   * Returns a reason string only when the server explicitly refuses; inconclusive results return null.
   */
  async probeDialogueWs(model: string, voiceId: string, language?: string): Promise<string | null> {
    let ws: WebSocket;
    try {
      ws = await this.openWs(model, language);
    } catch (e) {
      if (e instanceof ElevenLabsError && e.status && e.status >= 400 && e.status < 500 && e.status !== 429) {
        if (e.status === 401) throw e;
        return e.detail;
      }
      return null;
    }
    return await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        try {
          ws.close(1000);
        } catch {}
        resolve(null);
      }, 4000);
      const end = (r: string | null) => {
        clearTimeout(timer);
        resolve(r);
      };
      ws.addEventListener("message", (ev: MessageEvent) => {
        try {
          const m = JSON.parse(String(ev.data));
          if (m.error) end(redact(this.env, `${m.error} — ${m.message ?? ""}`).slice(0, 300));
          else if (m.is_final) end(null);
        } catch {}
      });
      ws.addEventListener("close", () => end(null));
      ws.addEventListener("error", () => end(null));
      ws.send(JSON.stringify({ voices: [voiceId] }));
      ws.send(JSON.stringify({ close_socket: true }));
    });
  }

  // ---------------------------------------------------------------- voice design / sfx / music

  async designVoice(description: string, text: string, model: string) {
    const r = await this.postJson("/v1/text-to-voice/design", { voice_description: description, text, model_id: model }, { output_format: OUTPUT_FORMAT });
    return (r.previews ?? []).map((p: any) => ({
      generated_voice_id: p.generated_voice_id as string,
      audio: b64decode(p.audio_base_64 ?? p.audio_base64),
      duration_sec: (p.duration_secs ?? null) as number | null,
      language: (p.language ?? null) as string | null,
    })) as { generated_voice_id: string; audio: Uint8Array; duration_sec: number | null; language: string | null }[];
  }

  async saveVoice(generatedVoiceId: string, name: string, description: string) {
    const r = await this.postJson("/v1/text-to-voice", { voice_name: name, voice_description: description, generated_voice_id: generatedVoiceId });
    return { voice_id: r.voice_id as string, name: (r.name ?? name) as string };
  }

  async soundEffect(text: string, durationSeconds?: number): Promise<{ audio: Uint8Array; cost: number | null }> {
    const body: Record<string, unknown> = { text };
    if (durationSeconds !== undefined) body.duration_seconds = durationSeconds;
    const res = await this.request("POST", "/v1/sound-generation", { json: body, query: { output_format: OUTPUT_FORMAT } });
    return { audio: new Uint8Array(await res.arrayBuffer()), cost: this.synthMeta(res).cost };
  }

  async music(prompt: string, durationSeconds: number, instrumental: boolean): Promise<{ audio: Uint8Array }> {
    const res = await this.request("POST", "/v1/music", {
      json: { prompt, music_length_ms: Math.round(durationSeconds * 1000), force_instrumental: instrumental },
      query: { output_format: OUTPUT_FORMAT },
    });
    return { audio: new Uint8Array(await res.arrayBuffer()) };
  }

  // ---------------------------------------------------------------- transcription / alignment

  async transcribe(src: { file?: Uint8Array; fileName?: string; url?: string }, language?: string) {
    const form = new FormData();
    form.set("model_id", "scribe_v2");
    form.set("timestamps_granularity", "word");
    form.set("tag_audio_events", "false");
    if (language) form.set("language_code", language);
    if (src.file) form.set("file", new Blob([src.file], { type: "audio/mpeg" }), src.fileName ?? "audio.mp3");
    else if (src.url) form.set("source_url", src.url);
    const r = (await (await this.request("POST", "/v1/speech-to-text", { form })).json()) as any;
    return {
      language: r.language_code ?? null,
      text: r.text ?? "",
      words: ((r.words ?? []) as any[])
        .filter((w) => w.type === "word" || w.type === undefined)
        .map((w) => ({ word: w.text as string, start: w.start as number, end: w.end as number })),
    };
  }

  async align(file: Uint8Array, fileName: string, text: string) {
    const form = new FormData();
    form.set("file", new Blob([file], { type: "audio/mpeg" }), fileName);
    form.set("text", text);
    const r = (await (await this.request("POST", "/v1/forced-alignment", { form })).json()) as any;
    return {
      loss: r.loss ?? null,
      words: ((r.words ?? []) as any[]).map((w) => ({ word: w.text as string, start: w.start as number, end: w.end as number })),
    };
  }
}
