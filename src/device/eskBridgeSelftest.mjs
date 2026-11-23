// SPDX-License-Identifier: GPL-3.0-or-later
import { strict as assert } from 'node:assert';
import { bulkCommand, hexBytes, i2cCommand, parseHex, spiCommands, spiReceiveBytes } from './eskBridgeFrames.js';
const pointer = parseHex('00 00');
assert.deepEqual([...i2cCommand(0x51, pointer, 2).payload], [81, 0, 2, 0, 2, 0, 0, 0]);
assert.deepEqual([...i2cCommand(0x51, pointer, 0).payload], [81, 0, 2, 0, 0, 0]);
assert.deepEqual([...i2cCommand(0x51, new Uint8Array(), 128).payload], [81, 0, 128, 0]);
assert.equal(hexBytes(parseHex('aa10 FF')), 'AA 10 FF');
for (const text of ['Z0', '0', '00 1', '00,FF'])
  assert.throws(() => parseHex(text));
for (const addr of [-1, 7, 120, 256, NaN])
  assert.throws(() => i2cCommand(addr, pointer, 1));
assert.throws(() => i2cCommand(81, new Uint8Array(1019), 1));
assert.throws(() => i2cCommand(81, pointer, 1025));
assert.throws(() => i2cCommand(81, new Uint8Array(), 0));
for (const address of [0x08, 0x77]) assert.equal(i2cCommand(address, pointer, 1).payload[0], address);
for (const [count, fill] of [[0, '00'], [1021, 'FF'], [1.5, '00'], [1, ''], [1, '123'], [1, 'GG']])
  assert.throws(() => spiReceiveBytes(count, fill));
const receive = spiCommands(0, 1000000, spiReceiveBytes(1020, 'a5'))[2];
assert.equal(receive.reply, 1020);
assert.ok(receive.payload.subarray(4).every(byte => byte === 0xa5));
const spi = spiCommands(3, 1000000, Uint8Array.of(0x55));
assert.deepEqual(spi.map(c => c.op), [4, 5, 1]);
assert.deepEqual([...spi[0].payload], [1, 1]);
assert.deepEqual([...spi[2].payload], [0, 0, 1, 0, 85]);
assert.throws(() => spiCommands(4, 1000000, pointer));
for (const fault of ['ok', 'busy', 'nack', 'wrong ID', 'truncated', 'uncertain OUT']) {
  let sent = new Uint8Array(), writes = 0;
  const device = {
    transferOut: async (_ep, packet) => {
      sent = packet.slice();
      writes++;
      return { status: 'ok', bytesWritten: packet.length - (fault === 'uncertain OUT' ? 1 : 0) };
    },
    transferIn: async () => {
      const reply = new Uint8Array(fault === 'busy' ? 32 : fault === 'nack' ? 44 : 46);
      reply.set(sent.subarray(0, 32));
      const v = new DataView(reply.buffer);
      if (fault === 'busy')
        reply[5] = 3;
      else {
        reply[32] = 1;
        v.setUint32(36, 1, true);
        if (fault === 'nack') {
          reply[33] = 1;
          v.setUint32(40, 0xf4001, true);
        }
        else {
          v.setUint16(34, 2, true);
          reply.set([0xaa, 0x55], 44);
        }
        if (fault === 'wrong ID')
          reply[24]++;
        if (fault === 'truncated')
          v.setUint16(34, 1, true);
      }
      return { status: 'ok', data: v };
    },
  };
  const op = bulkCommand(device, 1, 2, 'I2C', 17, 7n, 8n, 1, i2cCommand(81, pointer, 2));
  if (fault === 'ok')
    assert.equal(hexBytes(await op), 'AA 55');
  else
    await assert.rejects(op, fault === 'busy' ? /busy/ : fault === 'nack' ? /NACK/ : /uncertain/);
  assert.equal(writes, 1);
}
console.log('Bridge I²C/SPI frame, correlation, status and no-replay checks passed.');
const { eskBusInterface } = await import('./eskUsbSession.js');
const profile = classes => ({ configuration: { interfaces: classes.map((interfaceClass, interfaceNumber) => ({
      interfaceNumber, alternate: { interfaceClass, interfaceName: null, endpoints: ['in', 'out'].map(direction => ({ type: 'bulk', direction })) }
    })) } });
