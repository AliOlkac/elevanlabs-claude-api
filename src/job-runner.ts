/**
 * One Durable Object per job. Work is driven by alarms: every alarm ("tick") renders a bounded
 * number of requests, persists each finished line, then re-arms itself. A crashed or evicted tick
 * is simply followed by the next one, which skips everything already stored.
 */
import { DurableObject } from "cloudflare:workers";
import { ElevenLabs, ElevenLabsError, type Synthesis } from "./elevenlabs";
import { OUTPUT_FORMAT, PARALLEL_REQUESTS, type Env } from "./env";
import { GitHub, groupBySize, type Head, type TreeEntry } from "./github";
import { concatMp3, cutMp3, indexMp3, mp3Duration } from "./mp3";
import { cacheAudioKey, cacheMetaKey, planUnits, type PreparedItem, type PreparedJob, type Unit } from "./planner";
import { putJobSummary, type JobStatus } from "./store";
import { head, shiftWords, tail, wordsFromAlignment, type Word } from "./text";
import { AppError, pool, round2, round3, toErrorPayload } from "./util";

/** External (non-Cloudflare) requests allowed per tick; keeps a tick inside the Workers Free subrequest limit. */
const EXTERNAL_BUDGET = 36;
const TICK_MS = 120_000;
const WATCHDOG_MS = 5 * 60_000;

interface ItemResult {
  index: number;
  audio_key: string;
  bytes: number;
  duration_sec: number;
  characters: number;
  credits: number;
  cached: boolean;
  words: Word[];
}

interface CacheMeta {
  duration_sec: number;
  characters: number;
  bytes: number;
  words: Word[];
  model: string;
  created_at: string;
}

interface State {
  status: JobStatus;
  phase: "generate" | "commit" | "finished";
  cache_checked: boolean;
  no_context: boolean;
  cancel: boolean;
  warnings: string[];
  warning?: string;
  error?: { error: string; detail: string };
  failed: { index: number; name: string; detail: string }[];
  credits: number;
  chars_sent: number;
  started_at?: string;
  finished_at?: string;
  commit?: { blobs: Record<string, string>; groups_done: number; shas: string[]; head?: Head };
  github?: { path: string; manifest_path: string; commit_sha: string; commits: string[] };
  totals?: { items: number; duration_sec: number; characters: number; credits: number; cached_items: number };
}

export interface JobView {
  job_id: string;
  job: string;
  status: JobStatus;
  phase: string;
  done: number;
  total: number;
  credits_spent: number;
  characters_sent: number;
  model: string;
  mode: string;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  warning?: string;
  warnings?: string[];
  error?: { error: string; detail: string };
  failed_items?: { name: string; detail: string }[];
  github?: State["github"];
  manifest_summary?: State["totals"] & { files: { name: string; file: string; duration_sec: number; cached: boolean }[] };
  items?: { index: number; name: string; voice_id: string; text: string; ready: boolean; duration_sec?: number; cached?: boolean; credits?: number; error?: string }[];
}

const resKey = (i: number) => `res:${String(i).padStart(4, "0")}`;

class Budget {
  used = 0;
  readonly started = Date.now();
  constructor(private max = EXTERNAL_BUDGET) {}
  take = () => {
    this.used++;
  };
  /** True while another unit needing `n` external requests may start. */
  has(n = 1): boolean {
    return this.used + n <= this.max && Date.now() - this.started < TICK_MS;
  }
}

export class JobRunner extends DurableObject<Env> {
  private spec: PreparedJob | null = null;
  private state: State | null = null;
  private ticking = false;

  private async load(): Promise<boolean> {
    if (this.spec && this.state) return true;
    const [spec, state] = await Promise.all([this.ctx.storage.get<PreparedJob>("spec"), this.ctx.storage.get<State>("state")]);
    if (!spec || !state) return false;
    this.spec = spec;
    this.state = state;
    return true;
  }

  private save(): Promise<void> {
    return this.ctx.storage.put("state", this.state!);
  }

  private async results(): Promise<Map<number, ItemResult>> {
    const m = await this.ctx.storage.list<ItemResult>({ prefix: "res:" });
    return new Map([...m.values()].map((r) => [r.index, r]));
  }

