// SPDX-License-Identifier: GPL-3.0-or-later
import { EskUsbSession, withUsbInterface, within, requireField, delay } from './eskUsbSession.js';

/** Finite raw8 capture on ESK's existing scoped xLOGIC USB interface. */
export const ESK_CHANNELS = 8;
export const ESK_SAMPLES = 65_536;
export const ESK_RATE = 333_333_333;
export const ESK_STREAM_RATE = 41_666_666;
export const ESK_PACKED_RATE = 500_000_000;
export type EskBank = 'lower' | 'upper';
export type EskEdge = 'rising' | 'falling';
export interface EskEdgeTrigger {
  channel: number;
  edge: EskEdge;
  signal: AbortSignal;
  onArmed: () => void;
}
export const ESK_FINITE_RATES = [ESK_RATE, 166_666_666, 83_333_333, ESK_STREAM_RATE];
const streamReadBytes = 4 * 1024 * 1024;
const LOGIC = 2;
const USB_INTERFACE = 0;
const ABI_MAGIC = 0x584c4f47;
const SCOPED_MAGIC = new TextEncoder().encode('xELG');

let selected: USBDevice | undefined;
export function selectedEskUsbDevice(): USBDevice | undefined { return selected; }
export function selectEskUsbDevice(device?: USBDevice): void {
  if (selected === device) return;
  selected = device;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('esk-usb-ddr'));
}
export async function requestEskDevice(change = false): Promise<USBDevice> {
  if (selected && !change) return selected;
  const device = await navigator.usb.requestDevice({ filters: [{ vendorId: 0x1209, productId: 3 }] });
  selectEskUsbDevice(device);
  return device;
}
if (typeof navigator !== 'undefined') navigator.usb?.addEventListener('disconnect', event => {
  if (event.device === selected) selectEskUsbDevice();
});

