// SPDX-License-Identifier: GPL-3.0-or-later
import { EskUsbSession, withUsbInterface } from './eskUsbSession.js';
import { decodeBoardId } from './eskUsbHome.js';
import { captureEsk, recordEskUsb, ESK_PACKED_RATE, ESK_RATE, ESK_SAMPLES, ESK_STREAM_RATE } from './eskCapture.js';
import { createSampleStore } from '../data/index.js';

function expect(ok: unknown, detail: string): asserts ok {
  if (!ok) throw new Error(detail);
}
function native(length: number): DataView<ArrayBuffer> {
  const v = new DataView(new ArrayBuffer(length));
  v.setUint32(0, 0x584c4f47, true);
  v.setUint16(4, 3, true);
  v.setUint16(6, length, true);
  return v;
}

/** Model the scoped replies, including the delayed common FETCH and safe-release query. */
class Board {
  live = false;
  finiteRate = ESK_RATE;
  finiteSize = ESK_SAMPLES;
  bankMask = 255;
  get wireRate() { return this.live && this.bankMask === 255 ? ESK_STREAM_RATE : this.finiteRate; }
  readCount = 0;
  opened = false;
  configuration = { interfaces: [{ interfaceNumber: 0, alternate: {
    interfaceClass: 255, endpoints: [{ type: 'bulk', direction: 'in', endpointNumber: 1 }],
  } }] };
  controls: number[] = [];
  commands: number[] = [];
  closedSession = false;
  readQueued = false;
  short = false;
  badCount = false;
  failClear = false;
  overruns = 0;
  clears = 0;
  statusRead = false;
  edge?: {channel: number; falling: boolean};
  holdEdge = false;
  private stall = true;
  private control = new DataView(new ArrayBuffer(0));
  private command = new DataView(new ArrayBuffer(0));
  private boot = 0xabcd1234n;

  async open(): Promise<void> { this.opened = true; }
  async close(): Promise<void> { this.opened = false; }
  async claimInterface(n: number): Promise<void> { expect(n === 0, 'only claim MI0'); }

  async releaseInterface(n: number): Promise<void> { expect(n === 0, 'only release MI0'); }

  async clearHalt(direction: USBDirection, endpoint: number): Promise<void> {
    expect(this.live && direction === 'in' && endpoint === 1, 'clear only the live sample pipe');
    expect(this.commands.at(-1) === 3 && this.statusRead && !this.controls.includes(4), 'clear after quiescence and before release');
    this.clears++;
    if (this.failClear) throw Error('pipe reset failed');
  }

