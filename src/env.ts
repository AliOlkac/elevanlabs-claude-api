export interface Env {
  // --- secrets (server-side only; never echoed) ---
  ELEVENLABS_API_KEY: string;
  MCP_TOKEN: string;
  GITHUB_TOKEN: string;
  GITHUB_REPO: string;
  APP_PASSWORD: string;

  // --- optional plain settings ---
  DEFAULT_MODEL?: string;
  GITHUB_BRANCH?: string;
  /** JSON map model_id -> "tts_rest" | "dialogue_rest" | "dialogue_ws"; overrides the built-in routing table. */
  MODEL_ROUTES?: string;
  /** Optional hard cap applied on top of the model's maximum_text_length_per_request. */
  MAX_CHARS_PER_REQUEST?: string;
  /** Base delay for retry backoff in ms (default 1000). */
  RETRY_BASE_MS?: string;
  /** Overridable API hosts (used by the test suite). */
  ELEVENLABS_BASE_URL?: string;
  GITHUB_API_URL?: string;

  // --- bindings ---
  STORE: KVNamespace;
  AUDIO: R2Bucket;
  JOBS: DurableObjectNamespace<import("./job-runner").JobRunner>;
}

export const OUTPUT_FORMAT = "mp3_44100_192";
export const DEFAULT_MODEL = "eleven_v4_turbo";
export const PARALLEL_REQUESTS = 3;
export const MAX_RETRIES = 3;
/** GitHub rejects very large pushes; a job bigger than this is split into several commits. */
export const MAX_COMMIT_BYTES = 90 * 1024 * 1024;

export function defaultModel(env: Env): string {
  return env.DEFAULT_MODEL || DEFAULT_MODEL;
}
