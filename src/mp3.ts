/**
 * Minimal MPEG audio frame scanner. Enough to measure duration, concatenate files and cut a file
 * at frame boundaries without re-encoding (used to split one dialogue render into per-line mp3s).
 */
import { concatBytes } from "./util";

export interface Mp3Frame {
  offset: number;
  size: number;
  /** Start time of the frame in seconds. */
  time: number;
  /** Duration of the frame in seconds. */
  dur: number;
}

export interface Mp3Index {
  frames: Mp3Frame[];
  duration: number;
}

const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG1
  2: [22050, 24000, 16000], // MPEG2
  0: [11025, 12000, 8000], // MPEG2.5
};

function skipId3(buf: Uint8Array): number {
  if (buf.length > 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    return 10 + size;
  }
  return 0;
}

function parseHeader(buf: Uint8Array, i: number): { size: number; dur: number } | null {
  if (i + 4 > buf.length) return null;
  if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) return null;
  const version = (buf[i + 1] >> 3) & 3;
  const layer = (buf[i + 1] >> 1) & 3;
  if (version === 1 || layer !== 1) return null; // Layer III only
  const bitrateIdx = (buf[i + 2] >> 4) & 0xf;
  const srIdx = (buf[i + 2] >> 2) & 3;
  if (srIdx === 3) return null;
  const padding = (buf[i + 2] >> 1) & 1;
  const kbps = (version === 3 ? BITRATES_V1_L3 : BITRATES_V2_L3)[bitrateIdx];
  if (!kbps) return null;
  const sampleRate = SAMPLE_RATES[version][srIdx];
  const samples = version === 3 ? 1152 : 576;
  const size = Math.floor(((samples / 8) * kbps * 1000) / sampleRate) + padding;
  return { size, dur: samples / sampleRate };
}

function isInfoFrame(buf: Uint8Array, offset: number, size: number): boolean {
  const end = Math.min(offset + size, offset + 64, buf.length - 4);
  for (let i = offset + 4; i < end; i++) {
    const a = buf[i], b = buf[i + 1], c = buf[i + 2], d = buf[i + 3];
    if ((a === 0x58 && b === 0x69 && c === 0x6e && d === 0x67) || (a === 0x49 && b === 0x6e && c === 0x66 && d === 0x6f)) return true;
  }
  return false;
}

export function indexMp3(buf: Uint8Array): Mp3Index {
  const frames: Mp3Frame[] = [];
  let i = skipId3(buf);
  let time = 0;
  let first = true;
  while (i + 4 <= buf.length) {
    const h = parseHeader(buf, i);
    if (!h) {
      i++;
      continue;
    }
    // Require the next frame (or EOF) to line up, so random 0xFFEx bytes are not mistaken for a header.
    const nextAt = i + h.size;
    if (nextAt + 4 <= buf.length && !parseHeader(buf, nextAt)) {
      i++;
      continue;
    }
    if (first && isInfoFrame(buf, i, h.size)) {
      first = false;
      i = nextAt;
      continue; // Xing/Info header frame carries no audio
    }
    first = false;
    const size = Math.min(h.size, buf.length - i);
    frames.push({ offset: i, size, time, dur: h.dur });
    time += h.dur;
    i = nextAt;
  }
  return { frames, duration: time };
}

export function mp3Duration(buf: Uint8Array): number {
  return indexMp3(buf).duration;
}

/** Joins mp3 files of the same format by concatenating their audio frames (tags dropped). */
export function concatMp3(files: Uint8Array[]): Uint8Array {
  if (files.length === 1) return files[0];
  const parts: Uint8Array[] = [];
  for (const f of files) {
    const { frames } = indexMp3(f);
    if (!frames.length) continue;
    const last = frames[frames.length - 1];
    parts.push(f.subarray(frames[0].offset, last.offset + last.size));
  }
  return concatBytes(parts);
}

export interface Mp3Cut {
  bytes: Uint8Array;
  /** Actual (frame aligned) start of the cut in the source timeline. */
  start: number;
  duration: number;
}

/**
 * Cuts `buf` at the given boundaries (seconds, ascending, first = 0, last = Infinity is implied).
 * Returns boundaries.length pieces; piece i covers [boundaries[i], boundaries[i+1]).
 * Every source frame ends up in exactly one piece, so no audio is lost or duplicated.
 */
export function cutMp3(buf: Uint8Array, index: Mp3Index, boundaries: number[]): Mp3Cut[] {
  const { frames } = index;
  const startFrame = boundaries.map((t, i) => {
    if (i === 0) return 0;
    let lo = 0, hi = frames.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (frames[mid].time + frames[mid].dur / 2 < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  });
  return startFrame.map((sf, i) => {
    const ef = i + 1 < startFrame.length ? Math.max(startFrame[i + 1], sf) : frames.length;
    if (sf >= frames.length || ef <= sf) {
      return { bytes: new Uint8Array(0), start: sf < frames.length ? frames[sf].time : index.duration, duration: 0 };
    }
    const a = frames[sf];
    const b = frames[ef - 1];
    return {
      bytes: buf.slice(a.offset, b.offset + b.size),
      start: a.time,
      duration: b.time + b.dur - a.time,
    };
  });
}
