// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { boardCaptureRates, readBoardStatus, receiveBoardCapture, withBoardManagement } from './eskPairedBoard.js';

const origin = 'http://192.0.2.10:5555';
globalThis.location = new URL('https://example.org/#' + new URLSearchParams({eskBoard: origin}));
globalThis.window = new EventTarget();
const rates = [333333333, 166666666, 83333333, 41666666];
const status = {deviceId: '0'.repeat(31) + '1', boot: '11', firmware: 0x2800, features: [], captureMaxSamples: 1024};
const captures = [];
let wrongRate = false;
window.parent = {postMessage(message, destination, [port]) {
  assert.equal(destination, origin);
  if (message === 'xesk.connect.v1' || message === 'xesk.status.v1') {
    port.postMessage(message === 'xesk.connect.v1' ? true : status);
    port.close();
  } else {
    captures.push(message);
    port.onmessage = ({data}) => {
      assert.equal(data, 'ack');
      port.postMessage({done: true, ticks: '1', rate: wrongRate ? 7 : message.rate});
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