  async controlTransferOut(setup: USBControlTransferParameters, data: ArrayBuffer) {
    expect(setup.index === 0 && setup.value === 17, 'incorrect control route');
    const v = new DataView(data);
    if (setup.request === 0x71) {
      this.control = v;
      this.controls.push(v.getUint8(10));
      this.stall = true;
    } else if (setup.request === 0x76) {
      this.command = v;
      const op = v.getUint8(5);
      this.commands.push(op);
      if (op === 1) {
        expect(v.byteLength === 76 && v.getUint32(40, true) === this.wireRate &&
          v.getUint32(44, true) === (this.live ? 0 : this.finiteSize) && v.getUint32(48, true) === this.bankMask &&
          v.getUint32(72, true) === (this.bankMask === 255 ? 0 : 3), 'capture configuration');
      }
      if (op === 1) {
        expect(v.getUint32(52, true) === (this.edge ? 2 : 0) &&
          v.getUint32(64, true) === (this.edge?.channel ?? 0) &&
          v.getUint32(68, true) === Number(this.edge?.falling ?? false), 'edge trigger configuration');
      }
      if (op === 2) expect(this.readQueued === !this.edge, 'bulk read ordering at START');
    } else if (setup.request === 0x75) {
      this.closedSession = true;
    } else {
      expect(setup.request === 0x73, 'unexpected acknowledgement');
    }
    return { status: 'ok', bytesWritten: data.byteLength };
  }
  async controlTransferIn(setup: USBControlTransferParameters) {
    let data: DataView<ArrayBuffer>;
    switch (setup.request) {
      case 0x60:
        data = native(56);
        for (const [i, n] of [[12, 131072], [20, 262144], [24, ESK_RATE], [28, 8], [32, this.live ? 260 : 256]]) data.setUint32(i, n, true);
        if (this.bankMask !== 255) {
          for (const [i, n] of [[32, 407], [40, ESK_PACKED_RATE], [44, 15], [48, 32], [52, 64]]) data.setUint32(i, n, true);
        }
        break;
      case 0x70:
        data = new DataView(new ArrayBuffer(24));
        data.setUint16(0, 1, true); data.setUint16(2, 17, true);
        data.setBigUint64(8, this.boot, true); data.setUint32(16, 5000, true); data.setUint16(20, 176, true);
        break;
      case 0x72: {
        if (this.stall) { this.stall = false; return { status: 'stall' }; }
        const op = this.control.getUint8(10);
        data = new DataView(new ArrayBuffer(op === 6 ? 48 : 100));
        const bytes = new Uint8Array(data.buffer);
        bytes.set(new Uint8Array(this.control.buffer, 0, 48)); bytes[9] = 2;
        data.setUint16(12, bytes.length, true); data.setBigUint64(32, 24n, true);
        if (op !== 6) {
          bytes.set([120, 69, 83, 75, 1, 5, 0, 0, 52, 0, 0, 0], 48);
          data.setBigUint64(60, this.boot, true); data.setBigUint64(68, 24n, true);
          data.setBigUint64(76, 1000n, true);
          data.setUint16(84, 2, true); data.setUint32(88, 1, true);
          bytes.set([1, 1, op <= 3 ? 1 : 3, 1], 92);
          data.setUint32(96, op === 5 ? 1 : 0, true);
        }
        break;
      }
      case 0x77:
        data = new DataView(new ArrayBuffer(96));
        new Uint8Array(data.buffer).set(new Uint8Array(this.command.buffer, 0, 32));
        new Uint8Array(data.buffer).set(new Uint8Array(native(64).buffer), 32);
        break;
      case 0x64:
        this.statusRead = true;
        data = native(64);
        data.setUint32(8, 1, true); data.setBigUint64(16, BigInt(this.finiteSize), true);
        data.setBigUint64(24, BigInt(this.finiteSize - Number(this.badCount)), true);
        if (this.live) {
          data.setBigUint64(24, 2n * 4194304n, true);
          data.setUint32(44, this.wireRate, true);
          data.setUint32(60, this.bankMask === 255 ? 0 : 3, true);
        }
        data.setUint32(48, this.wireRate, true); data.setUint32(56, 5, true);
        data.setUint32(32, this.overruns, true);
        if (this.holdEdge && this.commands.at(-1) === 2) {
          data.setBigUint64(16, 0n, true); data.setUint32(12, 1, true);
        }
        break;
      default: throw new Error('unexpected control read');
    }
    return { status: 'ok', data };
  }
  async transferIn(endpoint: number, size: number) {
    if (this.live) {
      expect(endpoint === 1 && size === (this.bankMask === 255 ? 4194304 : 2097152), 'live read size');
      this.readQueued = true;
      const seq = ++this.readCount;
      if (seq === 1) await new Promise(done => setTimeout(done, 230));
      const data = new Uint8Array(size - Number(this.short));
      data[0] = this.bankMask === 255 ? seq : 0xb2;
      return { status: 'ok', data: new DataView(data.buffer) };
    }
    expect(endpoint === 1 && size === this.finiteSize, 'finite endpoint and size');
    this.readQueued = true;
    const data = new Uint8Array(size - Number(this.short));
    data[0] = 0x81; data[1] = 0x02;
    return { status: 'ok', data: new DataView(data.buffer) };
  }
}
for (const hz of [166_666_666, 83_333_333, ESK_STREAM_RATE]) {
  const board = new Board();
  board.finiteRate = hz;
  await captureEsk(board as unknown as USBDevice, hz);
}
// Claim the two interfaces concurrently. Retiring Bridge must leave Logic usable.
{
  let opens = 0, closes = 0;
  const held = new Set<number>();
  const device = {
    opened: false,
    configuration: { interfaces: [0, 1].map(interfaceNumber => ({ interfaceNumber, alternate: { interfaceClass: 255 } })) },
    async open() { opens++; this.opened = true; },
    async close() { closes++; this.opened = false; },
    async claimInterface(n: number) { held.add(n); },
    async releaseInterface(n: number) { held.delete(n); },
  };
  const usb = device as unknown as USBDevice;
  const session = (n: number) => new EskUsbSession(usb, n, 0x60, 0);
  let ready!: () => void, stop!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const finish = new Promise<void>(resolve => { stop = resolve; });
  const capture = withUsbInterface(usb, session(0), async () => { ready(); await finish; });
  await started;
  try {
    let busy = false;
    try { await withUsbInterface(usb, session(0), async () => {}); } catch { busy = true; }
    expect(busy, 'same interface must stay exclusive');
    await withUsbInterface(usb, session(1), async () => { expect(held.size === 2, 'both interfaces claimed'); });
    expect(device.opened && held.has(0) && !held.has(1), 'one interface can retire independently');
  } finally { stop(); await capture; }
  expect(opens === 1 && closes === 1 && held.size === 0, 'one shared open and final close');
}
for (const bank of ['lower', 'upper'] as const) {
  const board = new Board();
  board.live = true;
  board.finiteRate = ESK_PACKED_RATE;
  board.bankMask = bank === 'lower' ? 0x0f : 0xf0;
  const record = await captureEsk(board as unknown as USBDevice, ESK_PACKED_RATE, bank);
  expect(record.length === ESK_SAMPLES && record[0] === 2 && record[1] === 11 &&
    board.closedSession && !board.opened, 'packed bank, nibble order, length and retirement');
}
const odd = new Board();
for (const mode of ['cancel', 'falling', 'rising'] as const) {
  const board = new Board();
  const controller = new AbortController();
  board.edge = {channel: 5, falling: mode !== 'rising'};
  board.holdEdge = true;
  const onArmed = () => setTimeout(() => {
    if (mode === 'cancel') controller.abort();
    else board.holdEdge = false;
  }, 260);
  try {
    await captureEsk(board as unknown as USBDevice, ESK_RATE, 'lower', ESK_SAMPLES,
      {channel: 5, edge: board.edge.falling ? 'falling' : 'rising', signal: controller.signal, onArmed});
    expect(mode !== 'cancel', 'cancelled edge must not publish a capture');
  } catch (error) {
    expect(mode === 'cancel' && error === controller.signal.reason, 'unexpected edge capture failure');
  }
  expect(board.controls.includes(3) && board.controls.includes(6) &&
    String(board.commands) === '1,2,3' && board.readQueued === (mode !== 'cancel') && !board.opened,
    'edge wait renews, stops and releases without a stale bulk read');
}
odd.finiteSize = 12352;
const prefix = await captureEsk(odd as unknown as USBDevice, ESK_RATE, 'lower', 12345);
expect(prefix.length === 12345 && odd.closedSession, 'trim transport padding after verified retirement');
const good = new Board();
const data = await captureEsk(good as unknown as USBDevice);
const store = createSampleStore(8, ESK_RATE);
store.append(data);
expect(store.length === ESK_SAMPLES && store.sampleAt(7, 0) === 1 && store.sampleAt(0, 0) === 1 &&
  store.sampleAt(1, 0) === 0 && store.sampleAt(1, 1) === 1, 'raw byte to viewer channel mapping');
