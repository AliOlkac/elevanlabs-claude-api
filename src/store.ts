/** KV-backed job index and budget settings. The Durable Object of a job stays the source of truth for its state. */
import type { Env } from "./env";
import { monthKey } from "./util";

export interface Settings {
  /** Max characters a single job may send to the API (0 = unlimited). */
  per_job_char_limit: number;
  /** Max characters per calendar month across all jobs (0 = unlimited). */
  monthly_char_limit: number;
}

export const DEFAULT_SETTINGS: Settings = { per_job_char_limit: 50_000, monthly_char_limit: 500_000 };

export async function getSettings(env: Env): Promise<Settings> {
  const s = await env.STORE.get<Partial<Settings>>("settings", "json");
  return { ...DEFAULT_SETTINGS, ...(s ?? {}) };
}

export async function putSettings(env: Env, s: Settings): Promise<void> {
  await env.STORE.put("settings", JSON.stringify(s));
}

export type JobStatus = "queued" | "running" | "done" | "error" | "cancelled";

/** Compact job record kept as KV metadata (must stay under 1 KB). */
export interface JobSummary {
  job_id: string;
  job: string;
  status: JobStatus;
  model: string;
  mode: string;
  done: number;
  total: number;
  /** Characters sent (or still planned to be sent) to the API by this job. */
  chars: number;
  credits: number;
  created_at: string;
  finished_at?: string;
  commit?: string;
}

function indexKey(createdAt: string, jobId: string): string {
  const inv = (9_999_999_999_999 - Date.parse(createdAt)).toString().padStart(13, "0");
  return `job:${inv}:${jobId}`;
}

export async function putJobSummary(env: Env, s: JobSummary): Promise<void> {
  await env.STORE.put(indexKey(s.created_at, s.job_id), "", { metadata: s });
}

/** Newest first. */
export async function listJobSummaries(env: Env, limit: number): Promise<JobSummary[]> {
  const out: JobSummary[] = [];
  let cursor: string | undefined;
  while (out.length < limit) {
    const page = await env.STORE.list<JobSummary>({ prefix: "job:", limit: Math.min(1000, limit - out.length), cursor });
    for (const k of page.keys) if (k.metadata) out.push(k.metadata);
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return out;
}

/** Characters used (or reserved by unfinished jobs) in the current calendar month. */
export async function monthlyUsage(env: Env): Promise<{ month: string; characters: number; credits: number; jobs: number }> {
  const month = monthKey();
  let characters = 0;
  let credits = 0;
  let jobs = 0;
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const r = await env.STORE.list<JobSummary>({ prefix: "job:", cursor });
    let older = false;
    for (const k of r.keys) {
      const m = k.metadata;
      if (!m) continue;
      if (m.created_at.slice(0, 7) !== month) {
        older = true; // keys are newest-first, everything after this is older
        break;
      }
      characters += m.chars || 0;
      credits += m.credits || 0;
      jobs++;
    }
    if (older || r.list_complete) break;
    cursor = r.cursor;
  }
  return { month, characters, credits: Math.round(credits), jobs };
}
