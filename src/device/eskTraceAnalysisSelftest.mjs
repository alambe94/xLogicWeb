import assert from 'node:assert/strict';
import { findTraceEdge, findPulse, scanBlock } from '../ui/traceSearch.js';
import { filteredTrace } from '../ui/traceFilter.js';
const raw = new Uint8Array(scanBlock + 80);
raw.fill(8, scanBlock - 4, scanBlock + 3);
raw.fill(8, scanBlock + 20, scanBlock + 29);
raw.fill(8, raw.length - 3); // incomplete at capture end
const source = {key: raw, length: raw.length, channels: 8, firstChannel: 0, rate: 1e9,
  gaps: [], read: async (a,b) => raw.slice(a,b)};
const signal = new AbortController().signal;
const edgeData = Uint8Array.of(0, 0, 0, 8, 8, 0, 0, 8);
const small = {...source, length: edgeData.length, readSize: 3, read: async (lo, hi) => {
  assert.ok(hi - lo <= 3); return edgeData.slice(lo, hi);
}};
assert.equal(await findTraceEdge(small, 3, 0, true, signal), 3);
assert.equal(await findTraceEdge(small, 3, 3, true, signal), 5);
assert.equal(await findTraceEdge(small, 3, 5, false, signal), 3);
assert.equal(await findTraceEdge({...small, gaps:[{startSample:2, endSample:5}]}, 3, 0, true, signal), 7);
assert.equal(await findTraceEdge(small, 3, 7, true, signal), null);
const calls = [];
const archive = {...small, firstChannel: 4, edge: async (from, channel, direction) => {
  calls.push([from, channel, direction]);
  return from === 0 ? {match:null, resume:2} : {match:3, resume:null};
}};
assert.equal(await findTraceEdge(archive, 3, 0, true, signal), 3);
assert.deepEqual(calls, [[0,7,'next'],[2,7,'next']]);
assert.equal(await findTraceEdge(filteredTrace(archive, new Map([[3,3]]),signal), 3, 0, true, signal), null);
await assert.rejects(findTraceEdge(small, 3, 0, true, AbortSignal.abort()), {name:'AbortError'});
console.log('Edges step forward and back across blocks, respect gaps and filters, and use the archive channel bank.');
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
const copy = raw.slice();
const filtered = filteredTrace(source, new Map([[3, 8]]), signal);
assert.deepEqual(await filtered.read(scanBlock - 7, scanBlock + 8), new Uint8Array(15));
assert.deepEqual(await filtered.read(scanBlock + 21, scanBlock + 26), new Uint8Array(5).fill(8));
assert.deepEqual(await filteredTrace(source, new Map([[3,7]]), signal).read(scanBlock, scanBlock + 2), new Uint8Array([8,8]));
const inverted = {...source, read: async (a,b) => (await source.read(a,b)).map(x => x ^ 255)};
assert.deepEqual(await filteredTrace(inverted,new Map([[3,8]]),signal).read(scanBlock,scanBlock+3),new Uint8Array(3).fill(255));
assert.deepEqual(raw, copy);
console.log('Raw preservation, high/low glitch rejection, exact cutoff and cross-window filter context passed.');

// Deliberately use uneven transfers, including a single transfer larger than the ring.
const {LoopRecording} = await import('../data/loopRecording.js');
for (const capacity of [1, 7, 16]) {
  const file = new Uint8Array(capacity);
  const ring = new LoopRecording({write(data,{at}) {file.set(data,at); return data.length;}}, capacity);
  let count = 0;
  for (const size of [2, 3, 12, 5, 21]) {
    ring.append(Uint8Array.from({length:size}, (_,i) => count+i));
    count += size;
    const lo = Math.max(0,count-capacity);
    assert.deepEqual(Array.from({length:count-lo},(_,i)=>file[(lo+i)%capacity]),
      Array.from({length:count-lo},(_,i)=>lo+i));
  }
}
console.log('Loop retains the exact bounded suffix through partial, multiple and oversized writes.');
