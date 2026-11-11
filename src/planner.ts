/** Job validation, cache keys, request planning, cost estimate and budget checks. */
import { z } from "zod";
import { ElevenLabs, type DictionaryLocator, type Route } from "./elevenlabs";
import { OUTPUT_FORMAT, defaultModel, type Env } from "./env";
import { getSettings, monthlyUsage } from "./store";
import { splitText } from "./text";
import { AppError, charCount, pool, round2, sha256Hex } from "./util";

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const nameSchema = z.string().regex(NAME_RE, "use 1-80 chars of A-Z a-z 0-9 . _ - (must start with a letter or digit)");

export const settingsSchema = z
  .object({
    stability: z.number().min(0).max(1).optional(),
    similarity_boost: z.number().min(0).max(1).optional(),
    speed: z.number().min(0.5).max(2).optional(),
  })
  .strict();

export const jobSchema = z.object({
  job: nameSchema.describe('Job name; also the output folder: jobs/<job>/. Example: "sl-01-tr".'),
  model: z.string().optional().describe("ElevenLabs model id from list_models. Default: eleven_v4_turbo."),
  language: z.string().optional().describe('ISO 639-1 language code, e.g. "tr".'),
  mode: z
    .enum(["lines", "dialogue"])
    .default("lines")
    .describe('"lines": every item is its own request. "dialogue": consecutive items are rendered together as one multi-speaker take, then cut into one mp3 per item.'),
  items: z
    .array(
      z.object({
        name: nameSchema.describe('File name without extension, unique within the job, e.g. "001-balon".'),
        voice_id: z.string().min(1).describe("voice_id from list_voices or save_voice."),
        text: z.string().min(1).describe("Text to speak."),
        settings: settingsSchema.optional().describe("Optional voice settings: stability (0-1), similarity_boost (0-1), speed."),
      }),
    )
    .min(1)
    .max(500),
  pronunciation_dictionary_id: z.string().optional().describe("Dictionary id from the pronunciation tool."),
  force: z.boolean().optional().describe("true = ignore the cache and regenerate every line (costs credits again)."),
});

export type JobInput = z.infer<typeof jobSchema>;

export interface PreparedItem {
  name: string;
  voice_id: string;
  text: string;
  settings?: { stability?: number; similarity_boost?: number; speed?: number };
  characters: number;
  /** Cache key: sha256(model + voice_id + text + settings + dictionary [+ language, format]). */
  key: string;
}

export interface PreparedJob {
  job_id: string;
  job: string;
  model: string;
  route: Route;
  mode: "lines" | "dialogue";
  language?: string;
  force: boolean;
  /** Max characters per API request for this model. */
  limit: number;
  multiplier: number;
  dictionary?: DictionaryLocator;
  items: PreparedItem[];
  warnings: string[];
  created_at: string;
  est_chars: number;
}

export type Unit = { kind: "single"; item: number; parts: string[] } | { kind: "dialogue"; items: number[] };

const MAX_DIALOGUE_VOICES = 10;

/**
 * Turns the not-yet-rendered items into API requests.
 * - lines: one unit per item (long text is split at sentence boundaries into sequential parts).
 * - dialogue: runs of adjacent items that fit one request (char limit, <=10 voices, same settings) share a unit.
 */
export function planUnits(
  items: Pick<PreparedItem, "text" | "voice_id" | "settings" | "characters">[],
  pending: boolean[],
  opts: { mode: "lines" | "dialogue"; route: Route; limit: number },
): Unit[] {
  const units: Unit[] = [];
  const single = (i: number) => units.push({ kind: "single", item: i, parts: splitText(items[i].text, opts.limit) });
  if (opts.mode === "lines" || opts.route !== "dialogue_rest") {
    items.forEach((_, i) => pending[i] && single(i));
    return units;
  }
  let cur: number[] = [];
  let chars = 0;
  let voices = new Set<string>();
  let sig = "";
  const flush = () => {
    if (cur.length === 1) single(cur[0]);
    else if (cur.length > 1) units.push({ kind: "dialogue", items: cur });
    cur = [];
    chars = 0;
    voices = new Set();
  };
  items.forEach((it, i) => {
    if (!pending[i]) return flush();
    if (it.characters > opts.limit) {
      flush();
      return single(i);
    }
    const s = JSON.stringify(canonicalSettings(it.settings));
    const adjacent = cur.length === 0 || cur[cur.length - 1] === i - 1;
    const voiceCount = voices.has(it.voice_id) ? voices.size : voices.size + 1;
    if (!adjacent || chars + it.characters > opts.limit || voiceCount > MAX_DIALOGUE_VOICES || (cur.length > 0 && s !== sig)) flush();
    cur.push(i);
    chars += it.characters;
    voices.add(it.voice_id);
    sig = s;
  });
  flush();
  return units;
}

