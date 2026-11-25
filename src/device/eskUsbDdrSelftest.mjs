// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import {forgetUsbDdr, inspectUsbDdr, receiveUsbDdr, usbDdrMaximum, usbDdrTriggerMaximum} from './eskUsbDdr.js';
import {requestEskDevice, restoreEskLogicDevice, selectedEskUsbDevice, selectEskUsbDevice} from './eskCapture.js';

const MiB = 1024 * 1024, maximum = 2147483520;
const wait = ms => new Promise(done => setTimeout(done, ms));
class Board {
  capacity = maximum;
  flags = 3;
  transport = 1;
  hz = 500000000;
  firmware = 0x2b01;
  sid = 33n;
  boot = 54n;
  capture = 77n;
  reads = [];
  native = [];
  common = [];
  retired = false;
  cleanupBusy = false;
  configuration = {interfaces: [{interfaceNumber: 0, alternate: {interfaceClass: 255,
    endpoints: [{type: 'bulk', direction: 'in', endpointNumber: 1}]}}]};
  async open() { this.opened = true; }
  async close() { this.opened = false; }
  async claimInterface(n) { assert.equal(n, 0); }
  async releaseInterface(n) { assert.equal(n, 0); }
  async controlTransferOut(setup, bytes) {
    assert.equal(setup.index, 0);
    assert.equal(setup.value, 1);
    if (setup.request === 0x71) this.req = new DataView(bytes);
    else assert([0x73, 0x75].includes(setup.request));
    return {status: 'ok', bytesWritten: bytes.byteLength};
  }
  async controlTransferIn(setup) {
    if (setup.request === 0x70) {
      const data = new DataView(new ArrayBuffer(24));
      data.setUint16(0, 1, true); data.setUint16(2, 1, true);
      data.setBigUint64(8, this.boot, true); data.setUint32(16, 5000, true); data.setUint16(20, 176, true);
      return {status: 'ok', data};
    }
    assert.equal(setup.request, 0x72);
    const req = this.req, op = req.getUint8(10);
    this.common.push(op);
    const identity = op === 1 && req.getUint8(48) === 1;
    const data = new DataView(new ArrayBuffer(op === 1 && !identity ? 116 : op === 7 ? 128 : op === 6 ? 48 : 100));
    new Uint8Array(data.buffer, 0, 48).set(new Uint8Array(req.buffer, 0, 48));
    data.setUint8(9, 2); data.setUint16(12, data.byteLength, true);
    if (identity) {
      data.setUint32(48,0x7845534b); data.setUint8(52,1); data.setUint8(53,1); data.setUint16(56,52,true);
      data.setUint8(60,1); data.setBigUint64(76,this.boot,true); data.setUint32(84,this.firmware,true);
      data.setUint32(92,1,true); data.setUint32(96,1,true);
    } else if (op === 1) {
      const idx = req.getUint32(52,true);
      assert.equal(req.getUint8(48), 2);
      assert(idx < 2);
      data.setUint32(48, 0x7845534b); data.setUint8(52, 1); data.setUint8(53, 2); data.setUint16(56, 68, true);
      data.setUint16(60, idx + 1, true); data.setUint32(64, this.flags, true); data.setUint32(68, this.transport, true);
      data.setBigUint64(80, BigInt(this.hz), true); data.setBigUint64(96, BigInt(this.capacity), true);
    } else if (op === 7) {
      const cmd = req.getUint32(56,true);
      this.native.push(cmd);
      assert.equal(req.getUint32(48,true), 0x32434c78); assert.equal(req.getUint16(54,true), 40);
      data.setUint32(48, 0x32434c78, true); data.setUint16(52, 2, true);
      data.setUint16(54, 80, true); data.setUint32(56, cmd, true); data.setBigUint64(72, this.capture, true);
      if (cmd === 2) {
        assert.equal(req.getBigUint64(64,true), 0n); this.requestedRate = req.getUint32(80,true);
        this.edge = [req.getUint8(84), req.getUint8(85)];
        this.prePercent = req.getUint8(86);
        assert.equal(req.getUint8(87), 0);
        assert.equal(req.getUint16(60,true), 1); assert.equal(req.getUint16(62,true), 255);
        this.extent = req.getBigUint64(72,true);
        if (!this.prePercent) assert.equal(this.extent % (this.requestedRate === 500000000 ? 192n : 64n), 0n);
      } else assert.equal(req.getBigUint64(64,true), this.capture);
      if (cmd === 2 || cmd === 3) {
        const ready = !this.hold;
        data.setUint16(64, 5 | (ready ? 512 : 256), true); data.setUint8(66, 1); data.setUint8(67, 255);
        data.setUint32(80, this.requestedRate, true); data.setBigUint64(88, this.extent, true);
        data.setBigUint64(96, this.extent, true); data.setBigUint64(120, 200000000n, true);
        if (cmd === 3 && this.hold) this.hold();
      } else {
        assert([5,6].includes(cmd)); data.setUint16(64, 5, true);
        if (this.cleanupBusy) { this.cleanupBusy = false; data.setUint32(60, 2, true); }
        else this.retired = true;
      }
    } else if (op !== 6) {
      assert([2,3,4,5].includes(op));
      data.setBigUint64(32, this.sid, true); data.setUint32(48, 0x7845534b);
      data.setUint8(52, 1); data.setUint8(53, 5); data.setUint16(56, 52, true);
      data.setBigUint64(60, this.boot, true); data.setBigUint64(68, this.sid, true);
      data.setUint16(84, 2, true); data.setUint32(88, 1, true);
      new Uint8Array(data.buffer).set([1,1,op <= 3 ? 1 : 3,1], 92);
      data.setUint32(96, op >= 4 ? 1 : 0, true);
    }
    return {status: 'ok', data};
  }
  async transferIn(ep, length) {
    assert.equal(ep, 1); assert.equal(this.native.at(-1), 3);
    assert(length > 0 && length <= MiB);
    this.reads.push(length);
    const data = new Uint8Array(length - Number(!!this.short));
    data.fill(this.reads.length);
    return {status: 'ok', data: new DataView(data.buffer)};
  }
}