for (const [classes, spi] of [
  [[255, 255, 255, 255, 255, 255], 3], [[255, 255, 255, 2, 10, 255, 255, 255], 5],
  [[255, 255, 255, 2, 10, 255, 255, 255, 255, 255], 7],
]) {
  assert.equal(eskBusInterface(profile(classes), 'SPI'), spi);
  assert.equal(eskBusInterface(profile(classes), 'CAN'), spi + 1);
}
assert.throws(() => eskBusInterface(profile([255, 255]), 'CAN'), /Unknown/);
const { canTransaction } = await import('./eskCan.js');
for (const fault of [false, true]) {
  const eps = [{ type: 'bulk', direction: 'out', endpointNumber: 3 }, { type: 'bulk', direction: 'in', endpointNumber: 4 }];
  const interfaces = [{ interfaceNumber: 8, alternate: { interfaceClass: 255, interfaceName: 'xESK xCAN', endpoints: eps } },
    { interfaceNumber: 0, alternate: { interfaceClass: 255, endpoints: [] } }];
  let frame, reads = 0, stops = 0, opened = false;
  const claimed = new Set();
  const can = {
    configurations: [{ interfaces }], configuration: { interfaces }, get opened() { return opened; },
    open: async () => { opened = true; }, close: async () => { opened = false; },
    claimInterface: async (n) => { assert.ok(!claimed.has(n)); claimed.add(n); }, releaseInterface: async (n) => { assert.ok(claimed.delete(n)); },
    controlTransferOut: async (s, buf) => {
      assert.ok(claimed.has(s.index));
      if (s.request === 2 && new DataView(buf).getUint32(0, true) === 0)
        stops++;
      return { status: 'ok', bytesWritten: buf.byteLength };
    },
    controlTransferIn: async (s, len) => {
      const data = new DataView(new ArrayBuffer(len));
      assert.ok(claimed.has(s.index));
      if (s.request === 4)
        data.setUint32(4, 80000000, true);
      if (s.request === 14)
        data.setUint32(0, 4, true);
      return { status: 'ok', data };
    },
    transferOut: async (_n, buf) => { frame = buf.slice(); return { status: 'ok', bytesWritten: buf.length }; },
    transferIn: async () => { const reply = frame.slice(); if (reads++ === 0)
      reply.fill(255, 0, 4);
    else if (fault)
      reply[12] ^= 1; return { status: 'ok', data: new DataView(reply.buffer) }; },
  };
  const result = canTransaction(can, 'loopback', 500000, 0x123, pointer);
  if (fault)
    await assert.rejects(result, /echo mismatch/);
  else
    assert.match(await result, /Loopback RX/);
  assert.equal(reads, 2);
  assert.equal(stops, 1);
  assert.equal(claimed.size, 0);
  assert.equal(opened, false);
}
let wire, write, dtr = [], closed = false;
const fakePort = {
  readable: new ReadableStream({ start(controller) { wire = controller; } }),
  writable: new WritableStream({ write(chunk) { write = chunk.slice(); } }),
  open: async (options) => { assert.deepEqual(options, { baudRate: 115200, dataBits: 8, parity: 'none', stopBits: 1 }); },
  close: async () => { closed = true; }, setSignals: async (s) => { dtr.push(s.dataTerminalReady); },
};
Object.defineProperty(navigator, 'serial', { configurable: true, value: {
    requestPort: async (opts) => { assert.deepEqual(opts.filters, [{ usbVendorId: 0x1209, usbProductId: 3 }]); return fakePort; },
  } });
const { BridgeUart } = await import('./eskSerial.js');
const serial = await BridgeUart.open({ baudRate: 115200, dataBits: 8, parity: 'none', stopBits: 1 });
const rx = [];
const reading = serial.receive(chunk => rx.push(...chunk));
wire.enqueue(pointer);
await serial.send(Uint8Array.of(0x55));
await serial.close();
await reading;
assert.deepEqual(rx, [0, 0]);
assert.deepEqual([...write], [0x55]);
assert.deepEqual(dtr, [true, false]);
assert.ok(closed);
console.log('CAN echo/RX, cleanup on failure and UART grant, transmit, receive and DTR lifecycle passed.');
