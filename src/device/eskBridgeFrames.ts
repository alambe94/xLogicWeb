// SPDX-License-Identifier: GPL-3.0-or-later
import { requireField, within } from './eskUsbSession.js';
export interface BridgeCommand {
  op: number;
  payload: Uint8Array;
  reply: number;
}
export function parseHex(text: string): Uint8Array {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  requireField(parts.every(p => /^(?:[a-f\d]{2})+$/i.test(p)), 'Enter complete hexadecimal bytes.');
  return Uint8Array.from(parts.join('').match(/../g) ?? [], pair => parseInt(pair, 16));
}
export function hexBytes(data: Uint8Array): string {
  return Array.from(data, b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}
export function i2cCommand(address: number, write: Uint8Array, count: number): BridgeCommand {
  requireField(Number.isInteger(address) && address >= 8 && address <= 0x77, 'Address must be 0x08–0x77.');
  requireField(Number.isInteger(count) && count >= 0 && count <= 1024 && (count || write.length), 'Invalid I²C read length or empty write.');
  const combined = count > 0 && write.length > 0;
  const prefix = combined ? 6 : 4;
  requireField(write.length <= 1024 - prefix, 'I²C transaction exceeds the USB payload limit.');
  const payload = new Uint8Array(prefix + write.length);
  const view = new DataView(payload.buffer);
  payload[0] = address;
  view.setUint16(2, write.length || count, true);
  if (combined)
    view.setUint16(4, count, true);
  payload.set(write, prefix);
  return { op: combined ? 3 : count ? 2 : 1, payload, reply: count };
}
export function spiCommands(mode: number, hz: number, bytes: Uint8Array): BridgeCommand[] {
  requireField(Number.isInteger(mode) && mode >= 0 && mode <= 3, 'Invalid SPI mode.');
  requireField(Number.isInteger(hz) && hz >= 100000 && hz <= 24000000, 'SPI clock must be 100 kHz–24 MHz.');
  requireField(bytes.length > 0 && bytes.length <= 1020, 'Enter 1–1,020 SPI bytes.');
  const speed = new Uint8Array(4), payload = new Uint8Array(4 + bytes.length);
  new DataView(speed.buffer).setUint32(0, hz, true);
  new DataView(payload.buffer).setUint16(2, bytes.length, true);
  payload.set(bytes, 4);
  return [{ op: 4, payload: Uint8Array.of(mode >> 1, mode & 1), reply: 0 },
    { op: 5, payload: speed, reply: 0 }, { op: 1, payload, reply: bytes.length }];
}
const routes = { I2C: { magic: 'xEI2', channel: 1 }, SPI: { magic: 'xESP', channel: 2 },
  GPIO: { magic: 'xEGP', channel: 6 }, PWM: { magic: 'xEGP', channel: 7 } } as const;
export async function bulkCommand(device: USBDevice, input: number, output: number, service: keyof typeof routes, connection: number, boot: bigint, session: bigint, sequence: number, command: BridgeCommand): Promise<Uint8Array> {
  const request = new Uint8Array(40 + command.payload.length);
  const h = new DataView(request.buffer);
  request.set(new TextEncoder().encode(routes[service].magic));
  request[4] = 1;
  h.setUint16(6, connection, true);
  h.setBigUint64(8, boot, true);
  h.setBigUint64(16, session, true);
  h.setBigUint64(24, BigInt(sequence), true);
  request[32] = routes[service].channel;
  request[33] = command.op;
  h.setUint16(34, command.payload.length, true);
  h.setUint32(36, sequence, true);
  request.set(command.payload, 40);
  const uncertain = 'USB transaction delivery uncertain. Inspect the target before repeating.';
  const onFailure = (cause: unknown): never => { throw new Error(uncertain, { cause }); };
  const sent = await within(device.transferOut(output, request), 1000).catch(onFailure);
  requireField(sent.status === 'ok' && sent.bytesWritten === request.length, uncertain);
  const received = await within(device.transferIn(input, routes[service].magic === 'xEGP' ? 64 : 1068), 1000).catch(onFailure);
  const r = received.data;
  requireField(received.status === 'ok' && r && r.byteLength >= 32 &&
    request.subarray(0, 32).every((byte, i) => i === 5 || r.getUint8(i) === byte), uncertain);
  const envelope = r.getUint8(5);
  if (envelope) {
    requireField(r.byteLength === 32 && envelope <= 3, uncertain);
    throw Error(['', 'Invalid bridge request', 'Bridge ownership changed', 'Bridge is busy'][envelope]);
  }
  requireField(r.byteLength >= 44 && r.getUint8(32) === request[32] && r.getUint32(36, true) === sequence &&
    r.getUint16(34, true) === r.byteLength - 44, uncertain);
  const status = r.getUint32(40, true);
  requireField(r.getUint8(33) === (status ? 1 : 0), uncertain);
  if (status === 0xf4001)
    throw Error('I²C NACK: target did not acknowledge.');
  if (status === 0x4005)
    throw Error('Bus busy.');
  if (status)
    throw Error(service + ' transaction rejected (0x' + status.toString(16) + ').');
  requireField(r.byteLength === 44 + command.reply, uncertain);
  return new Uint8Array(r.buffer, r.byteOffset + 44, command.reply);
}
