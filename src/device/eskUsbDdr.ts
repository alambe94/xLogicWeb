// SPDX-License-Identifier: GPL-3.0-or-later
import { EskControlRejection, EskUsbSession, requireField, within, withUsbInterface } from './eskUsbSession.js';
import { type DdrTrigger, validDdrEdge } from './eskDdrTrigger.js';
import { ESK_FINITE_RATES } from './eskCapture.js';

const RATE = 500_000_000;
const QUANTUM = 192;
const LOGIC = 2;
const MAGIC = 0x32434c78; // xLC2
const ACQUIRING = 0x100, READY = 0x200, FAILED = 0x400;
const START = 2, STATUS = 3, CANCEL = 5, RELEASE = 6;
const LEASE_TICKS = 60000n;
const capacities = new WeakMap<USBDevice, number>();
const probes = new WeakMap<USBDevice, Promise<number>>();
const triggerCapacities = new WeakMap<USBDevice, number>();
export const usbDdrMaximum = (device?: USBDevice) => device && capacities.get(device);
export function usbDdrTriggerMaximum(device: USBDevice | undefined, rate: number): number | undefined {
  return device && ESK_FINITE_RATES.includes(rate) ? triggerCapacities.get(device) : undefined;
}
export function forgetUsbDdr(device: USBDevice): void { capacities.delete(device); triggerCapacities.delete(device); }

/** A Logic descriptor is transport-specific. Earlier firmware returns zero arena bytes on USB. */
async function observeUsbDdr(describe: (query: Uint8Array) => Promise<DataView>): Promise<number> {
  const query = new Uint8Array(8);
  query[0] = 2;
  let capacity = 0;
  for (let i = 0; i < 32; i++) {
    new DataView(query.buffer).setUint32(4, i, true);
    let row: DataView;
    try { row = await describe(query); }
    catch (err) { if (err instanceof EskControlRejection && err.status === 10) break; throw err; }
    requireField(row.byteLength === 116 && row.getUint32(48) === 0x7845534b && row.getUint8(52) === 1 &&
      row.getUint8(53) === 2 && row.getUint16(56, true) === 68, 'Invalid ESK service descriptor');
    if (row.getUint16(60, true) !== LOGIC || row.getUint16(62, true) !== 0) continue;
    const flags = row.getUint32(64, true), bytes = row.getBigUint64(96, true);
    const finiteAndContinuous = 3, ethernetRateProfile = 64;
    if ((flags & (finiteAndContinuous | ethernetRateProfile)) === finiteAndContinuous &&
        row.getUint32(68, true) === 1 && row.getBigUint64(80, true) === BigInt(RATE) &&
        bytes >= BigInt(QUANTUM) && bytes <= 0xffffffffn) capacity = Number(bytes);
    break;
  }
  return capacity;
}