  // ------------------------------------------------------------------ RPC

  async start(spec: PreparedJob): Promise<void> {
    if (await this.load()) throw new AppError("conflict", "job already exists");
    this.spec = spec;
    this.state = {
      status: "queued",
      phase: "generate",
      cache_checked: false,
      no_context: false,
      cancel: false,
      warnings: [...spec.warnings],
      failed: [],
      credits: 0,
      chars_sent: 0,
    };
    await this.ctx.storage.put({ spec, state: this.state });
    await this.publish(0);
    await this.ctx.storage.setAlarm(Date.now());
  }

  async status(withItems = false): Promise<JobView | null> {
    if (!(await this.load())) return null;
    return this.view(await this.results(), withItems);
  }

  async cancel(): Promise<JobView | null> {
    if (!(await this.load())) return null;
    const s = this.state!;
    if (s.status === "queued" || s.status === "running") {
      s.cancel = true;
      if (!this.ticking) await this.finish("cancelled");
      else await this.save();
    }
    return this.view(await this.results(), false);
  }

  /** R2 key of a finished line (web panel playback). */
  async audioKey(index: number): Promise<string | null> {
    return (await this.ctx.storage.get<ItemResult>(resKey(index)))?.audio_key ?? null;
  }

  // ------------------------------------------------------------------ scheduling

  async alarm(): Promise<void> {
    if (!(await this.load())) return;
    const s = this.state!;
    if (s.status !== "queued" && s.status !== "running") return;
    if (this.ticking) return;
    this.ticking = true;
    await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
    try {
      if (s.cancel) return await this.finish("cancelled");
      if (s.status === "queued") {
        s.status = "running";
        s.started_at = new Date().toISOString();
        await this.save();
      }
      const budget = new Budget();
      if (s.phase === "generate") await this.generate(budget);
      if (s.phase === "commit" && s.status === "running") await this.commit(budget);
    } catch (e) {
      console.error("job tick failed:", toErrorPayload(this.env, e).detail);
      s.error = toErrorPayload(this.env, e);
      await this.finish("error");
    } finally {
      this.ticking = false;
      const active = s.status === "queued" || s.status === "running";
      if (active) {
        await this.save();
        await this.publish((await this.results()).size);
        await this.ctx.storage.setAlarm(Date.now() + 50);
      } else {
        await this.ctx.storage.deleteAlarm();
      }
    }
  }

  private async finish(status: JobStatus): Promise<void> {
    const s = this.state!;
    s.status = status;
    s.phase = "finished";
    s.finished_at = new Date().toISOString();
    await this.save();
    await this.publish((await this.results()).size);
  }

  private async publish(done: number): Promise<void> {
    const spec = this.spec!;
    const s = this.state!;
    const active = s.status === "queued" || s.status === "running";
    try {
      await putJobSummary(this.env, {
        job_id: spec.job_id,
        job: spec.job,
        status: s.status,
        model: spec.model,
        mode: spec.mode,
        done,
        total: spec.items.length,
        // while running, reserve the whole estimate against the monthly budget
        chars: active ? Math.max(spec.est_chars, s.chars_sent) : s.chars_sent,
        credits: round2(s.credits),
        created_at: spec.created_at,
        ...(s.finished_at ? { finished_at: s.finished_at } : {}),
        ...(s.github ? { commit: s.github.commit_sha } : {}),
      });
    } catch (e) {
      console.error("index update failed:", toErrorPayload(this.env, e).detail);
    }
  }

  // ------------------------------------------------------------------ generation

