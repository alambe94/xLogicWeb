// SPDX-License-Identifier: GPL-3.0-or-later
import { captureEsk, ESK_RATE, ESK_SAMPLES } from './eskCapture.js';
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
  private stall = true;
  private control = new DataView(new ArrayBuffer(0));
  private command = new DataView(new ArrayBuffer(0));
  private boot = 0xabcd1234n;

  async open(): Promise<void> { this.opened = true; }
  async close(): Promise<void> { this.opened = false; }
  async claimInterface(n: number): Promise<void> { expect(n === 0, 'only claim MI0'); }

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
        expect(v.byteLength === 76 && v.getUint32(40, true) === ESK_RATE &&
          v.getUint32(44, true) === ESK_SAMPLES && v.getUint32(48, true) === 255, 'finite configuration');
      }
      if (op === 2) expect(this.readQueued, 'read must be queued before START');
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
        for (const [i, n] of [[12, 131072], [20, 262144], [24, ESK_RATE], [28, 8], [32, 256]]) data.setUint32(i, n, true);
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
          bytes.set([1, 1, op === 2 ? 1 : 3, 1], 92);
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
        data = native(64);
        data.setUint32(8, 1, true); data.setBigUint64(16, BigInt(ESK_SAMPLES), true);
        data.setBigUint64(24, BigInt(ESK_SAMPLES - Number(this.badCount)), true);
        data.setUint32(48, ESK_RATE, true); data.setUint32(56, 5, true);
        break;
      default: throw new Error('unexpected control read');
    }
    return { status: 'ok', data };
  }
  async transferIn(endpoint: number, size: number) {
    expect(endpoint === 1 && size === ESK_SAMPLES, 'finite endpoint and size');
    this.readQueued = true;
    const data = new Uint8Array(size - Number(this.short));
    data[0] = 0x81; data[1] = 0x02;
    return { status: 'ok', data: new DataView(data.buffer) };
  }
}
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
