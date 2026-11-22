// SPDX-License-Identifier: GPL-3.0-or-later
import { PackedEdgeWindow } from './eskPackedEdge.js';

// Compare the block scanner to a sample-by-sample reference, including edges
// at block boundaries, before history fills, and with an incomplete suffix.
const raw = new Uint8Array(256);
for (let i = 0; i < raw.length; i++) raw[i] = ((i >>> 5) ^ (i >>> 3) ^ i) & 15;
function check(chunk: number, count: number, pre: number, channel: number, rising: boolean) {
  const win = new PackedEdgeWindow(count, pre, channel, rising);
  const bit = 1 << channel;
  const edge = raw.findIndex((v,i) => i >= Math.max(1,pre) && !!(v & bit) === rising && !!(raw[i-1]! & bit) !== rising);
  let result: Uint8Array | undefined;
  const packed = new Uint8Array(raw.length/2);
  for (let i=0; i<packed.length; i++) packed[i] = raw[2*i]! | raw[2*i+1]! << 4;
  for (let i=0; i<packed.length && !result; i+=chunk) result = win.push(packed.subarray(i,i+chunk));
  const complete = edge >= 0 && edge-pre+count <= raw.length;
  if (!!result !== complete || result && (!result.every((x,i) => x === raw[edge-pre+i]) || result.length !== count)) {
    throw Error('Incorrect edge window: '+[chunk,count,pre,channel,rising,edge]);
  }
}
for (const chunk of [1,3,4,11,128]) for (const count of [1,15,64,255]) {
  for (const pre of [0,Math.floor(count/2),count-1]) for (const ch of [0,1,2,3]) {
    for (const rising of [false,true]) check(chunk,count,pre,ch,rising);
  }
}
raw.fill(0);
raw.fill(8,64);
for (const offset of [0,1,25]) for (const rising of [false,true]) check(32,50,offset,3,rising);
console.log('Packed trigger samples, placement, cross-block history and incomplete records passed');
