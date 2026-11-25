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

const { gpioCommand, pwmCommand, pwmTiming } = await import('./eskOutputs.js');
assert.deepEqual([...gpioCommand(true, 3, 2).payload], [3,0,0,0,2,0,0,0]);
assert.equal(gpioCommand(false, 1, 0).op, 2);
for (const [mask, high] of [[0,0],[128,0],[1,2],[3,4]]) assert.throws(() => gpioCommand(true, mask, high));
const pwm = pwmCommand(1000000, 1, 12.5, 0);
assert.equal(new DataView(pwm.payload.buffer).getUint32(4, true), 125);
assert.throws(() => pwmCommand(1000000, 0, 50, 0));
assert.throws(() => pwmCommand(1000000, 1, 0.01, 0));
assert.equal(pwmTiming(new Uint8Array(new Uint32Array([100000000, 1, 100000, 50000, 0]).buffer)), (1000).toLocaleString() + ' Hz · A 50.00% · B 0.00%');
assert.throws(() => pwmTiming(new Uint8Array(20)));
assert.equal(eskBusInterface(profile([255,255,255,2,10,255,255,255,255,255]), 'GPIO/PWM'), 9);
for (const [service, channel] of [['GPIO', 6], ['PWM', 7]]) {
  let packet;
  const usb = {
    transferOut: async (_ep, data) => { packet = data.slice(); return {status: 'ok', bytesWritten: data.length}; },
    transferIn: async (_ep, size) => {
      assert.equal(size, 64);
      assert.equal(new TextDecoder().decode(packet.subarray(0, 4)), 'xEGP');
      assert.equal(packet[32], channel);
      const reply = new Uint8Array(44);
      reply.set(packet.subarray(0, 32));
      reply[32] = channel;
      new DataView(reply.buffer).setUint32(36, 5, true);
      return {status: 'ok', data: new DataView(reply.buffer)};
    }
  };
  assert.equal((await bulkCommand(usb, 2, 3, service, 1, 2n, 3n, 5, {op: 7, payload: new Uint8Array(), reply: 0})).length, 0);
}
console.log('GPIO/PWM output validation, timing and shared USB interface framing passed.');

// A PWM/1 grant must keep its instance across renewal and safe release. A failed
// bulk response must end the grant without resending the output command.
const { openOutputs } = await import('./eskOutputs.js');
for (const loseReply of [false, true]) {
  const controls = [], bulkWrites = [];
  const alt = {interfaceClass: 255, interfaceName: 'xESK xGPIO/PWM', endpoints: [
    {type: 'bulk', direction: 'in', endpointNumber: 3}, {type: 'bulk', direction: 'out', endpointNumber: 3}
  ]};
  let request, bulk, opened = false, claimed = false;
  const device = {
    configuration: {interfaces: [{interfaceNumber: 9, alternate: alt}]},
    get opened() { return opened; },
    async open() { opened = true; }, async close() { opened = false; },
    async claimInterface(n) { assert.equal(n, 9); claimed = true; },
    async releaseInterface(n) { assert.equal(n, 9); claimed = false; },
    async controlTransferOut(setup, bytes) {
      assert.ok(claimed);
      if (setup.request === 0x61) {
        request = new DataView(bytes);
        const op = request.getUint8(10);
        assert.equal(request.getUint16(42, true), op === 1 ? 0 : 1);
        controls.push(op);
      }
      return {status: 'ok', bytesWritten: bytes.byteLength};
    },
    async controlTransferIn(setup) {
      if (setup.request === 0x60) {
        const h = new DataView(new ArrayBuffer(24));
        h.setUint16(0,1,true); h.setUint16(2,5,true); h.setBigUint64(8,2n,true);
        h.setUint32(16,5000,true); h.setUint16(20,176,true);
        return {status:'ok',data:h};
      }
      const op = request.getUint8(10), n = op === 6 ? 48 : 100;
      const r = new DataView(new ArrayBuffer(n));
      new Uint8Array(r.buffer).set(new Uint8Array(request.buffer,0,48));
      r.setUint8(9,2); r.setUint16(12,n,true);
      if (op === 2) r.setBigUint64(32,3n,true);
      if (n > 48) {
        r.setUint32(48,0x7845534b); r.setUint8(52,1); r.setUint16(56,52,true);
        if (op === 1) {
          r.setUint8(53,1); r.setUint8(60,1); r.setBigUint64(76,2n,true); r.setUint32(92,1,true); r.setUint32(96,1,true);
        } else {
          r.setUint8(53,5); r.setBigUint64(60,2n,true); r.setBigUint64(68,3n,true);
          r.setUint16(84,12,true); r.setUint16(86,1,true); r.setUint32(88,1,true);
          r.setUint8(92,1); r.setUint8(93,1); r.setUint8(94,op<=3?1:3); r.setUint8(95,1);
          r.setUint32(96,op<=3?0:1,true);
        }
      }
      return {status:'ok',data:r};
    },
    async transferOut(_ep, bytes) { bulk = bytes; bulkWrites.push(bytes[33]); return {status:'ok',bytesWritten:bytes.length}; },
    async transferIn() {
      if (loseReply) return {status:'stall'};
      const r = new Uint8Array(44);
      r.set(bulk.subarray(0,32)); r[32]=7; new DataView(r.buffer).setUint32(36,1,true);
      return {status:'ok',data:new DataView(r.buffer)};
    }
  };
  const handle = await openOutputs(device, {deviceId:'01'+'00'.repeat(15), boot:'2', features:[{name:'PWM',instance:1,enabled:true}]}, 'PWM', 1);
  if (loseReply) {
    await assert.rejects(handle.send(pwm), /uncertain/);
    await assert.rejects(handle.done, /uncertain/);
  } else {
    await handle.send(pwm);
    await new Promise(resolve => setTimeout(resolve, 1150));
    assert.ok(controls.includes(3));
    await handle.close();
  }
  assert.deepEqual(controls.slice(-2),[4,6]);
  assert.deepEqual(bulkWrites,[1]);
  assert.ok(!opened && !claimed);
}
console.log('PWM/1 wire identity, renewal, release and uncertain-delivery cleanup passed.');

