// SPDX-License-Identifier: GPL-3.0-or-later
import type { GapSpan } from '../data/types.js';

export interface TraceInput {
  key: object;
  length: number;
  rate: number;
  channels: number;
  firstChannel: number;
  gaps: readonly GapSpan[];
  read(start: number, end: number): Promise<Uint8Array>;
}
export interface TraceHit { start: number; end: number; bit: number; label: string }
export const scanBlock = 65536;

export function* validSpans(source: TraceInput, start = 0, end = source.length) {
  for (const gap of source.gaps) {
    if (gap.startSample >= end) break;
    if (gap.endSample <= start) continue;
    if (gap.startSample > start) yield [start, gap.startSample] as const;
    start = Math.max(start, gap.endSample);
  }
  if (start < end) yield [start, end] as const;
}

export async function findPulse(source: TraceInput, bit: number, level: number, ns: number,
    shorter: boolean, reverse: boolean, from: number, signal: AbortSignal): Promise<TraceHit | null> {
  const spans = [...validSpans(source, reverse ? 0 : from, reverse ? from : source.length)];
  if (reverse) spans.reverse();
  for (const [lo, hi] of spans) {
    let previous = -1, edge = -1;
    let pos = reverse ? hi : lo;
    while (reverse ? pos > lo : pos < hi) {
      signal.throwIfAborted();
      const begin = reverse ? Math.max(lo, pos - scanBlock) : pos;
      const end = reverse ? pos : Math.min(hi, pos + scanBlock);
      const block = await source.read(begin, end);
      if (block.length !== end - begin) throw Error('Incomplete trace window');
      for (let i = reverse ? block.length - 1 : 0; reverse ? i >= 0 : i < block.length; i += reverse ? -1 : 1) {
        const value = (block[i]! >> bit) & 1;
        if (value === previous) continue;
        const boundary = begin + i + (reverse ? 1 : 0);
        if (previous === level && edge >= 0) {
          const width = Math.abs(edge - boundary);
          if (shorter ? width * 1e9 < ns * source.rate : width * 1e9 > ns * source.rate) {
            return {start: Math.min(edge, boundary), end: Math.max(edge, boundary), bit,
              label: 'D' + (source.firstChannel + bit) + ' · ' + width + ' samples · ' +
                Number((width * 1e9 / source.rate).toPrecision(6)) + ' ns'};
          }
        }
        edge = previous < 0 ? -1 : boundary;
        previous = value;
      }
      pos = reverse ? begin : end;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  return null;
}

