import assert from 'node:assert/strict';
import { findPulse, scanBlock } from '../ui/traceSearch.js';
import { filteredTrace } from '../ui/traceFilter.js';
import { protocolMatches } from '../ui/traceProtocol.js';
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
const copy = raw.slice();
const filtered = filteredTrace(source, new Map([[3, 8]]), signal);
assert.deepEqual(await filtered.read(scanBlock - 7, scanBlock + 8), new Uint8Array(15));
assert.deepEqual(await filtered.read(scanBlock + 21, scanBlock + 26), new Uint8Array(5).fill(8));
assert.deepEqual(await filteredTrace(source, new Map([[3,7]]), signal).read(scanBlock, scanBlock + 2), new Uint8Array([8,8]));
const inverted = {...source, read: async (a,b) => (await source.read(a,b)).map(x => x ^ 255)};
assert.deepEqual(await filteredTrace(inverted,new Map([[3,8]]),signal).read(scanBlock,scanBlock+3),new Uint8Array(3).fill(255));
assert.deepEqual(raw, copy);
console.log('Raw preservation, high/low glitch rejection, exact cutoff and cross-window filter context passed.');

const bus = [3,2,3,1]; // idle, START on SDA while SCL is high (last sample)
function sendI2c(byte, ack) {
  for (const bit of [...Array.from({length:8},(_,i) => byte >> (7-i) & 1),ack]) {
    const low = bit << 1;
    bus.push(low,low|1,low);
  }
}
sendI2c(0xa2,0);
sendI2c(0x55,1);
bus.push(2,3,1);
sendI2c(0xa3,1);
bus.push(0,1,3);
async function matches(bytes, query, gaps = []) {
  const seen = [];
  const trace = {...source, length:bytes.length, rate:1e6,gaps,readSize:13,read:async(a,b)=>{
    assert.ok(b-a<=13);return Uint8Array.from(bytes.slice(a,b));
  }};
  for await (const hit of protocolMatches(trace,query,signal,()=>{})) seen.push(hit);
  return seen;
}
const nack = {kind:'i2c',scl:0,sda:1,address:null};
assert.deepEqual((await matches(bus,nack)).map(h=>h.label), ['I²C 0x51 · 0x55 · NACK','I²C 0x51 read · NACK']);
assert.equal((await matches(bus,{...nack,address:0x51})).length,2);
assert.equal((await matches(bus,{...nack,address:0x52})).length,0);
const serial = Array(5).fill(4);
for (const byte of [0x48,0x69,0xaa,0xaa,0xaa]) {
  for (const bit of [0,...Array.from({length:8},(_,i)=>byte>>i&1),1])
    serial.push(...Array(10).fill(bit<<2));
}
const uart = {kind:'uart',rx:2,baud:100000,bytes:[0x48,0x69]};
assert.equal((await matches(serial,uart))[0].start,5);
assert.equal((await matches(serial,{...uart,bytes:[0xaa,0xaa]})).length,2);
assert.equal((await matches(serial,uart,[{startSample:96,endSample:110}])).length,0);
console.log('I²C address, repeated START and NACK, UART 8N1 overlapping sequences and gaps passed across 13-sample reads.');
