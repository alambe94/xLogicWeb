import assert from 'node:assert/strict';
import { findPulse, scanBlock } from '../traceSearch.js';
const raw = new Uint8Array(scanBlock + 80);
raw.fill(8, scanBlock - 4, scanBlock + 3);
raw.fill(8, scanBlock + 20, scanBlock + 29);
raw.fill(8, raw.length - 3); // incomplete at capture end
const source = {key: raw, length: raw.length, channels: 8, firstChannel: 0, rate: 1e9,
  gaps: [], read: async (a,b) => raw.slice(a,b)};
const signal = new AbortController().signal;
const search = (src, ns, shorter, reverse = false, from = reverse ? src.length : 0) =>
  findPulse(src, 3, 1, ns, shorter, reverse, from, signal);
const match = await search(source, 8, true);
assert.equal(match.start, scanBlock - 4);
assert.equal(match.end, scanBlock + 3);
assert.equal((await search(source, 8, true, true)).start, match.start);
assert.equal(await search(source, 7, true), null);
assert.equal((await search(source, 7, false)).start, scanBlock + 20);
assert.equal(await search({...source,gaps:[{startSample:scanBlock,endSample:scanBlock+1}]},8,true),null);
console.log('Pulse polarity, strict width, reverse search, incomplete pulses, gaps and split windows passed.');

