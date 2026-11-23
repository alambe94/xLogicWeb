// SPDX-License-Identifier: GPL-3.0-or-later
import { bulkCommand, type BridgeCommand } from './eskBridgeFrames.js';
import type { BoardStatus } from './eskPairedBoard.js';
import { HomeSession } from './eskUsbHome.js';
import { eskBusInterface, requireField, withUsbInterface } from './eskUsbSession.js';

export type OutputBus = 'GPIO' | 'PWM';
function words(...values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((v, i) => view.setUint32(i * 4, v, true));
  return bytes;
}
export function gpioCommand(configure: boolean, mask: number, high: number): BridgeCommand {
  requireField(Number.isInteger(mask) && mask >= 1 && mask <= 127 &&
    Number.isInteger(high) && high >= 0 && high <= mask && !(high & ~mask), 'Select outputs 0–6. High bits must be selected outputs.');
  return {op: configure ? 1 : 2, payload: words(mask, high), reply: 0};
}
export function pwmCommand(period: number, mask: number, a: number, b: number): BridgeCommand {
  const duties = [a, b].map(percent => Math.round(percent * 10));
  requireField(Number.isInteger(period) && period > 0 && period <= 0xffffffff && [1, 2, 3].includes(mask) &&
    duties.every((value, i) => value >= 0 && value <= 1000 && value / 10 === [a, b][i]), 'Enter a period in nanoseconds and duties of 0–100% in 0.1% steps.');
  return {op: 1, payload: words(period, ...duties, mask), reply: 0};
}
export function pwmTiming(bytes: Uint8Array): string {
  requireField(bytes.length === 20, 'Invalid timer record.');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const [clock, divider, period, a, b] = [0, 4, 8, 12, 16].map(i => v.getUint32(i, true)) as [number, number, number, number, number];
  requireField(clock && divider && period >= 2 && a <= period && b <= period, 'Invalid realized PWM timing.');
  return (clock / divider / period).toLocaleString(undefined, {maximumFractionDigits: 3}) + ' Hz · A ' +
    (100 * a / period).toFixed(2) + '% · B ' + (100 * b / period).toFixed(2) + '%';
}

export interface OutputHandle {
  send(command: BridgeCommand): Promise<Uint8Array>;
  close(): Promise<void>;
  done: Promise<void>;
}

class OutputSession extends HomeSession {
  async hold(alt: USBAlternateInterface, expected: BoardStatus, bus: OutputBus, ready: (send: OutputHandle['send']) => void,
      stopped: Promise<void>, stop: () => void): Promise<void> {
    await this.openConnection();
    const id = await this.identity();
    requireField(id.deviceId === expected.deviceId && id.boot === expected.boot, 'Board changed. Refresh Home.');
    const ep = (dir: USBDirection) => alt.endpoints.find(e => e.type === 'bulk' && e.direction === dir)?.endpointNumber;
    const input = ep('in'), output = ep('out');
    requireField(input && output, 'Missing GPIO/PWM endpoints.');
    await this.control(2, 10000n);
    let seq = 0, tail = Promise.resolve(), failure: unknown, closing = false;
    const schedule = <T>(work: () => Promise<T>) => {
      const operation = tail.then(() => {
        if (closing || failure) throw Error('Output lease ended.');
        return work();
      });
      tail = operation.then(() => {}, e => { failure ??= e; stop(); });
      return operation;
    };
    let renewing = false;
    const timer = setInterval(() => {
      if (renewing || closing) return;
      renewing = true;
      void schedule(() => this.control(3, 10000n)).finally(() => { renewing = false; }).catch(() => {});
    }, 1000);
    try {
      ready(cmd => schedule(() => bulkCommand(this.usb, input, output, bus, this.connection, this.boot, this.session, ++seq, cmd)));
      await stopped;
    } finally {
      closing = true;
      clearInterval(timer);
      await tail;
      await this.release();
    }
    if (failure) throw failure;
  }
}

export async function openOutputs(device: USBDevice, expected: BoardStatus, bus: OutputBus, instance: number): Promise<OutputHandle> {
  requireField(expected.features.some(f => f.name === bus && f.instance === instance && f.enabled), 'Output service unavailable.');
  const session = new OutputSession(device, eskBusInterface(device, 'GPIO/PWM'), 0x60, bus === 'GPIO' ? 7 : 12, instance);
  let stop!: () => void;
  const stopped = new Promise<void>(resolve => { stop = resolve; });
  let ready!: (send: OutputHandle['send']) => void, reject!: (reason: unknown) => void;
  const opening = new Promise<OutputHandle['send']>((resolve, fail) => { ready = resolve; reject = fail; });
  const done = withUsbInterface(device, session, alt => session.hold(alt, expected, bus, ready, stopped, stop));
  void done.catch(reject);
  const send = await opening;
  return {send, done, close: () => { stop(); return done; }};
}
