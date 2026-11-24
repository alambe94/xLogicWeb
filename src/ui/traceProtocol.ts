// SPDX-License-Identifier: GPL-3.0-or-later
import { scanBlock, validSpans, type TraceInput, type TraceHit } from './traceSearch.js';

export type ProtocolQuery =
  | {kind: 'i2c'; scl: number; sda: number; address: number | null}
  | {kind: 'uart'; rx: number; baud: number; bytes: number[]};
type Decoder = (byte: number, sample: number) => TraceHit | undefined;
const hex = (value: number) => value.toString(16).toUpperCase().padStart(2, '0');

function i2c(query: Extract<ProtocolQuery, {kind:'i2c'}>): Decoder {
  let prev = -1, active = false, addressByte = true;
  let bits = 0, data = 0, begin = 0, address = 0;
  return (byte, sample) => {
    const old = prev;
    prev = byte;
    if (old < 0 || byte === old) return;
    const clock = byte >> query.scl & 1, wasClock = old >> query.scl & 1;
    const line = byte >> query.sda & 1, wasLine = old >> query.sda & 1;
    if (clock && wasClock && line !== wasLine) {
      active = !line; addressByte = true; bits = data = 0;
      return;
    }
    if (!active || !clock || wasClock) return;
    if (!bits) begin = sample;
    if (bits < 8) { data = data * 2 + line; bits++; return; }
    if (addressByte) address = data >>> 1;
    const match = query.address === null ? !!line : addressByte && query.address === address;
    const label = 'I²C 0x' + hex(address) + (addressByte ? (data & 1 ? ' read' : ' write') : ' · 0x' + hex(data)) +
      (line ? ' · NACK' : ' · ACK');
    bits = data = 0;
    addressByte = false;
    if (match) return {start: begin, end: sample + 1, bit: query.sda, label};
  };
}

function uart(query: Extract<ProtocolQuery, {kind:'uart'}>, rate: number): Decoder {
  const period = rate / query.baud;
  if (!(period >= 3) || !Number.isFinite(period)) throw Error('UART requires at least three samples per bit.');
  if (!query.bytes.length || query.bytes.length > 64) throw Error('Enter 1–64 hex bytes.');
  // Track prefix matches including overlaps (e.g. AA AA in AA AA AA).
  const prefix = new Uint8Array(query.bytes.length);
  for (let i = 1, j = 0; i < prefix.length; i++) {
    while (j && query.bytes[i] !== query.bytes[j]) j = prefix[j - 1]!;
    if (query.bytes[i] === query.bytes[j]) j++;
    prefix[i] = j;
  }
  const starts = new Array<number>(query.bytes.length);
  let previous = -1, slot = -1, start = 0, due = 0, data = 0, matched = 0, frames = 0;
  return (byte, sample) => {
    const line = byte >> query.rx & 1;
    const falling = previous === 1 && !line;
    previous = line;
    if (slot < 0) {
      if (!falling) return;
      start = sample; slot = data = 0; due = start + Math.round(period * 0.5);
    }
    if (sample < due) return;
    if (slot === 0 && line || slot === 9 && !line) { matched = 0; slot = -1; return; }
    if (slot === 9) {
      slot = -1;
      starts[frames++ % starts.length] = start;
      while (matched && data !== query.bytes[matched]) matched = prefix[matched - 1]!;
      if (data === query.bytes[matched]) matched++;
      if (matched !== query.bytes.length) return;
      matched = prefix[matched - 1]!;
      return {start: starts[(frames - starts.length) % starts.length]!, end: sample + 1,
        bit: query.rx, label: 'UART · ' + query.bytes.map(hex).join(' ')};
    }
    if (slot > 0) data |= line << (slot - 1);
    slot++; due = start + Math.round((slot + 0.5) * period);
  };
}

// Decoder state lives across disk reads and is reset at every acquisition gap.
// Yielding individual hits lets the caller pause between pages inside a block.
export async function* protocolMatches(source: TraceInput, query: ProtocolQuery,
    signal: AbortSignal, progress: (sample: number) => void): AsyncGenerator<TraceHit> {
  if (query.kind === 'i2c' && query.sda === query.scl) throw Error('Choose distinct SCL and SDA inputs.');
  const blockSize = source.readSize ?? scanBlock;
  for (const [first, end] of validSpans(source)) {
    const decode = query.kind === 'uart' ? uart(query, source.rate) : i2c(query);
    for (let start = first; start < end; start += blockSize) {
      signal.throwIfAborted();
      const stop = Math.min(end, start + blockSize);
      const bytes = await source.read(start, stop);
      if (bytes.length !== stop - start) throw Error('Incomplete trace window');
      for (let i = 0; i < bytes.length; i++) {
        const hit = decode(bytes[i]!, start + i);
        if (hit) { yield hit; signal.throwIfAborted(); }
      }
      progress(stop);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
}