export function countRequests(units: Unit[]): number {
  return units.reduce((n, u) => n + (u.kind === "single" ? u.parts.length : 1), 0);
}

function canonicalSettings(s?: PreparedItem["settings"]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of ["similarity_boost", "speed", "stability"] as const) if (s?.[k] !== undefined) out[k] = s[k]!;
  return out;
}

export async function cacheKey(p: {
  model: string;
  voice_id: string;
  text: string;
  settings?: PreparedItem["settings"];
  dictionary?: DictionaryLocator;
  language?: string;
}): Promise<string> {
  return sha256Hex(
    JSON.stringify([
      "v1",
      p.model,
      p.voice_id,
      p.text,
      canonicalSettings(p.settings),
      p.dictionary ? [p.dictionary.pronunciation_dictionary_id, p.dictionary.version_id ?? ""] : null,
      p.language ?? "",
      OUTPUT_FORMAT,
    ]),
  );
}

export const cacheAudioKey = (key: string) => `cache/${key}.mp3`;
export const cacheMetaKey = (key: string) => `cache/${key}.json`;

export interface Estimate {
  job: string;
  model: string;
  endpoint: string;
  mode: string;
  items_total: number;
  characters_total: number;
  cached_items: number;
  characters_to_generate: number;
  estimated_credits: number;
  api_requests: number;
  max_characters_per_request: number;
  budget: { ok: boolean; reason?: string; per_job_char_limit: number; monthly_char_limit: number; month_characters_used: number };
  warnings: string[];
}

const ENDPOINT_LABEL: Record<Route, string> = {
  tts_rest: "Text to Speech REST (with timestamps)",
  dialogue_rest: "Text to Dialogue REST (with timestamps)",
  dialogue_ws: "Text to Dialogue WebSocket",
};

export interface Prepared {
  job: PreparedJob;
  estimate: Estimate;
  /** Set when the turbo model cannot run this job; the job must not start and must not be rerouted. */
  turboWarning?: string;
}

export function newJobId(job: string): string {
  return `${job}--${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, "0")}`;
}