  private async generate(budget: Budget): Promise<void> {
    const spec = this.spec!;
    const s = this.state!;
    const done = await this.results();

    if (!s.cache_checked) {
      if (!spec.force) {
        const todo = spec.items.map((_, i) => i).filter((i) => !done.has(i));
        await pool(todo, 10, async (i) => {
          const meta = await this.env.AUDIO.get(cacheMetaKey(spec.items[i].key));
          if (!meta) return;
          const m = (await meta.json()) as CacheMeta;
          const r: ItemResult = {
            index: i,
            audio_key: cacheAudioKey(spec.items[i].key),
            bytes: m.bytes,
            duration_sec: m.duration_sec,
            characters: spec.items[i].characters,
            credits: 0,
            cached: true,
            words: m.words,
          };
          await this.ctx.storage.put(resKey(i), r);
          done.set(i, r);
        });
      }
      s.cache_checked = true;
      await this.save();
    }

    const failed = new Set(s.failed.map((f) => f.index));
    const pending = spec.items.map((_, i) => !done.has(i) && !failed.has(i));
    const units = planUnits(spec.items, pending, { mode: spec.mode, route: spec.route, limit: spec.limit });
    const el = new ElevenLabs(this.env);
    const stop: { fatal: ElevenLabsError | null } = { fatal: null };
    let leftover = false;

    await pool(units, PARALLEL_REQUESTS, async (unit) => {
      if (s.cancel || stop.fatal) return false;
      // worst case: every part retried to the limit would overshoot, so reserve one attempt per part
      if (!budget.has(unit.kind === "single" ? unit.parts.length : 1) && budget.used > 0) {
        leftover = true;
        return false;
      }
      const idxs = unit.kind === "single" ? [unit.item] : unit.items;
      try {
        const out = unit.kind === "single" ? [await this.runSingle(el, unit, budget)] : await this.runDialogue(el, unit, budget);
        for (const r of out) {
          await this.ctx.storage.put(resKey(r.index), r);
          done.set(r.index, r);
          s.credits += r.credits;
          s.chars_sent += r.characters;
        }
      } catch (e) {
        const p = toErrorPayload(this.env, e);
        if (e instanceof ElevenLabsError && e.fatal) {
          stop.fatal = e;
          return false;
        }
        for (const i of idxs) s.failed.push({ index: i, name: spec.items[i].name, detail: p.detail });
      }
    });

    if (s.cancel) return this.finish("cancelled");
    if (stop.fatal) {
      s.error = toErrorPayload(this.env, stop.fatal);
      return this.finish("error");
    }
    if (leftover || done.size + s.failed.length < spec.items.length) return; // continue on the next tick
    if (s.failed.length) {
      const first = s.failed[0];
      s.error = {
        error: "items_failed",
        detail: `${s.failed.length} of ${spec.items.length} lines failed (first: ${first.name}: ${first.detail}). Finished lines are cached; fix the input and submit the job again — only the failed lines will be charged.`,
      };
      if (spec.route === "dialogue_ws" && done.size === 0) {
        s.warning = `turbo desteklenmiyor: ${first.detail}. The job was NOT rerouted to another model; resubmit with model "eleven_v4" if that is acceptable.`;
      }
      return this.finish("error");
    }
    s.phase = "commit";
    await this.save();
  }

  /** Text of the neighbouring line when it is spoken by the same voice (prosody continuity in "lines" mode). */
  private neighbour(i: number, dir: -1 | 1): string | undefined {
    const items = this.spec!.items;
    const n = items[i + dir];
    return n && n.voice_id === items[i].voice_id ? n.text : undefined;
  }

  private async synth(
    el: ElevenLabs,
    item: PreparedItem,
    text: string,
    ctx: { prev?: string; next?: string; prevIds?: string[] },
    budget: Budget,
  ): Promise<Synthesis> {
    const spec = this.spec!;
    const s = this.state!;
    const base = { model: spec.model, language: spec.language, settings: item.settings, dictionary: spec.dictionary, onAttempt: budget.take };
    if (spec.route === "dialogue_ws") return el.dialogueWs({ ...base, voiceId: item.voice_id, text });
    const call = (withCtx: boolean) =>
      spec.route === "tts_rest"
        ? el.tts({
            ...base,
            voiceId: item.voice_id,
            text,
            ...(withCtx ? { previousText: ctx.prev && tail(ctx.prev, 300), nextText: ctx.next && head(ctx.next, 300), previousRequestIds: ctx.prevIds } : {}),
          })
        : el.dialogue({
            ...base,
            inputs: [{ text, voice_id: item.voice_id }],
            ...(withCtx ? { previousText: ctx.prev && tail(ctx.prev, 100), futureText: ctx.next && head(ctx.next, 100), previousRequestIds: ctx.prevIds } : {}),
          });
    const hasCtx = !!(ctx.prev || ctx.next || ctx.prevIds?.length);
    if (s.no_context || !hasCtx) return call(false);
    try {
      return await call(true);
    } catch (e) {
      // Continuity fields are "not supported by every model": retry once without them and remember.
      if (!(e instanceof ElevenLabsError) || (e.status !== 400 && e.status !== 422)) throw e;
      const r = await call(false);
      if (!s.no_context) {
        s.no_context = true;
        s.warnings.push(`model ${spec.model} rejected continuity fields (previous/next text, previous_request_ids); lines were generated without them`);
      }
      return r;
    }
  }