const {openEthernetUart} = await import('./eskEthernetUart.js');
const board = {deviceId:'a'.repeat(32),boot:'42',uartLimits:{write:120,read:116}};
const line = {baudRate:115200,dataBits:8,stopBits:1,parity:'none'};
for (const local of [false,true]) {
  let n = 1, retired = false;
  const parts = [], opened = [], expected = Uint8Array.from({length:241},(_,i) => i);
  globalThis.location = new URL(local ? 'http://127.0.0.1:42000/#eskLocal='+'b'.repeat(32) : 'https://example.org/#eskBoard=http%3A%2F%2F192.0.2.1%3A5555');
  globalThis.document = {querySelector:() => true};
  const handle = (msg,close) => {
    assert.equal(msg.id,++n);
    if (close) { retired=true; return {closed:true}; }
    if (msg.data) { parts.push(...msg.data); return {id:n,status:0,data:[]}; }
    assert.equal(msg.count,116);
    return {id:n,status:0,data:[0xaa,0x55]};
  };
  globalThis.window = {parent:{postMessage(msg,origin,[port]) {
    assert.equal(origin,'http://192.0.2.1:5555'); assert.equal(msg.type,'xesk.uart.v1'); opened.push(msg);
    port.onmessage = ({data}) => { port.postMessage(handle(data,data.close)); if(data.close)port.close(); };
    port.postMessage({ready:true});
  }}};
  globalThis.fetch = async (_url,options) => {
    const msg=JSON.parse(options.body);
    if (msg.op === 'lan_uart_open') { opened.push(msg); return Response.json('c'.repeat(32)); }
    assert.equal(msg.token,'c'.repeat(32));
    return Response.json(handle(msg,msg.op==='lan_uart_close'));
  };
  const uart = await openEthernetUart(board,line);
  assert.deepEqual(opened[0].settings,{baud:115200,dataBits:8,stopBits:1,parity:0});
  await uart.send(expected);
  const rx=Promise.withResolvers();
  const reading=uart.receive(bytes => rx.resolve(bytes));
  assert.deepEqual([...(await rx.promise)],[0xaa,0x55]);
  await uart.close(); await reading;
  assert.deepEqual(parts,[...expected]); assert.ok(retired);
}
console.log('Paired and localhost UART retain one grant across chunked writes and received bytes, then close.');