class DdrSession extends EskUsbSession {
  constructor(device: USBDevice) { super(device, 0, 0x70, LOGIC); }
  async inspect() {
    await this.openConnection();
    const bytes = await observeUsbDdr(query => this.exchange(1, query));
    const capacity = Math.floor(bytes / QUANTUM) * QUANTUM;
    const maximum = capacity && (await this.identity()).firmware >= 0x2c00 ? Math.floor(bytes / 64) * 64 : 0;
    const changed = capacities.get(this.usb) !== capacity || triggerCapacities.get(this.usb) !== maximum;
    capacities.set(this.usb, capacity);
    triggerCapacities.set(this.usb, maximum);
    if (changed && typeof window !== 'undefined') window.dispatchEvent(new Event('esk-usb-ddr'));
    return capacity;
  }
  async capture(count: number, signal: AbortSignal, accept: (bytes: Uint8Array) => Promise<void>, rate: number, trigger?: DdrTrigger) {
    const maximum = await this.inspect();
    const quantum = rate === RATE ? QUANTUM : 64;
    const extent = Math.ceil(count / quantum) * quantum;
    requireField(trigger ? validDdrEdge(trigger) && !!usbDdrTriggerMaximum(this.usb, rate) : rate === RATE, 'Unsupported USB DDR trigger or rate.');
    requireField(Number.isSafeInteger(count) && count > 0 && extent <= (trigger ? usbDdrTriggerMaximum(this.usb, rate)! : maximum),
      'The requested eight-channel capture exceeds the USB DDR capacity.');
    let id = 0n;
    const command = async (op: typeof START | typeof STATUS | typeof CANCEL | typeof RELEASE) => {
      const q = new Uint8Array(40), v = new DataView(q.buffer);
      v.setUint32(0, MAGIC, true);
      v.setUint16(4, 2, true);
      v.setUint16(6, q.length, true);
      v.setUint32(8, op, true);
      v.setBigUint64(16, id, true);
      if (op === START) {
        v.setUint16(12, 1, true);
        v.setUint16(14, 255, true);
        v.setBigUint64(24, BigInt(extent), true);
        v.setUint32(32, rate, true);
        if (trigger) {
          v.setUint8(36, trigger.edge === 'rising' ? 1 : 2);
          v.setUint8(37, trigger.channel);
        }
      }
      const frame = await this.exchange(7,q,LOGIC,this.session);
      const r = new DataView(frame.buffer,frame.byteOffset + 48,frame.byteLength - 48);
      requireField(r.byteLength === 80 && r.getUint32(0,true) === MAGIC && r.getUint16(4,true) === 2 &&
        r.getUint16(6,true) === 80 && r.getUint32(8,true) === op && !r.getUint32(20,true) && !r.getUint32(36,true) &&
        (op === START || r.getBigUint64(24,true) === id), 'Invalid finite USB capture reply.');
      const status = r.getUint32(12,true), flags = r.getUint16(16,true);
      const stateMask = ACQUIRING | READY | FAILED, state = flags & stateMask;
      requireField((flags & ~stateMask) === 5 && [0, ACQUIRING, READY, FAILED].includes(state), 'Invalid USB capture state.');
      if (status === 2 && (op === CANCEL || op === RELEASE)) return {busy: true, ready: false};
      requireField(!status, 'Board rejected finite USB capture (status ' + status + ').');
      if (op === CANCEL || op === RELEASE) requireField(state === 0, 'Board has not retired the capture.');
      else {
        requireField((state === ACQUIRING || state === READY) && r.getUint8(18) === 1 && r.getUint8(19) === 255 &&
          r.getUint32(32,true) === rate && r.getBigUint64(40,true) === BigInt(extent) &&
          r.getBigUint64(48,true) === BigInt(extent) && !r.getBigUint64(56,true) &&
          r.getBigUint64(24,true) > 0n && r.getBigUint64(72,true) > 0n, 'Unexpected eight-channel USB capture geometry.');
        id = r.getBigUint64(24,true);
      }
      return {busy: false, ready: state === READY};
    };
    const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
    signal.throwIfAborted();
    await this.control(2, LEASE_TICKS);
    let nextRenew = performance.now() + 1000;
    const renew = async () => {
      if (performance.now() >= nextRenew) {
        await this.control(3, LEASE_TICKS);
        nextRenew = performance.now() + 1000;
      }
    };
    let complete = false;
    try {
      await command(START);
      trigger?.onArmed();
      let result = await command(STATUS);
      const deadline = performance.now() + 10000 + 1000 * extent / rate;
      while (!result.ready) {
        signal.throwIfAborted();
        requireField(trigger || performance.now() < deadline, 'USB DDR acquisition timed out.');
        await sleep(trigger ? 40 : 10);
        await renew();
        result = await command(STATUS);
      }
      // A disk write can outlast the board's five-second common connection timeout.
      // Only the heartbeat uses EP0 while the bulk endpoint is draining.
      let heartbeatError: unknown, heartbeat: Promise<void> | undefined;
      const timer = setInterval(() => {
        if (!heartbeat && !heartbeatError) heartbeat = this.control(3, LEASE_TICKS).then(() => {},
          error => { heartbeatError = error; }).finally(() => { heartbeat = undefined; });
      }, 1000);
      try {
        for (let offset = 0; offset < extent;) {
          if (heartbeatError) throw heartbeatError;
          signal.throwIfAborted();
          const length = Math.min(1024 * 1024, extent - offset);
          const read = await within(this.usb.transferIn(1, length), 4000);
          requireField(read.status === 'ok' && read.data?.byteLength === length, 'Incomplete USB DDR download.');
          signal.throwIfAborted();
          const keep = Math.min(length, Math.max(0, count - offset));
          if (keep) await accept(new Uint8Array(read.data.buffer, read.data.byteOffset, keep));
          offset += length;
        }
      } finally {
        clearInterval(timer);
        await heartbeat;
      }
      if (heartbeatError) throw heartbeatError;
      signal.throwIfAborted();
      complete = true;
    } finally {
      try {
        if (id) {
          const deadline = performance.now() + 3000;
          while ((await command(complete ? RELEASE : CANCEL)).busy) {
            requireField(performance.now() < deadline, 'Board did not release USB DDR capture.');
            await sleep(20);
          }
        }
      } finally { await this.release(); }
    }
  }
}

/** The capacity belongs to Logic MI0. Management MI2 can describe the same service with zero capacity. */
export function inspectUsbDdr(device: USBDevice): Promise<number> {
  const pending = probes.get(device);
  if (pending) return pending;
  const known = capacities.get(device);
  if (known !== undefined) return Promise.resolve(known);
  const session = new DdrSession(device);
  const probe = withUsbInterface(device, session, () => session.inspect()).finally(() => probes.delete(device));
  probes.set(device, probe);
  return probe;
}

export async function receiveUsbDdr(device: USBDevice, count: number, signal: AbortSignal,
    accept: (block: Uint8Array) => Promise<void>, rate = RATE, trigger?: DdrTrigger) {
  const session = new DdrSession(device);
  await withUsbInterface(device, session, alt => {
    requireField(alt.endpoints.some(ep => ep.direction === 'in' && ep.endpointNumber === 1 && ep.type === 'bulk'), 'Missing USB Logic data endpoint.');
    return session.capture(count, signal, accept, rate, trigger);
  });
}