/** Validates a job, resolves model/dictionary, checks the cache and the budget. Generates nothing. */
export async function prepareJob(env: Env, input: JobInput, opts: { force?: boolean; probe?: boolean } = {}): Promise<Prepared> {
  const names = new Set<string>();
  for (const it of input.items) {
    const n = it.name.toLowerCase();
    if (names.has(n)) throw new AppError("invalid_input", `duplicate item name: ${it.name}`);
    names.add(n);
  }
  if (input.items.some((it) => it.name.toLowerCase() === "manifest")) {
    // manifest.json would not collide with manifest.mp3, but keep the folder unambiguous.
    throw new AppError("invalid_input", 'item name "manifest" is reserved');
  }

  const el = new ElevenLabs(env);
  const modelId = input.model || defaultModel(env);
  const models = await el.models();
  const model = models.find((m) => m.model_id === modelId);
  if (!model) {
    throw new AppError("unknown_model", `model "${modelId}" is not available on this account. Available: ${models.map((m) => m.model_id).join(", ")}`);
  }
  const warnings: string[] = [];
  let limit = model.max_characters_per_request ?? 0;
  if (!limit) {
    limit = 2000;
    warnings.push(`model did not report maximum_text_length_per_request; using a conservative ${limit} characters per request`);
  }
  const cap = Number(env.MAX_CHARS_PER_REQUEST);
  if (cap > 0) limit = Math.min(limit, cap);

  const route = model.route;
  const force = !!(opts.force || input.force);

  if (input.mode === "dialogue" && route === "tts_rest") {
    throw new AppError("invalid_input", `mode "dialogue" needs a Text to Dialogue model (eleven_v4 or eleven_v3); "${modelId}" only supports single-voice Text to Speech. Use mode "lines" or change the model.`);
  }
  if (input.language && model.languages.length && !model.languages.includes(input.language)) {
    warnings.push(`model ${modelId} does not list language "${input.language}"; the language code may be ignored`);
  }
  if (route !== "tts_rest" && input.items.some((it) => it.settings?.speed !== undefined && it.settings.speed !== 1)) {
    warnings.push("settings.speed is not supported by Text to Dialogue models and is ignored");
  }
  if (route === "dialogue_ws" && input.items.some((it) => it.settings?.similarity_boost !== undefined)) {
    warnings.push("settings.similarity_boost is not supported on the Text to Dialogue WebSocket and is ignored");
  }

  let dictionary: DictionaryLocator | undefined;
  if (input.pronunciation_dictionary_id) {
    const d = await el.dictionary(input.pronunciation_dictionary_id);
    dictionary = { pronunciation_dictionary_id: d.id, ...(d.latest_version_id ? { version_id: d.latest_version_id } : {}) };
  }

  const items: PreparedItem[] = await Promise.all(
    input.items.map(async (it) => ({
      name: it.name,
      voice_id: it.voice_id,
      text: it.text,
      ...(it.settings && Object.keys(it.settings).length ? { settings: it.settings } : {}),
      characters: charCount(it.text),
      key: await cacheKey({ model: modelId, voice_id: it.voice_id, text: it.text, settings: it.settings, dictionary, language: input.language }),
    })),
  );

  const cached = new Array<boolean>(items.length).fill(false);
  if (!force) {
    await pool(items.map((_, i) => i), 20, async (i) => {
      cached[i] = (await env.AUDIO.head(cacheMetaKey(items[i].key))) !== null;
    });
  }
  const pending = cached.map((c) => !c);
  const units = planUnits(items, pending, { mode: input.mode, route, limit });
  const charsNew = items.reduce((n, it, i) => n + (pending[i] ? it.characters : 0), 0);

  // --- turbo: served only by the dialogue WebSocket, one voice per connection. Never silently switch models.
  let turboWarning: string | undefined;
  if (route === "dialogue_ws" && charsNew > 0) {
    const voices = new Set(items.map((it) => it.voice_id));
    if (input.mode === "dialogue" && voices.size > 1) {
      turboWarning = `turbo desteklenmiyor: ${modelId} is only served by the Text to Dialogue WebSocket with a single voice per connection, so a multi-speaker "dialogue" batch cannot be rendered with it. Nothing was generated. Options: resubmit with model "eleven_v4" (multi-speaker REST), or keep ${modelId} with mode "lines".`;
    } else if (opts.probe) {
      const reason = await el.probeDialogueWs(modelId, items[pending.indexOf(true)].voice_id, input.language);
      if (reason) turboWarning = `turbo desteklenmiyor: ${reason}. Nothing was generated. Resubmit with model "eleven_v4" if that is acceptable.`;
    }
  }

  const [settings, usage] = await Promise.all([getSettings(env), monthlyUsage(env)]);
  let budgetReason: string | undefined;
  if (settings.per_job_char_limit > 0 && charsNew > settings.per_job_char_limit) {
    budgetReason = `job needs ${charsNew} new characters, over the per-job limit of ${settings.per_job_char_limit}`;
  } else if (settings.monthly_char_limit > 0 && usage.characters + charsNew > settings.monthly_char_limit) {
    budgetReason = `job needs ${charsNew} new characters; ${usage.characters} of the monthly limit of ${settings.monthly_char_limit} are already used`;
  }

  const job: PreparedJob = {
    job_id: newJobId(input.job),
    job: input.job,
    model: modelId,
    route,
    mode: input.mode,
    ...(input.language ? { language: input.language } : {}),
    force,
    limit,
    multiplier: model.credit_multiplier,
    ...(dictionary ? { dictionary } : {}),
    items,
    warnings,
    created_at: new Date().toISOString(),
    est_chars: charsNew,
  };
  const estimate: Estimate = {
    job: input.job,
    model: modelId,
    endpoint: ENDPOINT_LABEL[route],
    mode: input.mode,
    items_total: items.length,
    characters_total: items.reduce((n, it) => n + it.characters, 0),
    cached_items: cached.filter(Boolean).length,
    characters_to_generate: charsNew,
    estimated_credits: round2(charsNew * model.credit_multiplier),
    api_requests: countRequests(units),
    max_characters_per_request: limit,
    budget: {
      ok: !budgetReason,
      ...(budgetReason ? { reason: budgetReason } : {}),
      per_job_char_limit: settings.per_job_char_limit,
      monthly_char_limit: settings.monthly_char_limit,
      month_characters_used: usage.characters,
    },
    warnings: turboWarning ? [turboWarning, ...warnings] : warnings,
  };
  return { job, estimate, turboWarning };
}