expect(String(good.controls) === '2,4,5,6' && String(good.commands) === '1,2,3' &&
  good.closedSession && !good.opened, 'release, observe safe state, reap and close');
for (const failure of ['short', 'badCount'] as const) {
  const board = new Board();
  board[failure] = true;
  let rejected = false;
  try { await captureEsk(board as unknown as USBDevice); }
  catch { rejected = true; }
  expect(rejected && board.closedSession && !board.opened, failure + ' must fail and close');
}
console.log('ESK raw8 capture, channel mapping, release and error cleanup passed');

for (const scenario of ['stop', 'storage', 'short', 'clear', 'overrun']) {
  const board = new Board();
  board.live = true;
  board.short = scenario === 'short';
  board.failClear = scenario === 'clear';
  board.overruns = Number(scenario === 'overrun');
  const stop = new AbortController();
  const order: number[] = [];
  let failure = '';
  try {
    const wire = await recordEskUsb(board as unknown as USBDevice, stop.signal, bytes => {
      order.push(bytes[0]);
      if (scenario === 'storage') throw Error('storage backlog');
      if (order.length === 2) stop.abort();
    });
    expect(wire === 8388608n, 'terminal wire count');
  } catch (error) { failure = String(error); }
  if (scenario === 'stop') expect(!failure && String(order) === '1,2' && board.controls.includes(3), 'ordered live blocks and renewal');
  else if (scenario === 'overrun') expect(failure.includes('overruns 1'), 'report an integrity failure after retiring the input pipe');
  else expect(failure.includes(scenario === 'short' ? 'Incomplete' : scenario === 'clear' ? 'pipe reset failed' : 'backlog'), 'surface the causal failure');
  expect(board.clears === 1, 'retire the live pipe once');
  expect(String(board.commands) === '1,2,3' && board.controls.includes(6) && board.closedSession && !board.opened,
    'stop, reap and close on every started stream');
}
console.log('ESK continuous USB ordered delivery, renewal, Stop and error cleanup passed');

const header = new Uint8Array(28);
header.set([0xaa, 0x55, 0x33, 0xee, 1, 21, 0, 0x10, 18, 0]);
header.set(new TextEncoder().encode('TEST-BOARD'), 10);
header[26] = 65;
expect(decodeBoardId(header) === 'TEST-BOARD · A', 'TI board information record');
for (const invalid of [header.slice(0, 12), new Uint8Array(128)]) {
  let rejected = false;
  try { decodeBoardId(invalid); } catch { rejected = true; }
  expect(rejected, 'reject damaged or unknown EEPROM records');
}
