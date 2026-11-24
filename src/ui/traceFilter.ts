// SPDX-License-Identifier: GPL-3.0-or-later
import { scanBlock, validSpans, type TraceInput } from './traceSearch.js';

export type FilterWidths = ReadonlyMap<number, number>;

// Find the most recent qualified level and the length of the run immediately
// preceding this window. Memory stays bounded even when a saved trace chatters
// for many blocks without settling.
async function preceding(source: TraceInput, lo: number, first: number, bit: number, n: number,
    initial: number, signal: AbortSignal) {
  let last = initial, run = 0, prefix = 0, contiguous = true;
  for (let end = first; end > lo;) {
    signal.throwIfAborted();
    const start = Math.max(lo, end - scanBlock);
    const bytes = await source.read(start, end);
    for (let i = bytes.length - 1; i >= 0; i--) {
      const level = bytes[i]! >> bit & 1;
      if (level !== initial) contiguous = false;
      if (contiguous) prefix++;
      run = level === last ? run + 1 : 1;
      last = level;
      if (run >= n) return {stable: last, prefix};
    }
    end = start;
  }
  return {stable: last, prefix};
}

async function qualifiesAtEnd(source: TraceInput, end: number, hi: number, bit: number,
    level: number, needed: number, signal: AbortSignal) {
  while (needed > 0 && end < hi) {
    signal.throwIfAborted();
    const next = Math.min(hi, end + scanBlock, end + needed);
    const bytes = await source.read(end, next);
    for (const byte of bytes) if ((byte >> bit & 1) !== level) return false;
    needed -= next - end;
    end = next;
  }
  return needed <= 0;
}

export function filteredTrace(source: TraceInput, widths: FilterWidths, signal: AbortSignal): TraceInput {
  if (!widths.size) return source;
  return {...source, read: async (start, end) => {
    signal.throwIfAborted();
    const raw = await source.read(start, end);
    const out = raw.slice();
    for (const [lo, hi] of validSpans(source)) {
      if (lo >= end) break;
      const first = Math.max(start, lo), stop = Math.min(end, hi);
      if (first >= stop) continue;
      for (const [bit, n] of widths) {
        if (n <= 1) continue;
        const mask = 1 << bit;
        const initial = raw[first - start]! >> bit & 1;
        let {stable, prefix} = await preceding(source, lo, first, bit, n, initial, signal);
        for (let i = first; i < stop;) {
          const level = raw[i - start]! >> bit & 1;
          let j = i + 1;
          while (j < stop && (raw[j - start]! >> bit & 1) === level) j++;
          const seen = j - i + prefix;
          if (seen >= n || (level !== stable && j === stop &&
              await qualifiesAtEnd(source, j, hi, bit, level, n - seen, signal))) stable = level;
          if (stable !== level) for (let k = i - start; k < j - start; k++) out[k] ^= mask;
          prefix = 0; i = j;
        }
      }
    }
    return out;
  }};
}

