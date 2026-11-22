// SPDX-License-Identifier: GPL-3.0-or-later
import { EskUsbSession, withUsbInterface, within, requireField, delay } from './eskUsbSession.js';

/** Finite raw8 capture on ESK's existing scoped xLOGIC USB interface. */
export const ESK_CHANNELS = 8;
export const ESK_SAMPLES = 65_536;
export const ESK_RATE = 333_333_333;
export const ESK_STREAM_RATE = 41_666_666;
export const ESK_FINITE_RATES = [ESK_RATE, 166_666_666, 83_333_333, ESK_STREAM_RATE];
const streamReadBytes = 4 * 1024 * 1024;
const LOGIC = 2;
const USB_INTERFACE = 0;
const ABI_MAGIC = 0x584c4f47;
const SCOPED_MAGIC = new TextEncoder().encode('xELG');

let selected: USBDevice | undefined;
export function selectEskUsbDevice(device?: USBDevice): void { selected = device; }
export function requestEskDevice(): Promise<USBDevice> {
  return selected ? Promise.resolve(selected) : navigator.usb.requestDevice({ filters: [{ vendorId: 0x1209, productId: 3 }] });
}

function abi(view: DataView, length: number): void {
  requireField(view.byteLength === length && view.getUint32(0, true) === ABI_MAGIC &&
    view.getUint16(4, true) === 3 && view.getUint16(6, true) === length, 'Unexpected xLOGIC USB descriptor');
}
class LogicSession extends EskUsbSession {
  private operation = 0n;
  constructor(device: USBDevice) { super(device, USB_INTERFACE, 0x70, LOGIC); }
  private async command(opcode: 1 | 2 | 3, config?: ArrayBuffer): Promise<void> {
    const req = new ArrayBuffer(32 + (config?.byteLength ?? 0));
    const bytes = new Uint8Array(req);
    const v = new DataView(req);
    bytes.set(SCOPED_MAGIC);
    bytes[4] = 1;
    bytes[5] = opcode;
    v.setBigUint64(8, this.boot, true);
    v.setBigUint64(16, this.session, true);
    v.setBigUint64(24, ++this.operation, true);
    if (config) bytes.set(new Uint8Array(config), 32);
    await this.output(0x76, req);
    const reply = await this.input(0x77, 96);
    requireField(bytes.subarray(0, 32).every((b, i) => i === 6 || reply.getUint8(i) === b),
      'Mismatched scoped xLOGIC reply');
    requireField(reply.getUint8(6) === 0, 'ESK rejected capture command ' + opcode);
    abi(new DataView(reply.buffer, reply.byteOffset + 32, 64), 64);
  }
  private async configure(stream: boolean, rate: number): Promise<void> {
    const caps = await this.input(0x60, 56, 0);
    abi(caps, 56);
    const flags = caps.getUint32(32, true);
    const uniformMax = caps.getUint32(36, true);
    const supported = stream ? (flags & 4) && !(flags & 512) && (!uniformMax || uniformMax >= ESK_STREAM_RATE) :
      caps.getUint32(12, true) >= ESK_SAMPLES && caps.getUint32(20, true) >= ESK_SAMPLES;
    requireField(supported && caps.getUint32(8, true) === 0 && caps.getUint32(24, true) === ESK_RATE &&
      caps.getUint32(28, true) === 8 && (flags & 256), 'ESK firmware does not support the requested raw8 profile');
    requireField(ESK_FINITE_RATES.includes(rate) && (!uniformMax || rate <= uniformMax) &&
      (!(flags & 512) || rate === ESK_RATE), 'Sample rate unavailable on this ESK');
    await this.openConnection();
    await this.control(2);
    const config = new DataView(new ArrayBuffer(44));
    config.setUint32(0, ABI_MAGIC, true);
    config.setUint16(4, 3, true);
    config.setUint16(6, 44, true);
    config.setUint32(8, rate, true);
    config.setUint32(12, stream ? 0 : ESK_SAMPLES, true);
    config.setUint32(16, 0xff, true);
    await this.command(1, config.buffer);
  }
  async capture(rate: number): Promise<Uint8Array> {
    await this.configure(false, rate);
    // Queue the exact-length read before START. A packet-aligned finite record has no trailing ZLP.
    const read = this.usb.transferIn(1, ESK_SAMPLES);
    void read.catch(() => {}); // START can fail before we await the pending read.
    await this.command(2);
    const data = await within(read, 700);
    requireField(data.status === 'ok' && data.data?.byteLength === ESK_SAMPLES, 'Incomplete xLOGIC sample record');
    await this.command(3);
    await this.checkFinalStatus(false, rate);
    await this.release();
    return new Uint8Array(data.data.buffer, data.data.byteOffset, data.data.byteLength);
  }

