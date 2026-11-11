import { charCount, round3 } from "./util";

export interface Word {
  word: string;
  start: number;
  end: number;
}

/** Character level alignment as returned by the ElevenLabs "with-timestamps" endpoints. */
export interface Alignment {
  characters: string[];
  starts: number[];
  ends: number[];
}

/**
 * Splits text into pieces of at most `max` characters, preferring sentence boundaries,
 * then clause boundaries, then spaces. Never drops a character.
 */
export function splitText(text: string, max: number): string[] {
  if (charCount(text) <= max) return [text];
  const sentences = text.match(/[^.!?…。！？\n]+(?:[.!?…。！？]+["'”’»)\]]*|\n+|$)\s*/g) ?? [text];
  const pieces: string[] = [];
  for (const s of sentences) {
    if (charCount(s) <= max) pieces.push(s);
    else pieces.push(...splitLong(s, max));
  }
  const out: string[] = [];
  let cur = "";
  let curLen = 0;
  for (const p of pieces) {
    const n = charCount(p);
    if (curLen && curLen + n > max) {
      out.push(cur);
      cur = "";
      curLen = 0;
    }
    cur += p;
    curLen += n;
  }
  if (curLen) out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

function splitLong(sentence: string, max: number): string[] {
  const out: string[] = [];
  const tokens = sentence.match(/[^,;:\s]+[,;:]?\s*|\s+/g) ?? [sentence];
  let cur = "";
  let curLen = 0;
  const push = () => {
    if (curLen) out.push(cur);
    cur = "";
    curLen = 0;
  };
  for (const t of tokens) {
    const n = charCount(t);
    if (n > max) {
      push();
      const cps = [...t];
      for (let i = 0; i < cps.length; i += max) out.push(cps.slice(i, i + max).join(""));
      continue;
    }
    if (curLen + n > max) push();
    cur += t;
    curLen += n;
  }
  push();
  return out;
}

/** Groups character timings into words. `offset` is subtracted from every timestamp. */
export function wordsFromAlignment(a: Alignment, from = 0, to = a.characters.length, offset = 0): Word[] {
  const words: Word[] = [];
  let cur = "";
  let start = 0;
  let end = 0;
  const flush = () => {
    if (cur) words.push({ word: cur, start: round3(Math.max(0, start - offset)), end: round3(Math.max(0, end - offset)) });
    cur = "";
  };
  for (let i = from; i < to && i < a.characters.length; i++) {
    const ch = a.characters[i];
    if (/^\s*$/.test(ch)) {
      flush();
      continue;
    }
    if (!cur) start = a.starts[i] ?? end;
    cur += ch;
    end = a.ends[i] ?? end;
  }
  flush();
  return words;
}

export function shiftWords(words: Word[], by: number): Word[] {
  return words.map((w) => ({ word: w.word, start: round3(w.start + by), end: round3(w.end + by) }));
}

/** Last `n` characters, cut at a word boundary when possible. */
export function tail(text: string, n: number): string {
  const cps = [...text];
  if (cps.length <= n) return text;
  const s = cps.slice(-n).join("");
  const sp = s.indexOf(" ");
  return sp >= 0 && sp < s.length - 1 ? s.slice(sp + 1) : s;
}

/** First `n` characters, cut at a word boundary when possible. */
export function head(text: string, n: number): string {
  const cps = [...text];
  if (cps.length <= n) return text;
  const s = cps.slice(0, n).join("");
  const sp = s.lastIndexOf(" ");
  return sp > 0 ? s.slice(0, sp) : s;
}
