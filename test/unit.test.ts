import { describe, expect, it } from "vitest";
import { groupBySize } from "../src/github";
import { concatMp3, cutMp3, indexMp3 } from "../src/mp3";
import { cacheKey, planUnits } from "../src/planner";
import { splitText, wordsFromAlignment } from "../src/text";
import { charCount, redact } from "../src/util";

const FRAME = (() => {
  const f = new Uint8Array(626);
  f.set([0xff, 0xfb, 0xb0, 0x00]);
  return f;
})();
const mp3 = (n: number) => {
  const out = new Uint8Array(n * 626);
  for (let i = 0; i < n; i++) out.set(FRAME, i * 626);
  return out;
};
const FD = 1152 / 44100;

describe("mp3", () => {
  it("indexes CBR frames and skips an ID3 tag", () => {
    const tag = new Uint8Array(10 + 20);
    tag.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 20]);
    const buf = new Uint8Array(tag.length + 626 * 10);
    buf.set(tag);
    buf.set(mp3(10), tag.length);
    const idx = indexMp3(buf);
    expect(idx.frames.length).toBe(10);
    expect(idx.frames[0].offset).toBe(30);
    expect(idx.duration).toBeCloseTo(10 * FD, 6);
  });
  it("cuts at frame boundaries without losing or duplicating frames", () => {
    const buf = mp3(100);
    const cuts = cutMp3(buf, indexMp3(buf), [0, 30.4 * FD, 70 * FD]);
    expect(cuts.map((c) => c.bytes.length / 626)).toEqual([30, 40, 30]);
    expect(cuts[1].start).toBeCloseTo(30 * FD, 6);
    expect(cuts.reduce((n, c) => n + c.bytes.length, 0)).toBe(buf.length);
  });
  it("concatenates files", () => {
    expect(indexMp3(concatMp3([mp3(3), mp3(4)])).frames.length).toBe(7);
  });
});

describe("text", () => {
  it("splits at sentence boundaries and keeps every word", () => {
    const text = "Birinci cümle burada. İkinci cümle de burada! Üçüncü cümle biraz daha uzun olsun mu? Evet.";
    const parts = splitText(text, 50);
    expect(parts.every((p) => charCount(p) <= 50)).toBe(true);
    expect(parts[0]).toBe("Birinci cümle burada. İkinci cümle de burada!");
    expect(parts.join(" ")).toBe(text);
  });
  it("falls back to clause, word and hard splits", () => {
    const parts = splitText("bir, iki, üç, dört, beş, altı, yedi, sekiz, dokuz, on " + "x".repeat(45), 20);
    expect(parts.every((p) => charCount(p) <= 20)).toBe(true);
    expect(parts.join("").replace(/\s/g, "")).toContain("x".repeat(45));
  });
  it("returns short text untouched", () => {
    expect(splitText("Kısa.", 100)).toEqual(["Kısa."]);
  });
  it("builds words from character timings", () => {
    const chars = [..."Merhaba dünya!"];
    const a = { characters: chars, starts: chars.map((_, i) => i * 0.1), ends: chars.map((_, i) => (i + 1) * 0.1) };
    expect(wordsFromAlignment(a)).toEqual([
      { word: "Merhaba", start: 0, end: 0.7 },
      { word: "dünya!", start: 0.8, end: 1.4 },
    ]);
    expect(wordsFromAlignment(a, 8, 14, 0.8)[0]).toEqual({ word: "dünya!", start: 0, end: 0.6 });
  });
});

describe("planner", () => {
  const item = (voice: string, n: number, settings?: object) => ({ voice_id: voice, text: "a".repeat(n), characters: n, ...(settings ? { settings } : {}) });
  it("lines: one unit per pending item, long text split", () => {
    const u = planUnits([item("A", 10), item("A", 250), item("B", 5)], [true, true, false], { mode: "lines", route: "tts_rest", limit: 100 });
    expect(u.map((x) => x.kind)).toEqual(["single", "single"]);
    expect((u[1] as any).parts.length).toBe(3);
  });
  it("dialogue: groups adjacent lines within limit, breaks on cache gaps, settings and size", () => {
    const items = [item("A", 40), item("B", 40), item("A", 40), item("B", 10), item("A", 10, { stability: 0.2 }), item("B", 10, { stability: 0.2 }), item("A", 500)];
    const u = planUnits(items, [true, true, true, false, true, true, true], { mode: "dialogue", route: "dialogue_rest", limit: 100 });
    expect(u).toMatchObject([{ kind: "dialogue", items: [0, 1] }, { kind: "single", item: 2 }, { kind: "dialogue", items: [4, 5] }, { kind: "single", item: 6 }]);
    expect((u[3] as any).parts.length).toBe(5);
  });
  it("dialogue: at most 10 voices per request", () => {
    const items = Array.from({ length: 12 }, (_, i) => item("v" + i, 5));
    const u = planUnits(items, items.map(() => true), { mode: "dialogue", route: "dialogue_rest", limit: 1000 });
    expect(u).toMatchObject([{ items: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] }, { items: [10, 11] }]);
  });
  it("cache key depends on model, voice, text, settings and dictionary", async () => {
    const base = { model: "m", voice_id: "v", text: "t", settings: { stability: 0.5, speed: 1 } };
    const k = await cacheKey(base);
    expect(await cacheKey({ ...base, settings: { speed: 1, stability: 0.5 } })).toBe(k);
    for (const other of [{ model: "m2" }, { voice_id: "v2" }, { text: "t2" }, { settings: { stability: 0.6 } }, { dictionary: { pronunciation_dictionary_id: "d", version_id: "1" } }]) {
      expect(await cacheKey({ ...base, ...other })).not.toBe(k);
    }
  });
});

describe("delivery", () => {
  it("splits a job larger than 90 MB into several commits", () => {
    const mb = 1024 * 1024;
    const g = groupBySize([{ bytes: 50 * mb }, { bytes: 30 * mb }, { bytes: 20 * mb }, { bytes: 80 * mb }, { bytes: 1 }]);
    expect(g.map((x) => x.length)).toEqual([2, 1, 2]);
    expect(g.every((x) => x.reduce((n, f) => n + f.bytes, 0) <= 90 * mb)).toBe(true);
  });
});

describe("redaction", () => {
  it("removes configured secrets and credential-looking strings", () => {
    const env = { ELEVENLABS_API_KEY: "sk_abcdef0123456789abcdef", MCP_TOKEN: "tok-123456", GITHUB_TOKEN: "github_pat_ABCDEFGHIJKLMNOPQRSTUV", GITHUB_REPO: "ali/sesler", APP_PASSWORD: "parola99" } as any;
    const s = redact(env, "GET /repos/ali/sesler failed: Bearer github_pat_ABCDEFGHIJKLMNOPQRSTUV key sk_abcdef0123456789abcdef tok-123456 parola99 other sk_zzzzzzzzzzzzzzzzzzzzzzzz");
    for (const v of Object.values(env)) expect(s).not.toContain(v as string);
    expect(s).not.toContain("sk_zzzz");
  });
});
