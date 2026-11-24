// SPDX-License-Identifier: GPL-3.0-or-later
import type { GapSpan } from '../data/types.js';

export interface TraceInput {
  key: object;
  length: number;
  rate: number;
  channels: number;
  firstChannel: number;
  readSize?: number;
  gaps: readonly GapSpan[];
  edge?: ((position: number, channel: number, direction: 'previous' | 'next') =>
    Promise<{match: number | null; resume: number | null}>) | undefined;
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

/** The cursor is exclusive in both directions. Only compare adjacent known samples. */
export async function findTraceEdge(source: TraceInput, bit: number, from: number, forward: boolean,
    signal: AbortSignal): Promise<number | null> {
  let cursor = Math.max(0, Math.min(source.length, Math.round(from)));
  if (source.edge) {
    for (;;) {
      signal.throwIfAborted();
      const {match, resume} = await source.edge(cursor, source.firstChannel + bit, forward ? 'next' : 'previous');
      if (match !== null || resume === null) return match;
      cursor = resume;
    }
  }
  const spans = [...validSpans(source, forward ? cursor : 0, forward ? source.length : cursor)];
  if (!forward) spans.reverse();
  const size = Math.max(2, Math.min(scanBlock, source.readSize ?? scanBlock));
  for (const [lo, hi] of spans) {
    cursor = forward ? lo : hi;
    while (forward ? cursor + 1 < hi : cursor - 1 > lo) {
      signal.throwIfAborted();
      const start = forward ? cursor : Math.max(lo, cursor - size);
      const end = forward ? Math.min(hi, cursor + size) : cursor;
      const block = await source.read(start, end);
      if (block.length !== end - start) throw Error('Incomplete trace window');
      for (let i = forward ? 1 : block.length - 1; i > 0 && i < block.length; i += forward ? 1 : -1) {
        if ((block[i]! ^ block[i - 1]!) & (1 << bit)) return start + i;
      }
      cursor = forward ? end - 1 : start + 1;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  return null;
}
