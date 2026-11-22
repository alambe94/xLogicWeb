// SPDX-License-Identifier: GPL-3.0-or-later
import { EskUsbSession, requireField, withUsbInterface, within } from './eskUsbSession.js';
import type { BoardStatus } from './eskPairedBoard.js';

const names = ['', 'Device', 'Logic', 'DAP', 'UART', 'I2C', 'SPI', 'GPIO', 'USB analyzer',
  'BLE analyzer', 'Power analyzer', 'Firmware update', 'PWM', 'CAN', 'LIN', 'RS485', 'QSPI'];
const owners = ['Unknown', 'Unclaimed', 'Pending', 'Claimed', 'Retiring', 'Quarantined', 'Faulted'];

class HomeSession extends EskUsbSession {
  async identity() {
    const query = new Uint8Array(8);
    query[0] = 1; // DEVICE/0 descriptor
    const r = await this.exchange(1, query);
    requireField(r.byteLength === 100 && r.getUint32(48) === 0x7845534b && r.getUint8(52) === 1 &&
      r.getUint8(53) === 1 && r.getUint16(54, true) === 0 && r.getUint16(56, true) === 52 &&
      r.getUint16(58, true) === 0 && r.getBigUint64(76, true) === this.boot &&
      (r.getUint32(92, true) & 1) && r.getUint32(96, true), 'Invalid ESK device identity');
    const id = new Uint8Array(r.buffer, r.byteOffset + 60, 16);
    requireField(id.some(b => b !== 0), 'Empty ESK device ID');
    return {deviceId: Array.from(id, b => b.toString(16).padStart(2, '0')).join(''),
      boot: this.boot.toString(), firmware: r.getUint32(84, true)};
  }

  async status(): Promise<BoardStatus> {
    const identity = await this.identity();
    const features: BoardStatus['features'] = [];
    let snapshot = 0n, observed = 0n, timebase = 0, flags = 0, total = 0, lastKey = 0;
    do {
      const query = new Uint8Array(12);
      const v = new DataView(query.buffer);
      v.setBigUint64(0, snapshot, true);
      v.setUint16(8, features.length, true);
      const r = await this.exchange(8, query);
      requireField(r.byteLength >= 80, 'Short ESK feature page');
      const start = r.getUint16(54, true), size = r.getUint16(52, true), count = r.getUint8(50);
      const id = r.getBigUint64(56, true), ticks = r.getBigUint64(64, true), clock = r.getUint32(72, true);
      requireField(r.getUint8(48) === 1 && r.getUint8(49) === 8 && r.getUint8(51) <= 1 && id && clock &&
        size > start && size <= 32 && start === features.length && count === Math.min(12, size - start) &&
        r.byteLength === 80 + count * 8 && !r.getUint32(76, true) &&
        (!start || (size === total && id === snapshot && ticks === observed && clock === timebase && r.getUint8(51) === flags)),
        'Invalid ESK feature snapshot');
      total = size; snapshot = id; observed = ticks; timebase = clock; flags = r.getUint8(51);
      for (let i = 80; i < r.byteLength; i += 8) {
        const kind = r.getUint16(i, true), instance = r.getUint8(i + 2), caps = r.getUint8(i + 3);
        const name = names[kind], ownership = owners[r.getUint8(i + 4)];
        const key = kind * 256 + instance;
        requireField(name && ownership && key > lastKey && caps <= 7, 'Invalid ESK feature');
        features.push({name, instance, enabled: !!(caps & 2), ownership});
        lastKey = key;
      }
    } while (features.length < total);
    return {...identity, features};
  }

  async boardId(intf: USBAlternateInterface, expected: BoardStatus) {
    const identity = await this.identity();
    requireField(identity.boot === expected.boot && identity.deviceId === expected.deviceId,
      'Board identity or boot changed. Refresh Home before reading.');
    const ep = (dir: USBDirection) => intf.endpoints.find(e => e.type === 'bulk' && e.direction === dir)?.endpointNumber;
    const input = ep('in'), output = ep('out');
    requireField(input && output, 'Missing I²C USB endpoints');
    await this.control(2);
    try {
      // One combined transfer: the two outbound bytes select EEPROM offset zero.
      const request = new Uint8Array(48);
      const h = new DataView(request.buffer);
      request.set([0x78, 0x45, 0x49, 0x32, 1]); // xEI2
      h.setUint16(6, this.connection, true);
      h.setBigUint64(8, this.boot, true);
      h.setBigUint64(16, this.session, true);
      h.setBigUint64(24, 1n, true);
      request.set([1, 3, 8, 0, 1, 0, 0, 0, 0x51, 0, 2, 0, 128, 0, 0, 0], 32);
      const sent = await within(this.usb.transferOut(output, request), 1000);
      requireField(sent.status === 'ok' && sent.bytesWritten === request.length, 'I²C request delivery uncertain');
      const reply = await within(this.usb.transferIn(input, 1068), 1000);
      const r = reply.data;
      requireField(reply.status === 'ok' && r && r.byteLength >= 32 &&
        request.subarray(0, 32).every((byte, i) => i === 5 || r.getUint8(i) === byte), 'Mismatched I²C reply');
      requireField(r.getUint8(5) === 0 && r.byteLength >= 44 && r.getUint8(32) === 1 &&
        r.getUint32(36, true) === 1 && r.getUint8(33) === 0 && r.getUint32(40, true) === 0, 'Board-ID read failed');
      requireField(r.byteLength === 172 && r.getUint16(34, true) === 128, 'Incomplete board-ID read');
      return decodeBoardId(new Uint8Array(r.buffer, r.byteOffset + 44, 128));
    } finally { await this.release(); }
  }
}

export function decodeBoardId(bytes: Uint8Array): string {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  requireField(bytes.length >= 7 && v.getUint32(0, true) === 0xee3355aa && bytes[4] === 1, 'Unknown TI board-ID header');
  const end = Math.min(bytes.length, 7 + v.getUint16(5, true));
  for (let at = 7; at + 3 <= end;) {
    const kind = bytes[at], length = v.getUint16(at + 1, true);
    at += 3;
    if (kind === 0xfe || at + length > end) break;
    if (kind === 0x10 && length >= 18) {
      const ascii = (offset: number, n: number) => new TextDecoder().decode(bytes.subarray(offset, offset + n)).split('\0')[0]!.trim();
      const name = ascii(at, 16), revision = ascii(at + 16, 2);
      requireField(/^[ -~]+$/.test(name) && /^[ -~]*$/.test(revision), 'Invalid TI board information');
      return [name, revision].filter(Boolean).join(' · ');
    }
    at += length;
  }
  throw new Error('TI board information missing from EEPROM header');
}

export function readUsbBoardStatus(device: USBDevice): Promise<BoardStatus> {
  const session = new HomeSession(device, 2, 0x60, 0);
  return withUsbInterface(device, session, async () => { await session.openConnection(); return session.status(); });
}

export function readUsbBoardId(device: USBDevice, expected: BoardStatus): Promise<string> {
  const session = new HomeSession(device, 1, 0x60, 5);
  return withUsbInterface(device, session, async intf => { await session.openConnection(); return session.boardId(intf, expected); });
}