  private async runSingle(el: ElevenLabs, unit: Extract<Unit, { kind: "single" }>, budget: Budget): Promise<ItemResult> {
    const spec = this.spec!;
    const item = spec.items[unit.item];
    const audios: Uint8Array[] = [];
    const words: Word[] = [];
    const ids: string[] = [];
    let offset = 0;
    let cost = 0;
    let costKnown = true;
    for (let p = 0; p < unit.parts.length; p++) {
      const syn = await this.synth(
        el,
        item,
        unit.parts[p],
        {
          prev: p > 0 ? unit.parts[p - 1] : this.neighbour(unit.item, -1),
          next: p + 1 < unit.parts.length ? unit.parts[p + 1] : this.neighbour(unit.item, 1),
          prevIds: ids,
        },
        budget,
      );
      const dur = mp3Duration(syn.audio);
      if (!syn.audio.length || dur === 0) throw new AppError("elevenlabs_error", "the API returned no audio");
      if (syn.alignment) words.push(...shiftWords(wordsFromAlignment(syn.alignment), offset));
      audios.push(syn.audio);
      offset += dur;
      if (syn.requestId) ids.push(syn.requestId);
      if (syn.cost === null) costKnown = false;
      else cost += syn.cost;
    }
    const audio = concatMp3(audios);
    return this.store(unit.item, audio, mp3Duration(audio), words, costKnown ? cost : item.characters * spec.multiplier);
  }

  private async runDialogue(el: ElevenLabs, unit: Extract<Unit, { kind: "dialogue" }>, budget: Budget): Promise<ItemResult[]> {
    const spec = this.spec!;
    const s = this.state!;
    const idxs = unit.items;
    const items = idxs.map((i) => spec.items[i]);
    const before = spec.items[idxs[0] - 1]?.text;
    const after = spec.items[idxs[idxs.length - 1] + 1]?.text;
    const req = {
      model: spec.model,
      language: spec.language,
      settings: items[0].settings,
      dictionary: spec.dictionary,
      inputs: items.map((it) => ({ text: it.text, voice_id: it.voice_id })),
      onAttempt: budget.take,
    };
    let syn: Synthesis;
    const withCtx = !s.no_context && !!(before || after);
    try {
      syn = await el.dialogue({ ...req, ...(withCtx ? { previousText: before && tail(before, 100), futureText: after && head(after, 100) } : {}) });
    } catch (e) {
      if (!withCtx || !(e instanceof ElevenLabsError) || (e.status !== 400 && e.status !== 422)) throw e;
      syn = await el.dialogue(req);
      s.no_context = true;
      s.warnings.push(`model ${spec.model} rejected continuity fields (previous/future text); dialogue was generated without them`);
    }
    const al = syn.alignment;
    if (!al) throw new AppError("elevenlabs_error", "dialogue response had no timestamps, cannot cut it into lines");

    // Character range + time span of every input line.
    const spans = items.map(() => ({ ranges: [] as [number, number][], start: Infinity, end: -Infinity }));
    for (const seg of syn.segments ?? []) {
      const sp = spans[seg.input];
      if (!sp) continue;
      sp.ranges.push([seg.from, seg.to]);
      sp.start = Math.min(sp.start, seg.start);
      sp.end = Math.max(sp.end, seg.end);
    }
    if (spans.some((sp) => !sp.ranges.length)) {
      // No usable voice_segments: fall back to the position of each line inside the concatenated text.
      let pos = 0;
      items.forEach((it, k) => {
        const len = [...it.text].length;
        const from = Math.min(pos, al.characters.length - 1);
        const to = Math.min(pos + len, al.characters.length);
        spans[k] = { ranges: [[from, to]], start: al.starts[from] ?? 0, end: al.ends[Math.max(from, to - 1)] ?? 0 };
        pos += len;
      });
    }
    const index = indexMp3(syn.audio);
    // Cut in the middle of the pause between two lines; nothing is dropped.
    const boundaries = spans.map((sp, k) => (k === 0 ? 0 : (spans[k - 1].end + sp.start) / 2));
    const cuts = cutMp3(syn.audio, index, boundaries);
    const totalChars = items.reduce((n, it) => n + it.characters, 0);
    const totalCost = syn.cost ?? totalChars * spec.multiplier;

    const out: ItemResult[] = [];
    for (let k = 0; k < items.length; k++) {
      const cut = cuts[k];
      if (!cut.bytes.length) throw new AppError("elevenlabs_error", `could not locate line "${items[k].name}" in the dialogue audio`);
      const words = spans[k].ranges.flatMap(([from, to]) => wordsFromAlignment(al, from, to, cut.start));
      out.push(await this.store(idxs[k], cut.bytes, cut.duration, words, (totalCost * items[k].characters) / totalChars));
    }
    return out;
  }