// A single browser grant restores MI0 in a new tab. Multiple grants require an
// explicit choice unless the previously selected serial uniquely matches.
{
  const a = Object.assign(new Board(), {vendorId: 0x1209, productId: 3, serialNumber: 'A'});
  const b = Object.assign(new Board(), {vendorId: 0x1209, productId: 3, serialNumber: 'B', capacity: 0});
  const other = {vendorId: 0, productId: 3};
  let grants = [a,b,other], pickCount = 0;
  const storage = new Map();
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'localStorage', {configurable: true, value: {
    getItem: key => storage.get(key) ?? null, setItem: (key, val) => storage.set(key, val), removeItem: key => storage.delete(key),
  }});
  const usb = {getDevices: async () => grants, requestDevice: async () => { pickCount++; return a; }};
  Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {usb}});
  await restoreEskLogicDevice();
  assert.equal(selectedEskUsbDevice(), undefined);
  grants = [a,other];
  await Promise.all([restoreEskLogicDevice(), restoreEskLogicDevice()]);
  assert.equal(selectedEskUsbDevice(), a); assert.equal(usbDdrMaximum(a), maximum);
  assert.deepEqual(a.common, [1,1,1]); assert.equal(pickCount, 0);
  selectEskUsbDevice(undefined); grants = [a,b];
  await restoreEskLogicDevice();
  assert.equal(selectedEskUsbDevice(), a); assert.deepEqual(a.common, [1,1,1]);
  selectEskUsbDevice(undefined); grants = [b];
  await restoreEskLogicDevice(); assert.equal(selectedEskUsbDevice(), undefined);
  await requestEskDevice(true); assert.equal(pickCount, 1); assert.equal(selectedEskUsbDevice(), a);
  forgetUsbDdr(a); a.capacity = 0;
  await requestEskDevice(); assert.equal(usbDdrMaximum(a), 0); assert.equal(pickCount, 1);
  selectEskUsbDevice(undefined);
  if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage); else delete globalThis.localStorage;
  if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator); else delete globalThis.navigator;
}
const signal = () => new AbortController().signal;
for (const changes of [{capacity: 0}, {flags: 67}, {transport: 2}, {hz: 333333333}]) {
  const board = Object.assign(new Board(), changes);
  assert.equal(await inspectUsbDdr(board), 0); assert.equal(usbDdrMaximum(board), 0);
  await assert.rejects(receiveUsbDdr(board, 1000, signal(), assert.fail), /capacity/);
  assert(!board.common.includes(2)); assert(!board.opened);
}
{
  const board = new Board(), blocks = [];
  assert.equal(await inspectUsbDdr(board), maximum);
  board.cleanupBusy = true;
  await receiveUsbDdr(board, MiB - 1, signal(), async block => {
    blocks.push(block.length); assert.equal(block[0], 1); assert.equal(block.at(-1), 1);
    await wait(1150); // Persistence delayed long enough for a separate common heartbeat.
  });
  assert.deepEqual(blocks, [MiB - 1]);
  assert.deepEqual(board.reads, [MiB, 128]); assert.deepEqual(board.native, [2,3,6,6]);
  assert(board.common.includes(3)); assert(board.retired); assert(!board.opened);
}
{
  const board = new Board(), controller = new AbortController();
  board.hold = () => controller.abort();
  await assert.rejects(receiveUsbDdr(board, 2_000_000_000, controller.signal, assert.fail), {name: 'AbortError'});
  assert.equal(board.extent, 2000000064n); assert.deepEqual(board.reads, []);
  assert.deepEqual(board.native, [2,3,5]); assert(board.retired); assert(!board.opened);
}
{
  const board = new Board(), controller = new AbortController(), saved = [];
  await assert.rejects(receiveUsbDdr(board, 3 * MiB, controller.signal, async block => {
    saved.push(block.length);
    controller.abort();
  }), {name: 'AbortError'});
  assert.deepEqual(saved, [MiB]); assert.deepEqual(board.reads, [MiB]);
  assert.deepEqual(board.native, [2,3,5]); assert(board.retired); assert(!board.opened);
}
{
  const board = new Board(), saved = [];
  await receiveUsbDdr(board, MiB + 3, signal(), async block => {
    saved.push(block.length);
    assert.equal(block[0], saved.length); assert.equal(block.at(-1), saved.length);
  });
  assert.deepEqual(saved, [MiB, 3]); assert.deepEqual(board.reads, [MiB, 128]); assert(board.retired);
}
{
  const board = new Board(); board.short = true;
  await assert.rejects(receiveUsbDdr(board, 1000, signal(), assert.fail), /Incomplete/);
  assert.deepEqual(board.native, [2,3,5]); assert(board.retired); assert(!board.opened);
}
{
  const board = new Board();
  await assert.rejects(receiveUsbDdr(board, maximum + 1, signal(), assert.fail), /capacity/);
  assert(!board.common.includes(2));
}
console.log('USB finite DDR capability, bounded download, heartbeat and cancellation passed');