  async stream(signal: AbortSignal, accept: (bytes: Uint8Array) => void): Promise<bigint> {
    if (signal.aborted) return 0n;
    await this.configure(true, ESK_STREAM_RATE);
    if (signal.aborted) { await this.release(); return 0n; }
    const pending: Promise<USBInTransferResult>[] = [];
    const post = () => {
      const read = this.usb.transferIn(1, streamReadBytes);
      void read.catch(() => {}); // Device close retires any outstanding bulk reads.
      pending.push(read);
    };
    for (let i = 0; i < 4; i++) post();
    await this.command(2);
    let renew = performance.now() + 200;
    let received = 0n, transmitted = 0n;
    try {
      while (!signal.aborted) {
        if (performance.now() >= renew) {
          await this.control(3);
          renew = performance.now() + 200;
        }
        const read = await within(pending.shift()!, 700);
        if (signal.aborted) break;
        requireField(read.status === 'ok' && read.data?.byteLength === streamReadBytes, 'Incomplete xLOGIC stream read');
        post();
        accept(new Uint8Array(read.data.buffer, read.data.byteOffset, read.data.byteLength));
        received += BigInt(read.data.byteLength);
      }
    } finally {
      await this.command(3);
      try {
        transmitted = await this.checkFinalStatus(true, ESK_STREAM_RATE);
        // Queued IN reads can outlive Stop. Reset this pipe while LOGIC is
        // still ours so the next client can receive its first finite record.
        await this.usb.clearHalt('in', 1);
      } finally { await this.release(); }
    }
    requireField(transmitted >= received, 'ESK transmitted fewer bytes than the host received');
    return transmitted;
  }

  private async checkFinalStatus(stream: boolean, rate: number): Promise<bigint> {
    const end = performance.now() + 400;
    do {
      const s = await this.input(0x64, 64, 0);
      abi(s, 64);
      const flags = s.getUint32(56, true);
      requireField(!(flags & 32), 'ESK capture session fault');
      if (!s.getUint32(12, true) && (flags & 28) === 4) {
        const sent = s.getBigUint64(24, true);
        requireField((stream ? s.getUint32(8, true) === 1 && s.getUint32(44, true) === rate : (s.getBigUint64(16, true) === BigInt(ESK_SAMPLES) && sent === BigInt(ESK_SAMPLES))) &&
          [32, 36, 40, 52, 60].every(i => !s.getUint32(i, true)) && (flags & 1) &&
          s.getUint32(48, true) === rate, 'xLOGIC sample counts, rate or error counters differ');
        return sent;
      }
      await delay();
    } while (performance.now() < end);
    throw new Error('ESK capture did not reach quiescence');
  }
}

async function withLogic<T>(device: USBDevice, run: (session: LogicSession) => Promise<T>): Promise<T> {
  const session = new LogicSession(device);
  return withUsbInterface(device, session, intf => {
    requireField(intf.endpoints.some(ep => ep.type === 'bulk' && ep.direction === 'in' && ep.endpointNumber === 1),
      'Missing xLOGIC bulk IN endpoint');
    return run(session);
  });
}

export function captureEsk(device: USBDevice, rate = ESK_RATE): Promise<Uint8Array> {
  return withLogic(device, session => session.capture(rate));
}

export function recordEskUsb(device: USBDevice, signal: AbortSignal, accept: (bytes: Uint8Array) => void): Promise<bigint> {
  return withLogic(device, session => session.stream(signal, accept));
}