  /** Writes a rendered line to the cache (audio first, metadata last = commit marker). */
  private async store(i: number, audio: Uint8Array, duration: number, words: Word[], credits: number): Promise<ItemResult> {
    const spec = this.spec!;
    const item = spec.items[i];
    const meta: CacheMeta = {
      duration_sec: round3(duration),
      characters: item.characters,
      bytes: audio.length,
      words,
      model: spec.model,
      created_at: new Date().toISOString(),
    };
    await this.env.AUDIO.put(cacheAudioKey(item.key), audio, { httpMetadata: { contentType: "audio/mpeg" } });
    await this.env.AUDIO.put(cacheMetaKey(item.key), JSON.stringify(meta), { httpMetadata: { contentType: "application/json" } });
    return {
      index: i,
      audio_key: cacheAudioKey(item.key),
      bytes: audio.length,
      duration_sec: meta.duration_sec,
      characters: item.characters,
      credits: round2(credits),
      cached: false,
      words,
    };
  }

  // ------------------------------------------------------------------ delivery

  private manifest(done: Map<number, ItemResult>) {
    const spec = this.spec!;
    const items = spec.items.map((it, i) => {
      const r = done.get(i)!;
      return {
        name: it.name,
        voice_id: it.voice_id,
        text: it.text,
        file: `${it.name}.mp3`,
        duration_sec: r.duration_sec,
        characters: r.characters,
        credits: r.credits,
        cached: r.cached,
        words: r.words,
      };
    });
    const totals = {
      items: items.length,
      duration_sec: round3(items.reduce((n, x) => n + x.duration_sec, 0)),
      characters: items.reduce((n, x) => n + x.characters, 0),
      credits: round2(items.reduce((n, x) => n + x.credits, 0)),
      cached_items: items.filter((x) => x.cached).length,
    };
    return {
      totals,
      doc: {
        job: spec.job,
        job_id: spec.job_id,
        model: spec.model,
        mode: spec.mode,
        language: spec.language ?? null,
        output_format: OUTPUT_FORMAT,
        pronunciation_dictionary_id: spec.dictionary?.pronunciation_dictionary_id ?? null,
        created_at: spec.created_at,
        totals,
        items,
      },
    };
  }