for (const [i,rate] of [333333333,166666666,83333333,41666666].entries()) {
  const board = new Board(), edge = i % 2 ? 'falling' : 'rising';
  const trigger = {edge, channel: 3, onArmed() { assert.equal(board.native.at(-1),2); }};
  await assert.rejects(receiveUsbDdr(board, 193, signal(), assert.fail, rate, trigger), /Unsupported/);
  board.firmware = 0x2c00;
  let saved = 0;
  await receiveUsbDdr(board, 193, signal(), block => { saved += block.length; }, rate, trigger);
  assert.equal(usbDdrTriggerMaximum(board, rate), maximum);
  assert.deepEqual(board.edge, [i % 2 ? 2 : 1,3]); assert.equal(saved,193); assert.equal(board.extent,256n);
  await assert.rejects(receiveUsbDdr(board, 193, signal(), assert.fail, 500000000, trigger), /Unsupported/);
  const controller = new AbortController();
  board.hold = () => {};
  await assert.rejects(receiveUsbDdr(board, 193, controller.signal, assert.fail, rate, {...trigger,
    onArmed() { controller.abort(); }}), {name: 'AbortError'});
  assert.equal(board.native.at(-1),5);
}

{
  const board = new Board(), hz = 41666666;
  const capture = (count, rate, prePercent) => receiveUsbDdr(board,count,signal(),async () => {},rate,
    {edge:'rising',channel:7,prePercent,onArmed() {}});
  board.firmware = 0x2c00;
  await assert.rejects(capture(1024,hz,25), /Unsupported/);
  board.firmware = 0x2d00;
  for (const p of [25,50,75,0]) {
    await capture(1024,hz,p);
    assert.equal(board.prePercent,p);
    assert.equal(board.extent,1024n); assert.deepEqual(board.edge,[1,7]);
  }
  for (const [n,rate,p] of [[1000,hz,50],[1023,hz,50],[1025,hz,50],[1024,83333333,50],[1024,hz,49]]) {
    const starts = board.native.length;
    await assert.rejects(capture(n,rate,p), /Unsupported/); assert.equal(board.native.length,starts);
  }
  await assert.rejects(capture(100000,hz,50), /Unsupported/);
  board.firmware = 0x3000;
  await assert.rejects(capture(100000,166666666,50), /Unsupported/);
  board.firmware = 0x3100;
  for (const percent of [25,50,75]) await capture(100000,166666666,percent);
  for (const count of [1024,99999,100001,1000000]) await assert.rejects(capture(count,166666666,50), /Unsupported/);
  for (const [firmware, rates] of [[0x2e00,[hz]], [0x2f00,[hz,83333333]]]) {
    board.firmware = firmware;
    for (const rate of rates) for (const n of [1024,100000,1000000]) for (const p of [25,50,75]) {
      board.reads = [];
      await capture(n,rate,p);
      assert.equal(board.extent,BigInt(n));
      assert.deepEqual(board.reads,[n]);
    }
    await assert.rejects(capture(100001,hz,50), /Unsupported/);
    if (firmware === 0x2e00) await assert.rejects(capture(100000,83333333,50), /Unsupported/);
  }
}
