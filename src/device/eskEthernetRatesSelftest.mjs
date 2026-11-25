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

const edge = {edge:'falling', channel:3, onArmed() { armed++; }};
let armed = 0;
status.firmware = 0x2c00; status.captureTriggerRates = rates; status.captureRates = rates;
globalThis.fetch = async (_url, options) => {
  const request = JSON.parse(options.body);
  if (request.op === 'lan_status') return Response.json(status);
  assert.deepEqual(request.trigger, {edge:'falling',channel:3});
  return new Response(new ReadableStream({start(c) {
    c.enqueue(Uint8Array.of(1)); c.enqueue(Uint8Array.of(123,0,0)); c.enqueue(Uint8Array.of(0,0,0,0,0,7,9)); c.close();
  }}), {headers:{'Content-Type':'application/octet-stream','Content-Length':'11','X-ESK-Armed':'1','X-ESK-Rate':String(rates[0]),'X-ESK-Channel-Mask':'255','X-ESK-Format':'raw8'}});
};
await readBoardStatus();
const acquired = [];
assert.equal(await receiveBoardCapture(2, new AbortController().signal, async b => { acquired.push(...b); }, rates[0], edge), '123');
assert.deepEqual(acquired,[7,9]); assert.equal(armed,1);
globalThis.location = new URL('https://example.org/#' + new URLSearchParams({eskBoard: origin}));
let cancelReceived;
const canceled = new Promise(done => { cancelReceived=done; });
window.parent = {postMessage(message, _origin, [port]) {
  if (message === 'xesk.status.v1') { port.postMessage(status); port.close(); return; }
  assert.deepEqual(message,{type:'xesk.capture.v4',count:2,rate:rates[0],trigger:{edge:'falling',channel:3}});
  port.onmessage = ({data}) => {
    if (data === 'cancel') { port.close(); cancelReceived(); return; }
    if (data === 'alive') { port.postMessage({offset:0,data:Uint8Array.of(7,9)}); return; }
    assert.equal(data,'ack'); port.postMessage({done:true, ticks:'123', rate:rates[0]}); port.close();
  };
  port.postMessage({armed:true}); port.postMessage({waiting:true});
}};
await readBoardStatus();
const receive = (signal, trigger) => receiveBoardCapture(2,signal,async b => assert.deepEqual([...b],[7,9]),rates[0],trigger);
assert.equal(await receive(new AbortController().signal,edge),'123');
const controller = new AbortController();
await assert.rejects(receive(controller.signal,{...edge,onArmed() {controller.abort();}}), {name:'AbortError'});
await canceled;
assert.equal(await receive(new AbortController().signal,edge),'123');
console.log('DDR trigger arming, heartbeat, cancel and rearm passed for board and helper protocols');

const slowRate = 41666666, percentages = [25,50,75];
const triggerAt = (n,hz,p) => receiveBoardCapture(n,new AbortController().signal,async () => {},hz,{...edge,prePercent:p});
status.capturePreTriggerPercents = percentages;
await assert.rejects(readBoardStatus(), /pretrigger capabilities/);
status.firmware = 0x2d00;
let expectedPercent = 0, expectedCount = 1024, expectedRate = slowRate;
window.parent.postMessage = (message,_origin,[port]) => {
  if (message === 'xesk.status.v1') {port.postMessage(status); port.close(); return;}
  assert.deepEqual(message,{type:'xesk.capture.v4',count:expectedCount,rate:expectedRate,trigger:{edge:'falling',channel:3,prePercent:expectedPercent}});
  let offset = 0;
  const sendBlock = () => {
    if (offset === expectedCount) {port.postMessage({done:true, ticks:'345', rate:expectedRate}); port.close(); return;}
    const data = new Uint8Array(Math.min(32768,expectedCount-offset));
    port.postMessage({offset,data}); offset += data.length;
  };
  port.onmessage = sendBlock;
  port.postMessage({armed:true}); sendBlock();
};
await readBoardStatus();
for (expectedPercent of percentages) assert.equal(await triggerAt(1024,slowRate,expectedPercent),'345');
await assert.rejects(triggerAt(1000,slowRate,50),/Unsupported/);
await assert.rejects(triggerAt(1024,rates[0],50),/Unsupported/);
status.capturePreTriggerPercents = [];
await readBoardStatus(); await assert.rejects(triggerAt(1024,slowRate,50),/Unsupported/);

status.capturePreTriggerPercents = percentages;
status.captureMaxSamples = 1_048_576;
status.firmware = 0x2e00;
await readBoardStatus(); // Older connector paired with newer firmware still only advertises the pilot.
await assert.rejects(triggerAt(100000,slowRate,50),/Unsupported/);
status.captureHistoryProfiles = [{rate:slowRate,counts:[1024,100000,1000000]}];
await readBoardStatus();
expectedPercent = 50;
for (expectedCount of [100000,1000000]) assert.equal(await triggerAt(expectedCount,slowRate,expectedPercent),'345');
status.captureHistoryProfiles.push({rate:83333333,counts:[1024,100000,1000000]});
await assert.rejects(readBoardStatus(), /history profiles/);
status.firmware = 0x2f00;
await readBoardStatus();
expectedRate = 83333333;
assert.equal(await triggerAt(expectedCount,expectedRate,expectedPercent),'345');
await assert.rejects(triggerAt(100001,expectedRate,expectedPercent), /Unsupported/);
status.captureHistoryProfiles.push({rate:166666666,counts:[100000]});
await assert.rejects(readBoardStatus(), /history profiles/);
status.firmware = 0x3100;
await readBoardStatus();
expectedRate = 166666666;
expectedCount = 100000;
for (expectedPercent of percentages) assert.equal(await triggerAt(expectedCount,expectedRate,expectedPercent),'345');
await assert.rejects(triggerAt(100001,expectedRate,50), /Unsupported/);

globalThis.location = new URL('http://127.0.0.1:40000/#eskLocal=' + 'a'.repeat(32));
window.parent = window;
status.capturePreTriggerPercents = percentages;
globalThis.fetch = async (_url,opts) => {
  const req = JSON.parse(opts.body);
  if (req.op === 'lan_status') return Response.json(status);
  assert.deepEqual(req.trigger, {edge:'falling',channel:3,prePercent:expectedPercent});
  assert.equal(req.count,expectedCount); assert.equal(req.rate,expectedRate);
  const body = new Uint8Array(expectedCount + 9);
  body[0] = 1; body[1] = 42;
  return new Response(body,{headers:{'Content-Type':'application/octet-stream','Content-Length':String(body.length),'X-ESK-Armed':'1','X-ESK-Rate':String(expectedRate),'X-ESK-Channel-Mask':'255','X-ESK-Format':'raw8'}});
};
await readBoardStatus();
for (expectedPercent of percentages) for (expectedCount of [1024,100000,1000000])
  for (expectedRate of [slowRate,83333333]) assert.equal(await triggerAt(expectedCount,expectedRate,expectedPercent),'42');