  private async commit(budget: Budget): Promise<void> {
    const spec = this.spec!;
    const s = this.state!;
    const done = await this.results();
    const dir = `jobs/${spec.job}`;
    const { doc, totals } = this.manifest(done);
    const manifestBytes = new TextEncoder().encode(JSON.stringify(doc, null, 2) + "\n");
    const files = spec.items.map((it, i) => ({ path: `${dir}/${it.name}.mp3`, key: done.get(i)!.audio_key as string | null, bytes: done.get(i)!.bytes }));
    files.push({ path: `${dir}/manifest.json`, key: null, bytes: manifestBytes.length });
    const groups = groupBySize(files);
    const gh = new GitHub(this.env);
    const c = (s.commit ??= { blobs: {}, groups_done: 0, shas: [] });

    for (let g = c.groups_done; g < groups.length; g++) {
      const missing = groups[g].filter((f) => !c.blobs[f.path]);
      let out = false;
      await pool(missing, PARALLEL_REQUESTS, async (f) => {
        if (!budget.has(8)) {
          out = true;
          return false;
        }
        budget.take();
        let bytes = manifestBytes;
        if (f.key) {
          const obj = await this.env.AUDIO.get(f.key);
          if (!obj) throw new AppError("storage_error", `audio for ${f.path} is missing from storage; submit the job again`);
          bytes = new Uint8Array(await obj.arrayBuffer());
        }
        c.blobs[f.path] = await gh.createBlob(bytes);
      });
      await this.save();
      if (out) return; // next tick continues the uploads

      const entries: TreeEntry[] = groups[g].map((f) => ({ path: f.path, sha: c.blobs[f.path] }));
      const headNow = await gh.head();
      if (g === 0) {
        // Make the folder mirror this run: drop files left over from an earlier, different submission.
        const keep = new Set(files.map((f) => f.path));
        for (const old of await gh.listDir(dir, headNow.commit)) if (!keep.has(old)) entries.push({ path: old, sha: null });
      }
      const message = groups.length === 1 ? `job: ${spec.job}` : `job: ${spec.job} (${g + 1}/${groups.length})`;
      const r = await gh.commit(message, entries, headNow);
      for (let n = 0; n < 8; n++) budget.take();
      c.shas.push(r.sha);
      c.groups_done = g + 1;
      await this.save();
    }

    s.github = { path: dir, manifest_path: `${dir}/manifest.json`, commit_sha: c.shas[c.shas.length - 1], commits: c.shas };
    s.totals = totals;
    await this.finish("done");
  }

  // ------------------------------------------------------------------ views

  private view(done: Map<number, ItemResult>, withItems: boolean): JobView {
    const spec = this.spec!;
    const s = this.state!;
    const v: JobView = {
      job_id: spec.job_id,
      job: spec.job,
      status: s.status,
      phase: s.phase,
      done: done.size,
      total: spec.items.length,
      credits_spent: round2(s.credits),
      characters_sent: s.chars_sent,
      model: spec.model,
      mode: spec.mode,
      created_at: spec.created_at,
      ...(s.started_at ? { started_at: s.started_at } : {}),
      ...(s.finished_at ? { finished_at: s.finished_at } : {}),
      ...(s.warning ? { warning: s.warning } : {}),
      ...(s.warnings.length ? { warnings: s.warnings } : {}),
      ...(s.error ? { error: s.error } : {}),
      ...(s.failed.length ? { failed_items: s.failed.map((f) => ({ name: f.name, detail: f.detail })) } : {}),
    };
    if (s.status === "done" && s.github && s.totals) {
      v.github = s.github;
      v.manifest_summary = {
        ...s.totals,
        files: spec.items.map((it, i) => ({
          name: it.name,
          file: `${s.github!.path}/${it.name}.mp3`,
          duration_sec: done.get(i)?.duration_sec ?? 0,
          cached: done.get(i)?.cached ?? false,
        })),
      };
    }
    if (withItems) {
      const failed = new Map(s.failed.map((f) => [f.index, f.detail]));
      v.items = spec.items.map((it, i) => {
        const r = done.get(i);
        return {
          index: i,
          name: it.name,
          voice_id: it.voice_id,
          text: it.text,
          ready: !!r,
          ...(r ? { duration_sec: r.duration_sec, cached: r.cached, credits: r.credits } : {}),
          ...(failed.has(i) ? { error: failed.get(i) } : {}),
        };
      });
    }
    return v;
  }
}
