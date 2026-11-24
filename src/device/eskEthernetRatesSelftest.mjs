// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { boardCaptureMaximum, boardCaptureRates, readBoardStatus, receiveBoardCapture, withBoardManagement } from './eskPairedBoard.js';

const origin = 'http://192.0.2.10:5555';
globalThis.location = new URL('https://example.org/#' + new URLSearchParams({eskBoard: origin}));
globalThis.window = new EventTarget();
const rates = [333333333, 166666666, 83333333, 41666666];
const status = {deviceId: '0'.repeat(31) + '1', boot: '11', firmware: 0x2800, features: [], captureMaxSamples: 1024};
const captures = [];
let wrongRate = false;
let channelMask = 255;
window.parent = {postMessage(message, destination, [port]) {
  assert.equal(destination, origin);
  if (message === 'xesk.connect.v1' || message === 'xesk.status.v1') {
    port.postMessage(message === 'xesk.connect.v1' ? true : status);
    port.close();
  } else {
    captures.push(message);
    port.onmessage = ({data}) => {
      assert.equal(data, 'ack');
      port.postMessage({done: true, ticks: '1', rate: wrongRate ? 7 : message.rate, format: 1, channelMask});
      port.close();
    };
    port.postMessage({offset: 0, data: Uint8Array.of(0x55, 0xaa)});
  }
}};
const capture = rate => receiveBoardCapture(2, new AbortController().signal,
  async (data, offset) => { assert.equal(offset, 0); assert.deepEqual([...data], [0x55, 0xaa]); }, rate);

await readBoardStatus();
assert.deepEqual(boardCaptureRates(), [rates[0]]);
assert.equal(await capture(rates[0]), '1');
assert.deepEqual(captures.pop(), {type: 'xesk.capture.v2', count: 2});
await assert.rejects(capture(rates[1]), /Unsupported/);

status.captureRates = rates;
await readBoardStatus();
assert.deepEqual(boardCaptureRates(), rates);
for (const rate of rates) {
  assert.equal(await capture(rate), '1');
  assert.deepEqual(captures.pop(), {type: 'xesk.capture.v3', count: 2, rate});
}
wrongRate = true;
await assert.rejects(capture(rates[3]), /Incomplete/);
wrongRate = false;
await assert.rejects(capture(500000000), /Unsupported/);
status.captureRates = [500000000, ...rates];
await readBoardStatus();
assert.deepEqual(boardCaptureRates(), status.captureRates);
assert.equal(boardCaptureMaximum(500000000), 960);
assert.equal(boardCaptureMaximum(rates[0]), 1024);
assert.equal(await capture(500000000), '1');
channelMask = 15;
await assert.rejects(capture(500000000), /eight-channel/);
status.captureRates = [NaN];
await assert.rejects(readBoardStatus(), /sampling rates/);
delete status.captureRates;
await readBoardStatus();
assert.deepEqual(boardCaptureRates(), [rates[0]]);
console.log('Ethernet finite rate selection and legacy fallback passed');

await assert.rejects(withBoardManagement(status, async () => {}), /management support/);
status.networkManagement = true;
const closed = Promise.withResolvers();
window.parent.postMessage = (message, destination, [port]) => {
  assert.equal(destination, origin);
  assert.deepEqual(message, {type: 'xesk.management.v1', boot: status.boot, deviceId: status.deviceId});
  port.onmessage = ({data}) => {
    if (data.close) { port.close(); closed.resolve(data.id); return; }
    if (data.id === 1) port.postMessage({id: 1, status: 2});
    else port.postMessage({id: data.id, payload: data.payload});
  };
  port.postMessage({ready: true});
};
await withBoardManagement(status, async exchange => {
  await assert.rejects(exchange(Uint8Array.of(1)), error => error.status === 2);
  assert.deepEqual(await exchange(Uint8Array.of(2)), Uint8Array.of(2));
});
assert.equal(await closed.promise, 3);

// A loopback package pins the selected board on Home, then uses the same rate
// and data callbacks as a board-launched capture. No board iframe is needed.
globalThis.location = new URL('http://127.0.0.1:40000/#eskLocal=' + 'a'.repeat(32));
globalThis.document = {querySelector: () => ({})};
window.parent = window;
const localCount = 66001;
let truncate = false;
let localRate = rates[2];
let localMask = '255';
globalThis.fetch = async (url, options) => {
  assert.equal(url, '/api/native');
  const request = JSON.parse(options.body);
  assert.equal(request.board, 'a'.repeat(32));
  if (request.op === 'lan_status') return Response.json({...status, captureMaxSamples: 131072, captureRates: [500000000, ...rates]});
  assert.deepEqual(request, {op: 'lan_capture', board: 'a'.repeat(32), boot: status.boot, count: localCount, rate: localRate});
  return new Response(new Uint8Array(localCount - Number(truncate)).fill(0xa5), {headers: {
    'Content-Type': 'application/octet-stream', 'Content-Length': String(localCount), 'X-ESK-Ticks': '123456',
    'X-ESK-Rate': String(localRate), 'X-ESK-Format': 'raw8', 'X-ESK-Channel-Mask': localMask,
  }});
};
await readBoardStatus();
const captureLocal = async () => {
  let next = 0;
  const ticks = await receiveBoardCapture(localCount, new AbortController().signal, async (data, offset) => {
    assert.equal(offset, next);
    assert.ok(data.length > 0 && data.length <= 32768 && data.every(sample => sample === 0xa5));
    next += data.length;
  }, localRate);
  assert.equal(next, localCount);
  return ticks;
};
assert.equal(await captureLocal(), '123456');
localRate = 500000000;
assert.equal(await captureLocal(), '123456');
localMask = '15';
await assert.rejects(captureLocal(), /header/);
localMask = '255';
truncate = true;
await assert.rejects(captureLocal(), /Incomplete/);
console.log('Loopback Ethernet capture and truncation detection passed');