export function unpackEsk(bytes: Uint8Array, count: number): Uint8Array {
  const samples = new Uint8Array(count);
  for (let i = 0; i < count; i++) samples[i] = (bytes[Math.floor(i / 2)]! >>> ((i % 2) * 4)) & 15;
  return samples;
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
  private async configure(stream: boolean, rate: number, bank: EskBank = 'lower', count = ESK_SAMPLES, trigger?: EskEdgeTrigger): Promise<void> {
    const caps = await this.input(0x60, 56, 0);
    abi(caps, 56);
    const flags = caps.getUint32(32, true);
    const uniformMax = caps.getUint32(36, true);
    const packed = rate === ESK_PACKED_RATE;
    const mask = packed ? (bank === 'lower' ? 0x0f : 0xf0) : 0xff;
    requireField(caps.getUint32(8, true) === 0 && caps.getUint32(28, true) === 8 && (flags & 256),
      'ESK scoped capture unavailable');
    if (packed) {
      requireField(stream && (flags & 128) && caps.getUint32(40, true) === rate &&
        (caps.getUint32(44, true) === mask || (flags & 16)) &&
        caps.getUint32(48, true) === 32 && caps.getUint32(52, true) === 64,
        'This ESK does not advertise 500 MS/s on the selected four channels');
    } else {
      const supported = stream ? (flags & 4) && !(flags & 512) :
        caps.getUint32(12, true) >= count && caps.getUint32(20, true) >= count;
      requireField(supported && caps.getUint32(24, true) === ESK_RATE && ESK_FINITE_RATES.includes(rate) &&
        (!uniformMax || rate <= uniformMax) && (!(flags & 512) || rate === ESK_RATE),
        'ESK firmware does not support the requested raw8 profile');
    }
    await this.openConnection();
    await this.control(2);
    const config = new DataView(new ArrayBuffer(44));
    config.setUint32(0, ABI_MAGIC, true);
    config.setUint16(4, 3, true);
    config.setUint16(6, 44, true);
    config.setUint32(8, rate, true);
    config.setUint32(12, stream ? 0 : count, true);
    config.setUint32(16, mask, true);
    if (trigger) {
      config.setUint32(20, 2, true); // Single-channel edge mode in the USB config.
      config.setUint32(32, trigger.channel, true);
      config.setUint32(36, Number(trigger.edge === 'falling'), true);
    }
    config.setUint32(40, packed ? 3 : 0, true);
    await this.command(1, config.buffer);
  }
  private async waitForEdge(trigger: EskEdgeTrigger): Promise<void> {
    trigger.onArmed();
    let renew = performance.now() + 200;
    for (;;) {
      trigger.signal.throwIfAborted();
      if (performance.now() >= renew) {
        await this.control(3);
        renew = performance.now() + 200;
      }
      const status = await this.input(0x64, 64, 0);
      abi(status, 64);
      const flags = status.getUint32(56, true);
      requireField(!(flags & 32), 'ESK capture session fault');
      if (status.getBigUint64(16, true) > 0n) return;
      requireField(status.getUint32(12, true) || (flags & 8), 'ESK stopped before the trigger');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  async capture(rate: number, count: number, trigger?: EskEdgeTrigger): Promise<Uint8Array> {
    const aligned = Math.ceil(count / 64) * 64;
    await this.configure(false, rate, 'lower', aligned, trigger);
    // A trigger may wait indefinitely. Leave the bulk pipe empty until samples exist
    // so cancelling an idle acquisition cannot leave a read queued against the next one.
    const read = trigger ? undefined : this.usb.transferIn(1, aligned);
    void read?.catch(() => {});
    await this.command(2);
    try {
      if (trigger) { await this.waitForEdge(trigger); trigger.signal.throwIfAborted(); }
      const data = await within(read ?? this.usb.transferIn(1, aligned), 700);
      requireField(data.status === 'ok' && data.data?.byteLength === aligned, 'Incomplete xLOGIC sample record');
      return new Uint8Array(data.data.buffer, data.data.byteOffset, count);
    } finally {
      await this.command(3);
      try {
        if (!trigger?.signal.aborted) await this.checkFinalStatus(false, rate, aligned);
      } finally { await this.release(); }
    }
  }

  async stream(signal: AbortSignal, accept: (bytes: Uint8Array) => void, rate = ESK_STREAM_RATE, bank: EskBank = 'lower'): Promise<bigint> {
    if (signal.aborted) return 0n;
    await this.configure(true, rate, bank);
    if (signal.aborted) { await this.release(); return 0n; }
    const packed = rate === ESK_PACKED_RATE;
    // Match the 500 MS/s native host queue and retain just the requested prefix.
    const readBytes = packed ? 2 * 1024 * 1024 : streamReadBytes;
    const pending: Promise<USBInTransferResult>[] = [];
    const post = () => {
      const read = this.usb.transferIn(1, readBytes);
      void read.catch(() => {}); // Device close retires any outstanding bulk reads.
      pending.push(read);
    };
    for (let i = 0; i < (packed ? 16 : 4); i++) post();
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
        requireField(read.status === 'ok' && read.data?.byteLength === readBytes, 'Incomplete xLOGIC stream read');
        post();
        accept(new Uint8Array(read.data.buffer, read.data.byteOffset, read.data.byteLength));
        received += BigInt(read.data.byteLength);
      }
    } finally {
      await this.command(3);
      try {
        transmitted = await this.checkFinalStatus(true, rate);
      } finally { await this.release(); }
    }
    requireField(transmitted >= received, 'ESK transmitted fewer bytes than the host received');
    return transmitted;
  }

  private async checkFinalStatus(stream: boolean, rate: number, count = ESK_SAMPLES): Promise<bigint> {
    const end = performance.now() + 400;
    do {
      const s = await this.input(0x64, 64, 0);
      abi(s, 64);
      const flags = s.getUint32(56, true);
      requireField(!(flags & 32), 'ESK capture session fault');
      if (!s.getUint32(12, true) && (flags & 28) === 4) {
        // Retire queued IN reads after physical Stop even when the counters
        // reject this stream. A failed acquisition must also allow a fresh arm.
        if (stream) await this.usb.clearHalt('in', 1);
        const sent = s.getBigUint64(24, true);
        const counters = [32, 36, 40, 52].map(offset => s.getUint32(offset, true));
        if (counters.some(value => value !== 0)) {
          const [overruns, usb, ownership, timing] = counters;
          throw new Error(`xLOGIC capture lost integrity (overruns ${overruns}, USB errors ${usb}, ownership errors ${ownership}, timing errors ${timing}, bytes sent ${sent})`);
        }
        requireField((stream ? s.getUint32(8, true) === 1 && s.getUint32(44, true) === rate : (s.getBigUint64(16, true) === BigInt(count) && sent === BigInt(count))) &&
          s.getUint32(60, true) === (rate === ESK_PACKED_RATE ? 3 : 0) && (flags & 1) &&
          s.getUint32(48, true) === rate, 'xLOGIC sample counts, format or rate differ');
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

export function captureEsk(device: USBDevice, rate = ESK_RATE, bank: EskBank = 'lower', count = ESK_SAMPLES, trigger?: EskEdgeTrigger): Promise<Uint8Array> {
  requireField(Number.isSafeInteger(count) && count > 0 && count <= ESK_SAMPLES, 'Invalid short capture size');
  if (trigger) {
    requireField(ESK_FINITE_RATES.includes(rate) && Number.isInteger(trigger.channel) && trigger.channel >= 0 &&
      trigger.channel < ESK_CHANNELS && ['rising', 'falling'].includes(trigger.edge), 'Unsupported USB edge trigger');
    trigger.signal.throwIfAborted();
  }
  if (rate !== ESK_PACKED_RATE) return withLogic(device, session => session.capture(rate, count, trigger));
  // The packed producer streams. Retain a bounded prefix and run the normal Stop/retirement checks.
  return withLogic(device, async session => {
    const stop = new AbortController();
    let samples: Uint8Array = new Uint8Array(0);
    await session.stream(stop.signal, block => {
      samples = unpackEsk(block, count);
      stop.abort();
    }, rate, bank);
    return samples;
  });
}

export function recordEskUsb(device: USBDevice, signal: AbortSignal, accept: (bytes: Uint8Array) => void,
    rate = ESK_STREAM_RATE, bank: EskBank = 'lower'): Promise<bigint> {
  return withLogic(device, session => session.stream(signal, accept, rate, bank));
}
