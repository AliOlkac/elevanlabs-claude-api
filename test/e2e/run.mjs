// End-to-end test: real Worker (wrangler dev, local) against in-memory ElevenLabs + GitHub mocks.
// Usage: npm run test:e2e
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FRAME_SEC, startMock } from "./mock.mjs";

const vars = Object.fromEntries(
  readFileSync(new URL("./dev.vars", import.meta.url), "utf8").split("\n").filter((l) => l && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const SECRETS = [vars.ELEVENLABS_API_KEY, vars.MCP_TOKEN, vars.GITHUB_TOKEN, vars.GITHUB_REPO, vars.APP_PASSWORD];
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE_DIR = ".wrangler/e2e-state";

const mock = await startMock({ port: 8798, elKey: vars.ELEVENLABS_API_KEY, ghToken: vars.GITHUB_TOKEN, repo: vars.GITHUB_REPO });
rmSync(STATE_DIR, { recursive: true, force: true });
const wr = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1", "--env-file", "test/e2e/dev.vars", "--persist-to", STATE_DIR, "--show-interactive-dev-session=false"], {
  stdio: ["ignore", "pipe", "pipe"],
  detached: true, // own process group, so workerd is stopped together with wrangler
  env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
});
let logs = "";
wr.stdout.on("data", (d) => (logs += d));
wr.stderr.on("data", (d) => (logs += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const allOutput = [];
const ok = (name) => console.log(`  ok ${++passed} - ${name}`);

async function main() {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) break;
    } catch {}
    if (i > 120) throw new Error("worker did not start");
    await sleep(500);
  }

  // ---- auth
  assert.equal((await fetch(`${BASE}/mcp`, { method: "POST", body: "{}" })).status, 401);
  assert.equal((await fetch(`${BASE}/mcp`, { method: "POST", headers: { authorization: "Bearer wrong" }, body: "{}" })).status, 401);
  ok("/mcp rejects missing and wrong bearer tokens");

  const client = new Client({ name: "e2e", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${vars.MCP_TOKEN}` } } }));
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content[0].text;
    allOutput.push(text);
    return JSON.parse(text);
  };
  const waitJob = async (job_id, want = ["done", "error", "cancelled"]) => {
    for (let i = 0; i < 300; i++) {
      const j = await call("get_job", { job_id });
      if (want.includes(j.status)) return j;
      await sleep(200);
    }
    throw new Error("job did not finish: " + job_id);
  };
  const st = () => mock.state;
  const head = () => st().git.commits[st().git.head];
  const files = () => st().git.trees[head().tree];
  const fileBytes = (path) => st().git.blobs[files()[path]];

  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map((t) => t.name).sort(), ["account_status", "align", "cancel_job", "design_voice", "estimate_job", "get_job", "list_jobs", "list_models", "list_voices", "music", "pronunciation", "save_voice", "sound_effect", "submit_job", "transcribe"]);
  assert.ok(tools.every((t) => t.description.length > 60));
  ok("15 tools listed with descriptions");

  const acct = await call("account_status");
  assert.equal(acct.credits_remaining, 88000);
  assert.equal(acct.plan, "creator");
  const models = await call("list_models");
  assert.equal(models.default_model, "eleven_v4_turbo");
  assert.equal(models.models.length, 3);
  assert.equal(models.models.find((m) => m.model_id === "eleven_v4").max_characters_per_request, 200);
  assert.equal(models.models.find((m) => m.model_id === "eleven_v4_turbo").supports_mode_dialogue, false);
  assert.equal((await call("list_voices", { search: "burak" })).voices[0].voice_id, "voiceB");
  ok("account_status, list_models, list_voices");

  // ---- lines job on the default model (turbo -> WebSocket)
  const linesJob = {
    job: "sl-01-tr",
    language: "tr",
    items: [
      { name: "001-balon", voice_id: "voiceA", text: "Kırmızı balon gökyüzüne uçtu.", settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.0 } },
      { name: "002-cocuk", voice_id: "voiceA", text: "Çocuk arkasından baktı. Sonra güldü!" },
    ],
  };
  const est = await call("estimate_job", { job: linesJob });
  assert.equal(est.model, "eleven_v4_turbo");
  assert.equal(est.items_total, 2);
  assert.equal(est.cached_items, 0);
  assert.equal(est.characters_to_generate, 29 + 36);
  assert.equal(est.estimated_credits, 32.5);
  assert.equal(st().synthTexts.length, 0, "estimate must not generate");
  ok("estimate_job counts characters and credits without generating");

  const sub = await call("submit_job", { job: linesJob });
  assert.equal(sub.started, true);
  assert.equal(sub.status, "queued");
  let j = await waitJob(sub.job_id);
  assert.equal(j.status, "done", JSON.stringify(j));
  assert.equal(j.done, 2);
  assert.equal(j.github.path, "jobs/sl-01-tr");
  assert.equal(j.github.commit_sha, st().git.head);
  assert.equal(head().message, "job: sl-01-tr");
  assert.deepEqual(Object.keys(files()).filter((f) => f.startsWith("jobs/")).sort(), ["jobs/sl-01-tr/001-balon.mp3", "jobs/sl-01-tr/002-cocuk.mp3", "jobs/sl-01-tr/manifest.json"]);
  const man = JSON.parse(fileBytes("jobs/sl-01-tr/manifest.json").toString());
  assert.equal(man.items.length, 2);
  const it0 = man.items[0];
  assert.deepEqual(Object.keys(it0), ["name", "voice_id", "text", "file", "duration_sec", "characters", "credits", "cached", "words"]);
  assert.equal(it0.file, "001-balon.mp3");
  assert.equal(it0.characters, 29);
  assert.equal(it0.credits, 14.5);
  assert.equal(it0.cached, false);
  assert.ok(Math.abs(it0.duration_sec - 29 * FRAME_SEC) < 0.002);
  assert.deepEqual(it0.words.map((w) => w.word), ["Kırmızı", "balon", "gökyüzüne", "uçtu."]);
  assert.ok(it0.words.every((w, i, a) => w.end > w.start && (i === 0 || w.start >= a[i - 1].end)));
  assert.ok(Math.abs(it0.words[3].end - 29 * FRAME_SEC) < 0.01, "word times continue across websocket chunks");
  assert.equal(fileBytes("jobs/sl-01-tr/001-balon.mp3").length, 29 * 626);
  assert.equal(st().counts["WS stream-input"], 3, "probe + 2 lines over the websocket");
  assert.ok(!st().counts["POST /v1/text-to-dialogue/with-timestamps"], "turbo must not be sent to REST");
  ok("submit_job (lines, turbo via WebSocket) -> one commit with mp3s + manifest with word timestamps");

  // ---- cache
  const before = st().synthTexts.length;
  const commitsBefore = Object.keys(st().git.commits).length;
  assert.equal((await fetch(`${BASE}/mcp`, { headers: { authorization: `Bearer ${vars.MCP_TOKEN}` } })).status, 405);
  const again = await call("submit_job", { job: linesJob });
  assert.equal(again.estimate.cached_items, 2);
  assert.equal(again.estimate.characters_to_generate, 0);
  j = await waitJob(again.job_id);
  assert.equal(j.status, "done");
  assert.equal(j.credits_spent, 0);
  assert.equal(st().synthTexts.length, before, "cached lines must not hit the API");
  assert.equal(Object.keys(st().git.commits).length, commitsBefore + 1, "one commit for the rerun (manifest changed)");
  assert.equal(fileBytes("jobs/sl-01-tr/001-balon.mp3").length, 29 * 626);
  assert.ok(j.manifest_summary.files.every((f) => f.cached));
  ok("resubmitting is served entirely from cache (no API calls, no credits)");

  const forced = await call("submit_job", { job: linesJob, force: true });
  j = await waitJob(forced.job_id);
  assert.equal(st().synthTexts.length, before + 2);
  ok("force=true bypasses the cache");

  const edited = structuredClone(linesJob);
  edited.items[1].text = "Çocuk arkasından baktı. Sonra ağladı!";
  edited.items.pop();
  edited.items.push({ name: "003-yeni", voice_id: "voiceA", text: "Çocuk arkasından baktı. Sonra ağladı!" });
  const ed = await call("submit_job", { job: edited });
  assert.equal(ed.estimate.cached_items, 1);
  j = await waitJob(ed.job_id);
  assert.deepEqual(Object.keys(files()).filter((f) => f.startsWith("jobs/sl-01-tr/")).sort(), ["jobs/sl-01-tr/001-balon.mp3", "jobs/sl-01-tr/003-yeni.mp3", "jobs/sl-01-tr/manifest.json"]);
  ok("edited job only pays for the changed line and removes stale files from the folder");

  // ---- turbo + multi-speaker dialogue: warn, do not reroute
  const dlg = {
    job: "diyalog-01",
    mode: "dialogue",
    language: "tr",
    items: [
      { name: "01-a", voice_id: "voiceA", text: "Merhaba, nasılsın?" },
      { name: "02-b", voice_id: "voiceB", text: "İyiyim, sen nasılsın?" },
      { name: "03-a", voice_id: "voiceA", text: "Ben de iyiyim. Bugün hava çok güzel, değil mi? " + "Yürüyüşe çıkalım mı? ".repeat(6) },
      { name: "04-b", voice_id: "voiceB", text: "Olur, hadi gidelim." },
      { name: "05-uzun", voice_id: "voiceA", text: "Bu çok uzun bir cümle dizisidir. ".repeat(9).trim() },
    ],
  };
  const synthBefore = st().synthTexts.length;
  const turbo = await call("submit_job", { job: dlg });
  assert.equal(turbo.started, false);
  assert.match(turbo.warning, /^turbo desteklenmiyor: /);
  assert.equal(turbo.job_id, undefined);
  assert.equal(st().synthTexts.length, synthBefore);
  ok('turbo + multi-speaker dialogue returns "turbo desteklenmiyor" and generates nothing');

  // ---- dialogue on eleven_v4 (REST), chunking + cutting + long-line splitting
  const d4 = await call("submit_job", { job: { ...dlg, model: "eleven_v4" } });
  assert.equal(d4.started, true, JSON.stringify(d4));
  j = await waitJob(d4.job_id);
  assert.equal(j.status, "done", JSON.stringify(j));
  const dm = JSON.parse(fileBytes("jobs/diyalog-01/manifest.json").toString());
  for (const it of dm.items) {
    const n = [...it.text].length;
    assert.equal(it.characters, n);
    assert.ok(Math.abs(it.duration_sec - n * FRAME_SEC) < 0.03, `${it.name}: duration ${it.duration_sec} vs ${n * FRAME_SEC}`);
    // the long line is sent as two sentence-aligned parts; the single space between them is not synthesised
    const frames = it.name === "05-uzun" ? n - 1 : n;
    assert.equal(fileBytes(`jobs/diyalog-01/${it.file}`).length, frames * 626, `${it.name} cut at the right frames`);
    assert.deepEqual(it.words.map((w) => w.word), it.text.split(/\s+/).filter(Boolean), `${it.name} words`);
    assert.ok(it.words[0].start < 0.03 && it.words.at(-1).end <= it.duration_sec + 0.03, `${it.name} word times are relative to its own file`);
  }
  assert.equal(dm.totals.credits, dm.totals.characters);
  ok("dialogue job (eleven_v4 REST): multi-speaker chunks cut into per-line mp3s with rebased word times; long line split at sentences");

  // ---- retries, context fallback, failing line
  const flaky = await call("submit_job", { job: { job: "retry", model: "eleven_multilingual_v2", items: [{ name: "a", voice_id: "voiceA", text: "FLAKY satır bir." }, { name: "b", voice_id: "voiceA", text: "NOCTX satır iki." }] } });
  j = await waitJob(flaky.job_id);
  assert.equal(j.status, "done", JSON.stringify(j));
  assert.equal(st().flaky["FLAKY satır bir."], 3, "429 then 503 then success");
  assert.ok(j.warnings.some((w) => w.includes("continuity")));
  ok("429/5xx are retried with backoff; unsupported continuity fields are dropped and reported");

  const bad = await call("submit_job", { job: { job: "bozuk", model: "eleven_multilingual_v2", items: [{ name: "iyi", voice_id: "voiceA", text: "Bu satır iyi." }, { name: "kotu", voice_id: "voiceA", text: "BAD satır." }] } });
  j = await waitJob(bad.job_id);
  assert.equal(j.status, "error");
  assert.equal(j.error.error, "items_failed");
  assert.equal(j.failed_items[0].name, "kotu");
  assert.ok(!Object.keys(files()).some((f) => f.startsWith("jobs/bozuk/")), "failed job commits nothing");
  ok("a failing line marks the job as error without committing; good lines stay cached");

  // ---- many lines: more than one tick, 3 in parallel
  const many = { job: "cok", model: "eleven_multilingual_v2", items: Array.from({ length: 80 }, (_, i) => ({ name: `s${String(i).padStart(3, "0")}`, voice_id: i % 2 ? "voiceA" : "voiceB", text: `Satır numarası ${i}.` })) };
  const m = await call("submit_job", { job: many });
  j = await waitJob(m.job_id);
  assert.equal(j.status, "done", JSON.stringify(j));
  assert.equal(j.done, 80);
  assert.equal(Object.keys(files()).filter((f) => f.startsWith("jobs/cok/")).length, 81);
  assert.equal(head().message, "job: cok");
  ok("80-line job spans several background ticks and still lands in a single commit");

  // ---- cancel
  const c = await call("submit_job", { job: { ...many, job: "iptal", force: true } });
  const cv = await call("cancel_job", { job_id: c.job_id });
  j = await waitJob(c.job_id);
  assert.equal(j.status, "cancelled", JSON.stringify(cv));
  assert.ok(!Object.keys(files()).some((f) => f.startsWith("jobs/iptal/")));
  ok("cancel_job stops a job; nothing is committed");

  const list = await call("list_jobs", { limit: 5 });
  assert.equal(list.jobs.length, 5);
  assert.equal(list.jobs[0].job, "iptal");
  assert.equal((await call("get_job", { job_id: "yok--123" })).error, "not_found");
  ok("list_jobs newest first; unknown job_id -> {error, detail}");

  // ---- validation errors come back as {error, detail}
  const inv = await call("submit_job", { job: { job: "x", mode: "dialogue", model: "eleven_multilingual_v2", items: [{ name: "a", voice_id: "v", text: "t" }] } });
  assert.equal(inv.error, "invalid_input");
  const dup = await call("estimate_job", { job: { job: "x", items: [{ name: "a", voice_id: "v", text: "t" }, { name: "A", voice_id: "v", text: "t" }] } });
  assert.equal(dup.error, "invalid_input");
  assert.equal((await call("estimate_job", { job: { job: "x", model: "nope", items: [{ name: "a", voice_id: "v", text: "t" }] } })).error, "unknown_model");
  ok("invalid jobs are rejected with {error, detail}");

  // ---- other tools
  const dv = await call("design_voice", { description: "Sıcak, sakin, orta yaşlı bir kadın anlatıcı sesi.", sample_text: "Bir varmış bir yokmuş. ".repeat(6), language: "tr" });
  assert.equal(dv.previews.length, 3);
  assert.ok(dv.github_path.startsWith("previews/vd-"));
  assert.equal(Object.keys(files()).filter((f) => f.startsWith(dv.github_path + "/")).length, 4);
  assert.equal(dv.commit_sha, st().git.head);
  assert.equal((await call("design_voice", { description: "Sıcak, sakin, orta yaşlı bir kadın.", sample_text: "kısa", language: "tr" })).error, "invalid_input");
  const sv = await call("save_voice", { generated_voice_id: "gen2", name: "Anlatıcı", description: "Sıcak, sakin, orta yaşlı bir kadın anlatıcı sesi." });
  assert.equal(sv.voice_id, "saved_gen2");
  const sfx = await call("sound_effect", { text: "balon patlaması", duration_seconds: 2, name: "balon-pat" });
  assert.equal(sfx.github_path, "sfx/balon-pat.mp3");
  assert.ok(files()["sfx/balon-pat.mp3"] && Math.abs(sfx.duration_sec - 2) < 0.05);
  const mu = await call("music", { prompt: "neşeli çocuk müziği", duration_seconds: 5, name: "tema" });
  assert.equal(mu.github_path, "music/tema.mp3");
  assert.equal(st().lastBodies["/v1/music"].force_instrumental, true);
  assert.equal(head().message, "music: tema");
  assert.equal((await call("sound_effect", { text: "x", name: "../kacis" })).error !== undefined, true);
  ok("design_voice, save_voice, sound_effect, music deliver to GitHub");

  assert.equal((await call("pronunciation", { action: "list" })).dictionaries[0].dictionary_id, "pd_1");
  const pc = await call("pronunciation", { action: "create", name: "isimler", rules: [{ string_to_replace: "Gon", alias: "Gon" }] });
  assert.equal(pc.dictionary_id, "pd_1");
  assert.equal(st().lastBodies["/v1/pronunciation-dictionaries/add-from-rules"].rules[0].type, "alias");
  assert.equal((await call("pronunciation", { action: "add_rules", rules: [{ string_to_replace: "a", alias: "b" }] })).error, "invalid_input");
  const dictJob = { job: "sozluk", model: "eleven_multilingual_v2", pronunciation_dictionary_id: "pd_1", items: [{ name: "a", voice_id: "voiceA", text: "Gon geldi." }] };
  await waitJob((await call("submit_job", { job: dictJob })).job_id);
  assert.deepEqual(st().lastBodies["/v1/text-to-speech/voiceA/with-timestamps"].pronunciation_dictionary_locators, [{ pronunciation_dictionary_id: "pd_1", version_id: "v1" }]);
  assert.equal((await call("estimate_job", { job: dictJob })).cached_items, 1);
  await call("pronunciation", { action: "add_rules", dictionary_id: "pd_1", rules: [{ string_to_replace: "Killua", alias: "Kilua" }] });
  assert.equal((await call("estimate_job", { job: dictJob })).cached_items, 0, "a new dictionary version invalidates the cache");
  await call("pronunciation", { action: "remove_rules", dictionary_id: "pd_1", rule_strings: ["Killua"] });
  ok("pronunciation dictionaries: list/create/add/remove, applied to jobs, part of the cache key");

  const tr = await call("transcribe", { github_path: "jobs/sl-01-tr/001-balon.mp3", language: "tr" });
  assert.deepEqual(tr.words, [{ word: "merhaba", start: 0, end: 0.5 }, { word: "dünya", start: 0.6, end: 1 }]);
  assert.equal((await call("transcribe", {})).error, "invalid_input");
  assert.equal((await call("transcribe", { github_path: "yok/dosya.mp3" })).error, "not_found");
  assert.equal((await call("transcribe", { github_path: "../x" })).error, "invalid_input");
  const al = await call("align", { github_path: "jobs/sl-01-tr/001-balon.mp3", text: "merhaba" });
  assert.equal(al.words[0].word, "merhaba");
  ok("transcribe and align read audio from the GitHub repository");

  // ---- panel
  assert.equal((await fetch(`${BASE}/api/overview`)).status, 401);
  const badLogin = await fetch(`${BASE}/login`, { method: "POST", body: new URLSearchParams({ password: "nope" }), redirect: "manual" });
  assert.equal(badLogin.status, 401);
  const xs = await fetch(`${BASE}/login`, { method: "POST", headers: { "sec-fetch-site": "cross-site" }, body: new URLSearchParams({ password: vars.APP_PASSWORD }), redirect: "manual" });
  assert.equal(xs.status, 403, "cross-site form posts are refused");
  // browsers send Origin: null on some same-origin form posts; Sec-Fetch-Site decides
  const login = await fetch(`${BASE}/login`, { method: "POST", headers: { origin: "null", "sec-fetch-site": "same-origin" }, body: new URLSearchParams({ password: vars.APP_PASSWORD }), redirect: "manual" });
  assert.equal(login.status, 303);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.match(login.headers.get("set-cookie"), /HttpOnly/);
  const H = { cookie, "content-type": "application/json" };
  const page = await (await fetch(`${BASE}/`, { headers: H })).text();
  assert.ok(page.includes("Bütçe") && page.includes("İşler"));
  allOutput.push(page);
  const ov = await (await fetch(`${BASE}/api/overview`, { headers: H })).json();
  allOutput.push(JSON.stringify(ov));
  assert.equal(ov.account.credits_remaining, 88000);
  assert.ok(ov.jobs.length >= 8);
  assert.ok(ov.usage.characters > 0);
  const det = await (await fetch(`${BASE}/api/jobs/${sub.job_id}`, { headers: H })).json();
  assert.equal(det.items.length, 2);
  assert.ok(det.items[0].ready);
  const au = await fetch(`${BASE}/api/audio/${sub.job_id}/0`, { headers: H });
  assert.equal(au.headers.get("content-type"), "audio/mpeg");
  assert.equal((await au.arrayBuffer()).byteLength, 29 * 626);
  const rg = await fetch(`${BASE}/api/audio/${sub.job_id}/0`, { headers: { ...H, range: "bytes=0-99" } });
  assert.equal(rg.status, 206);
  assert.equal((await rg.arrayBuffer()).byteLength, 100);
  assert.equal((await fetch(`${BASE}/api/audio/${sub.job_id}/0`)).status, 401);
  ok("panel: login, overview, job detail, audio playback with range requests");

  // ---- budget
  let put = await fetch(`${BASE}/api/settings`, { method: "PUT", headers: H, body: JSON.stringify({ per_job_char_limit: 10, monthly_char_limit: 0 }) });
  assert.equal(put.status, 200);
  const synthB = st().synthTexts.length;
  const over = await call("submit_job", { job: { job: "butce", model: "eleven_multilingual_v2", items: [{ name: "a", voice_id: "voiceA", text: "Bu metin on karakterden uzundur." }] } });
  assert.equal(over.started, false);
  assert.match(over.reason, /per-job limit of 10/);
  await fetch(`${BASE}/api/settings`, { method: "PUT", headers: H, body: JSON.stringify({ per_job_char_limit: 0, monthly_char_limit: 100 }) });
  const over2 = await call("submit_job", { job: { job: "butce", model: "eleven_multilingual_v2", items: [{ name: "a", voice_id: "voiceA", text: "Bu metin on karakterden uzundur." }] } });
  assert.equal(over2.started, false);
  assert.match(over2.reason, /monthly limit of 100/);
  assert.equal(st().synthTexts.length, synthB);
  assert.equal((await fetch(`${BASE}/api/settings`, { method: "PUT", headers: H, body: JSON.stringify({ per_job_char_limit: -1, monthly_char_limit: 0 }) })).status, 400);
  ok("budget: per-job and monthly limits block a job before it starts, with the reason");

  // ---- OAuth sign-in (what Claude's connector does when no static header is configured)
  {
    const { createHash, randomBytes } = await import("node:crypto");
    const un = await fetch(`${BASE}/mcp`, { method: "POST", body: "{}" });
    assert.match(un.headers.get("www-authenticate"), /resource_metadata="http:\/\/127\.0\.0\.1:8799\/\.well-known\/oauth-protected-resource"/);
    const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.equal(prm.authorization_servers[0], BASE);
    const meta = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
    const cb = "https://claude.ai/api/mcp/auth_callback";
    assert.equal((await fetch(meta.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["javascript:alert(1)"] }) })).status, 400);
    const reg = await fetch(meta.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [cb] }) });
    assert.equal(reg.status, 201);
    const { client_id } = await reg.json();
    const verifier = randomBytes(32).toString("base64url");
    const q = new URLSearchParams({ response_type: "code", client_id, redirect_uri: cb, state: "xyz", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" });
    const page = await fetch(`${meta.authorization_endpoint}?${q}`);
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes("İzin ver"));
    assert.equal((await fetch(`${meta.authorization_endpoint}?${new URLSearchParams({ ...Object.fromEntries(q), redirect_uri: "https://evil.example/cb" })}`)).status, 400);
    const wrong = await fetch(meta.authorization_endpoint, { method: "POST", body: new URLSearchParams({ ...Object.fromEntries(q), password: "nope" }), redirect: "manual" });
    assert.equal(wrong.status, 401);
    const okk = await fetch(meta.authorization_endpoint, { method: "POST", body: new URLSearchParams({ ...Object.fromEntries(q), password: vars.APP_PASSWORD }), redirect: "manual" });
    assert.equal(okk.status, 302);
    const loc = new URL(okk.headers.get("location"));
    assert.equal(loc.origin + loc.pathname, cb);
    assert.equal(loc.searchParams.get("state"), "xyz");
    const code = loc.searchParams.get("code");
    const tok = (body) => fetch(meta.token_endpoint, { method: "POST", body: new URLSearchParams(body) });
    assert.equal((await tok({ grant_type: "authorization_code", code, client_id, redirect_uri: cb, code_verifier: "wrong-verifier" })).status, 400);
    const t = await (await tok({ grant_type: "authorization_code", code, client_id, redirect_uri: cb, code_verifier: verifier })).json();
    assert.equal(t.token_type, "Bearer");
    const oc = new Client({ name: "oauth", version: "1" });
    await oc.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${t.access_token}` } } }));
    assert.equal((await oc.listTools()).tools.length, 15);
    await oc.close();
    const t2 = await (await tok({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id })).json();
    assert.ok(t2.access_token);
    // a refresh token or a tampered token must not work as an access token
    assert.equal((await fetch(`${BASE}/mcp`, { method: "POST", headers: { authorization: `Bearer ${t.refresh_token}` }, body: "{}" })).status, 401);
    assert.equal((await fetch(`${BASE}/mcp`, { method: "POST", headers: { authorization: `Bearer ${t.access_token.slice(0, -1)}0` }, body: "{}" })).status, 401);
    allOutput.push(JSON.stringify(meta), JSON.stringify(prm));
    ok("OAuth: discovery, client registration, password consent, PKCE code exchange, refresh; token opens /mcp");
  }

  // ---- secrets
  const dump = allOutput.join("\n") + logs;
  for (const sec of SECRETS) assert.ok(!dump.includes(sec), `secret leaked: ${sec.slice(0, 6)}…`);
  assert.equal(st().seenSecretsInBodies, false, "secrets must only travel in auth headers");
  assert.equal(st().badAuth, 0);
  ok("no secret appears in tool results, panel responses, worker logs, request bodies or URLs");

  await client.close();
}

let code = 0;
try {
  await main();
  console.log(`\n${passed} checks passed`);
} catch (e) {
  code = 1;
  console.error("\nFAILED:", e);
  console.error("\n--- worker log tail ---\n" + logs.split("\n").slice(-40).join("\n"));
} finally {
  try {
    process.kill(-wr.pid, "SIGTERM");
  } catch {}
  mock.close();
  setTimeout(() => process.exit(code), 500);
}
