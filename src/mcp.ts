/** The MCP surface: 15 tools, all returning JSON text. Errors are returned as {error, detail}. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { ElevenLabs } from "./elevenlabs";
import { defaultModel, type Env } from "./env";
import { GitHub, normalizeRepoPath } from "./github";
import { mp3Duration } from "./mp3";
import { NAME_RE, jobSchema, prepareJob } from "./planner";
import { getSettings, listJobSummaries, monthlyUsage } from "./store";
import { AppError, charCount, round3, toErrorPayload } from "./util";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const fileName = z.string().regex(NAME_RE, "use 1-80 chars of A-Z a-z 0-9 . _ - (no extension, no slashes)");

function jobStub(env: Env, jobId: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(jobId)) throw new AppError("invalid_input", "malformed job_id");
  return env.JOBS.get(env.JOBS.idFromName(jobId));
}

export function buildServer(env: Env): McpServer {
  const server = new McpServer(
    { name: "ses-atolyesi", version: "1.0.0" },
    {
      instructions:
        "Ses Atölyesi (Audio Workshop) generates audio with ElevenLabs on the owner's behalf. " +
        "Audio is never returned inline: every result is committed to the owner's private GitHub output repository and the tool returns the repository path and commit SHA — fetch the files from that repository. " +
        "Typical flow: list_voices -> estimate_job -> submit_job -> poll get_job until status is done -> read jobs/<job>/manifest.json and the mp3 files from GitHub. " +
        "Generation spends the owner's credits: call estimate_job before large jobs, and never resubmit a job just to check on it (use get_job). Lines already generated are cached and free on resubmission.",
    },
  );

  // Arguments are validated here (not by the SDK) so that invalid input also comes back as {error, detail} JSON.
  const schemas: Record<string, z.ZodObject<any>> = {};
  (server as any).validateToolInput = async (_tool: unknown, args: unknown) => args;

  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean },
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
  ) => {
    schemas[name] = z.object(shape);
    server.registerTool(
      name,
      { description, inputSchema: shape, annotations: { openWorldHint: true, ...annotations } },
      (async (args: any): Promise<ToolResult> => {
        try {
          return { content: [{ type: "text", text: JSON.stringify(await handler(schemas[name].parse(args ?? {}) as any)) }] };
        } catch (e) {
          const payload = e instanceof z.ZodError ? { error: "invalid_input", detail: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") } : toErrorPayload(env, e);
          return { content: [{ type: "text", text: JSON.stringify(payload) }], isError: true };
        }
      }) as any,
    );
  };

  // 1 ------------------------------------------------------------------
  tool(
    "account_status",
    "Check the ElevenLabs account before spending: remaining credits, plan, when the billing period resets, and this calendar month's usage through this server together with the configured budget limits. Read-only, free.",
    {},
    { readOnlyHint: true },
    async () => {
      const [sub, usage, settings] = await Promise.all([new ElevenLabs(env).subscription(), monthlyUsage(env), getSettings(env)]);
      return {
        plan: sub.plan,
        subscription_status: sub.status,
        credits_remaining: sub.credits_remaining,
        credits_used_this_period: sub.credits_used,
        credits_limit: sub.credits_limit,
        period_ends_at: sub.period_ends_at,
        this_month: { month: usage.month, characters_generated: usage.characters, credits_spent: usage.credits, jobs: usage.jobs },
        budget: { per_job_char_limit: settings.per_job_char_limit, monthly_char_limit: settings.monthly_char_limit, note: "0 means unlimited" },
      };
    },
  );

  // 2 ------------------------------------------------------------------
  tool(
    "list_models",
    "List the speech models available to this account (live from ElevenLabs): id, name, supported language codes, maximum characters per request and credit multiplier per character. Also shows which API endpoint each model is served by and whether it supports multi-speaker \"dialogue\" jobs. Use it to pick `model` for submit_job. Read-only, free.",
    {},
    { readOnlyHint: true },
    async () => {
      const models = await new ElevenLabs(env).models();
      return {
        default_model: defaultModel(env),
        models: models.map((m) => ({
          model_id: m.model_id,
          name: m.name,
          languages: m.languages,
          max_characters_per_request: m.max_characters_per_request,
          credit_multiplier: m.credit_multiplier,
          endpoint: m.route === "tts_rest" ? "text-to-speech (REST)" : m.route === "dialogue_rest" ? "text-to-dialogue (REST)" : "text-to-dialogue (WebSocket)",
          supports_mode_lines: true,
          supports_mode_dialogue: m.route === "dialogue_rest",
          ...(m.route === "dialogue_ws" ? { note: "WebSocket-only model: one voice per connection, so it works for mode \"lines\" but not for multi-speaker \"dialogue\" jobs." } : {}),
        })),
      };
    },
  );

  // 3 ------------------------------------------------------------------
  tool(
    "list_voices",
    "Find voices in the owner's ElevenLabs voice library. Returns voice_id, name, labels (gender, age, accent, use case…) and language. Pass `search` to filter by name, description or label (e.g. \"turkish\", \"narrator\", \"child\"). A voice_id from here (or from save_voice) is required for every job item. Read-only, free.",
    { search: z.string().optional().describe("Free-text filter; omit to list everything.") },
    { readOnlyHint: true },
    async ({ search }) => {
      const voices = await new ElevenLabs(env).voices(search);
      return { count: voices.length, voices };
    },
  );

  // 4 ------------------------------------------------------------------
  tool(
    "estimate_job",
    "Dry run for a speech job: validates it and returns the character count, estimated credits, how many lines would come from the cache for free, how many API requests it needs, and whether it fits the budget. Generates nothing and costs nothing. Call this before submit_job for anything non-trivial. Takes exactly the same `job` object as submit_job.",
    { job: jobSchema },
    { readOnlyHint: true },
    async ({ job }) => (await prepareJob(env, job, { probe: false })).estimate,
  );

  // 5 ------------------------------------------------------------------
  tool(
    "submit_job",
    "Queue a speech generation job and return immediately with a job_id; the audio is rendered in the background (poll get_job). " +
      "Each item becomes jobs/<job>/<name>.mp3 in the GitHub output repository, plus jobs/<job>/manifest.json with per-word timestamps, all in one commit \"job: <job>\". " +
      "mode \"lines\" renders every item separately; mode \"dialogue\" renders consecutive items as one natural multi-speaker conversation and then cuts it into one mp3 per item. " +
      "Lines that were generated before with identical model, voice, text, settings and dictionary are reused from the cache at no cost, so resubmitting a job after editing a few lines only pays for those lines; set force=true to regenerate everything. " +
      "If the job would exceed the budget it is not started and the response says why. " +
      "If the turbo model cannot run the job, nothing is generated and the response carries a `warning` starting with \"turbo desteklenmiyor\": the server never switches models on its own, so decide whether to resubmit with another model.",
    { job: jobSchema, force: z.boolean().optional().describe("Same as job.force: regenerate every line, ignoring the cache.") },
    { readOnlyHint: false, destructiveHint: false },
    async ({ job, force }) => {
      const p = await prepareJob(env, job, { force, probe: true });
      if (p.turboWarning) return { started: false, warning: p.turboWarning, estimate: p.estimate };
      if (!p.estimate.budget.ok) return { started: false, reason: `budget exceeded: ${p.estimate.budget.reason}`, estimate: p.estimate };
      await jobStub(env, p.job.job_id).start(p.job);
      return {
        started: true,
        job_id: p.job.job_id,
        status: "queued",
        output_path: `jobs/${p.job.job}/`,
        estimate: p.estimate,
        next: "Poll get_job with this job_id until status is done (or error).",
      };
    },
  );

  // 6 ------------------------------------------------------------------
  tool(
    "get_job",
    "Check a job submitted with submit_job: status (queued | running | done | error | cancelled), finished/total lines and credits spent so far. When done it also returns the GitHub folder path, the commit SHA and a manifest summary (file, duration and cache flag per line) — then read the files from the GitHub repository. On error it returns what failed; finished lines stay cached. Read-only, free.",
    { job_id: z.string().describe("The job_id returned by submit_job.") },
    { readOnlyHint: true },
    async ({ job_id }) => {
      const v = await jobStub(env, job_id).status(false);
      if (!v) throw new AppError("not_found", `no job with id ${job_id}`);
      return v;
    },
  );

  // 7 ------------------------------------------------------------------
  tool(
    "list_jobs",
    "List the most recent jobs (newest first) with job_id, name, status, progress, credits and commit SHA. Use it to find a job_id you no longer have. Read-only, free.",
    { limit: z.number().int().min(1).max(100).optional().describe("How many jobs to return (default 20).") },
    { readOnlyHint: true },
    async ({ limit }) => ({ jobs: await listJobSummaries(env, limit ?? 20) }),
  );

  // 8 ------------------------------------------------------------------
  tool(
    "cancel_job",
    "Stop a queued or running job. Requests already in flight finish, no further lines are generated and nothing is committed to GitHub. Lines generated so far stay in the cache, so a later resubmission does not pay for them again.",
    { job_id: z.string() },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    async ({ job_id }) => {
      const v = await jobStub(env, job_id).cancel();
      if (!v) throw new AppError("not_found", `no job with id ${job_id}`);
      return v;
    },
  );

  // 9 ------------------------------------------------------------------
  tool(
    "design_voice",
    "Create a brand-new synthetic voice from a text description (Voice Design). Generates 3 candidate previews speaking `sample_text`, commits them to GitHub under previews/<id>/ and returns their generated_voice_id values. Listen to/inspect the previews, then call save_voice with the chosen generated_voice_id to keep it. Use this when no existing voice from list_voices fits. Costs credits.",
    {
      description: z.string().min(20).max(1000).describe("Who the voice is: age, gender, accent, tone, pacing, character. 20-1000 chars."),
      sample_text: z.string().describe("Text the previews speak, in the target language. Must be 100-1000 characters."),
      language: z.string().describe('ISO 639-1 code of the sample text, e.g. "tr".'),
    },
    { readOnlyHint: false },
    async ({ description, sample_text, language }) => {
      const n = charCount(sample_text);
      if (n < 100 || n > 1000) throw new AppError("invalid_input", `sample_text must be 100-1000 characters (got ${n})`);
      const previews = await new ElevenLabs(env).designVoice(description, sample_text, "eleven_ttv_v3");
      if (!previews.length) throw new AppError("elevenlabs_error", "no previews were returned");
      const id = `vd-${Date.now().toString(36)}`;
      const dir = `previews/${id}`;
      const list = previews.map((p, i) => ({
        generated_voice_id: p.generated_voice_id,
        file: `${dir}/${i + 1}-${p.generated_voice_id.replace(/[^A-Za-z0-9_-]/g, "")}.mp3`,
        duration_sec: round3(p.duration_sec ?? mp3Duration(p.audio)),
        audio: p.audio,
      }));
      const manifest = { id, description, sample_text, language, created_at: new Date().toISOString(), previews: list.map(({ audio, ...rest }) => rest) };
      const sha = await new GitHub(env).commitFiles(`preview: ${id}`, [
        ...list.map((p) => ({ path: p.file, bytes: p.audio })),
        { path: `${dir}/manifest.json`, bytes: new TextEncoder().encode(JSON.stringify(manifest, null, 2) + "\n") },
      ]);
      return { id, github_path: dir, commit_sha: sha, previews: manifest.previews, next: "Call save_voice with the chosen generated_voice_id." };
    },
  );

  // 10 -----------------------------------------------------------------
  tool(
    "save_voice",
    "Turn one design_voice preview into a permanent voice in the owner's library and return its voice_id, ready to use in job items. Uses one voice slot of the account.",
    {
      generated_voice_id: z.string().describe("From design_voice."),
      name: z.string().min(1).max(100).describe("Display name of the voice."),
      description: z.string().min(20).max(1000).describe("Voice description (20-1000 chars); usually the one given to design_voice."),
    },
    { readOnlyHint: false },
    async ({ generated_voice_id, name, description }) => new ElevenLabs(env).saveVoice(generated_voice_id, name, description),
  );

  // 11 -----------------------------------------------------------------
  tool(
    "sound_effect",
    "Generate a sound effect or ambience from a text description (e.g. \"balloon popping\", \"rain on a tin roof\") and commit it to GitHub as sfx/<name>.mp3. Returns the path and commit SHA. Not for speech or music. Costs credits.",
    {
      text: z.string().min(1).describe("Description of the sound."),
      duration_seconds: z.number().min(0.5).max(30).optional().describe("0.5-30 s; omit to let the model choose."),
      name: fileName.describe("File name without extension."),
    },
    { readOnlyHint: false },
    async ({ text, duration_seconds, name }) => {
      const { audio, cost } = await new ElevenLabs(env).soundEffect(text, duration_seconds);
      const path = `sfx/${name}.mp3`;
      const sha = await new GitHub(env).commitFiles(`sfx: ${name}`, [{ path, bytes: audio }]);
      return { github_path: path, commit_sha: sha, duration_sec: round3(mp3Duration(audio)), bytes: audio.length, ...(cost !== null ? { credits: cost } : {}) };
    },
  );

  // 12 -----------------------------------------------------------------
  tool(
    "music",
    "Compose a music track from a prompt (genre, mood, instruments, tempo) and commit it to GitHub as music/<name>.mp3. Returns the path and commit SHA. Instrumental by default; set instrumental=false to allow vocals. Can take a minute or more. Costs credits.",
    {
      prompt: z.string().min(1).describe("What the music should sound like."),
      duration_seconds: z.number().min(3).max(600).describe("Track length, 3-600 s."),
      instrumental: z.boolean().default(true).describe("true = guaranteed no vocals."),
      name: fileName.describe("File name without extension."),
    },
    { readOnlyHint: false },
    async ({ prompt, duration_seconds, instrumental, name }) => {
      const { audio } = await new ElevenLabs(env).music(prompt, duration_seconds, instrumental ?? true);
      const path = `music/${name}.mp3`;
      const sha = await new GitHub(env).commitFiles(`music: ${name}`, [{ path, bytes: audio }]);
      return { github_path: path, commit_sha: sha, duration_sec: round3(mp3Duration(audio)), bytes: audio.length };
    },
  );

  // 13 -----------------------------------------------------------------
  const rule = z.object({
    string_to_replace: z.string().min(1).describe("The word as written in the script, e.g. a proper name."),
    alias: z.string().min(1).describe("How it should be read, spelled phonetically in the target language."),
    case_sensitive: z.boolean().optional(),
    word_boundaries: z.boolean().optional(),
  });
  tool(
    "pronunciation",
    "Manage pronunciation dictionaries: alias rules that make proper names and unusual words read correctly (e.g. string_to_replace \"Gon Freecss\" -> alias \"Gon Friks\"). " +
      "action \"list\": all dictionaries. \"create\": new dictionary from `name` + `rules`, returns its id. \"add_rules\": add `rules` to `dictionary_id`. \"remove_rules\": remove the entries listed in `rule_strings` from `dictionary_id`. " +
      "Pass the dictionary id as pronunciation_dictionary_id in submit_job. Changing a dictionary creates a new version, so affected lines are regenerated (not served from cache) on the next submission.",
    {
      action: z.enum(["list", "create", "add_rules", "remove_rules"]),
      dictionary_id: z.string().optional().describe("Required for add_rules and remove_rules."),
      name: z.string().optional().describe("Required for create."),
      description: z.string().optional(),
      rules: z.array(rule).optional().describe("Alias rules; required for create and add_rules."),
      rule_strings: z.array(z.string()).optional().describe("string_to_replace values to delete; required for remove_rules."),
    },
    { readOnlyHint: false },
    async (a) => {
      const el = new ElevenLabs(env);
      const rules = (a.rules ?? []).map((r) => ({ type: "alias", ...r }));
      const need = (cond: unknown, msg: string) => {
        if (!cond) throw new AppError("invalid_input", msg);
      };
      const out = (d: any) => ({ dictionary_id: d.id, name: d.name, version_id: d.version_id ?? d.latest_version_id ?? null, rules_count: d.version_rules_num ?? d.latest_version_rules_num ?? null });
      switch (a.action) {
        case "list": {
          const r = await el.getJson("/v1/pronunciation-dictionaries", { page_size: 100 });
          return { dictionaries: (r.pronunciation_dictionaries ?? []).map((d: any) => ({ ...out(d), description: d.description ?? null })) };
        }
        case "create":
          need(a.name, "name is required for create");
          need(rules.length, "rules are required for create");
          return out(await el.postJson("/v1/pronunciation-dictionaries/add-from-rules", { name: a.name, description: a.description, rules }));
        case "add_rules":
          need(a.dictionary_id, "dictionary_id is required for add_rules");
          need(rules.length, "rules are required for add_rules");
          return out(await el.postJson(`/v1/pronunciation-dictionaries/${encodeURIComponent(a.dictionary_id!)}/add-rules`, { rules }));
        case "remove_rules":
          need(a.dictionary_id, "dictionary_id is required for remove_rules");
          need(a.rule_strings?.length, "rule_strings are required for remove_rules");
          return out(await el.postJson(`/v1/pronunciation-dictionaries/${encodeURIComponent(a.dictionary_id!)}/remove-rules`, { rule_strings: a.rule_strings }));
      }
    },
  );

  // 14 -----------------------------------------------------------------
  tool(
    "transcribe",
    "Transcribe speech from an audio/video file to text with word-level timestamps (ElevenLabs Scribe). Give exactly one source: `github_path` (a file in the output repository, e.g. jobs/sl-01-tr/001-balon.mp3) or `url` (a public https URL). Use it to check what was actually said, or to get timings for audio you do not have the script for. If you already have the exact script, use align instead. Costs credits.",
    {
      github_path: z.string().optional().describe("Path of a file inside the GitHub output repository."),
      url: z.string().url().optional().describe("Public https URL of an audio or video file."),
      language: z.string().optional().describe("ISO 639-1 code; omit to auto-detect."),
    },
    { readOnlyHint: true },
    async ({ github_path, url, language }) => {
      if (!!github_path === !!url) throw new AppError("invalid_input", "give exactly one of github_path or url");
      if (url && !/^https:\/\//i.test(url)) throw new AppError("invalid_input", "url must be https");
      const el = new ElevenLabs(env);
      if (url) return await el.transcribe({ url }, language);
      const path = normalizeRepoPath(github_path!);
      const file = await new GitHub(env).readFile(path);
      return { github_path: path, ...(await el.transcribe({ file, fileName: path.split("/").pop() }, language)) };
    },
  );

  // 15 -----------------------------------------------------------------
  tool(
    "align",
    "Forced alignment: given an audio file in the GitHub output repository and the exact text spoken in it, return start/end timestamps for every word. Use it for subtitles or lip-sync on audio that has no manifest timings (e.g. edited or external recordings). Job output already includes word timings in manifest.json, so this is not needed for fresh jobs. Costs credits.",
    {
      github_path: z.string().describe("Path of the audio file inside the GitHub output repository."),
      text: z.string().min(1).describe("The exact transcript of the audio."),
    },
    { readOnlyHint: true },
    async ({ github_path, text }) => {
      const path = normalizeRepoPath(github_path);
      const file = await new GitHub(env).readFile(path);
      return { github_path: path, ...(await new ElevenLabs(env).align(file, path.split("/").pop()!, text)) };
    },
  );

  return server;
}

/** Stateless Streamable HTTP: a fresh server + transport per request, plain JSON responses. */
export async function handleMcp(request: Request, env: Env): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = buildServer(env);
  await server.connect(transport);
  return transport.handleRequest(request);
}
