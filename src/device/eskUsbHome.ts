// SPDX-License-Identifier: GPL-3.0-or-later
import { eskBusInterface, EskUsbSession, requireField, withUsbInterface } from './eskUsbSession.js';
import { bulkCommand, i2cCommand, type BridgeCommand } from './eskBridgeFrames.js';
import type { BoardStatus } from './eskPairedBoard.js';
import { restartBoard } from './eskRestart.js';
import { readBoardPolicy, saveBoardName, type NetworkManagement } from './eskBoardName.js';

const names = ['', 'Device', 'Logic', 'DAP', 'UART', 'I2C', 'SPI', 'GPIO', 'USB analyzer',
  'BLE analyzer', 'Power analyzer', 'Firmware update', 'PWM', 'CAN', 'LIN', 'RS485', 'QSPI'];
const owners = ['Unknown', 'Unclaimed', 'Pending', 'Claimed', 'Retiring', 'Quarantined', 'Faulted'];

export class HomeSession extends EskUsbSession {
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

  async verifyIdentity(expected: BoardStatus) {
    const identity = await this.identity();
    requireField(identity.boot === expected.boot && identity.deviceId === expected.deviceId,
      'Board identity or boot changed. Refresh Home.');
  }

  async boardName(expected: BoardStatus, name?: string) {
    await this.verifyIdentity(expected);
    requireField(expected.firmware >= 0x2800, 'This firmware needs an update to rename the board.');
    const payload = (r: DataView) => new DataView(r.buffer, r.byteOffset + 48, r.byteLength - 48);
    const port: NetworkManagement = {
      service: async command => payload(await this.exchange(7, command, 1, this.session)),
      status: async () => payload(await this.exchange(9, new Uint8Array())),
    };
    await this.control(2, 30000n);
    try {
      if (name === undefined) return {name: (await readBoardPolicy(port)).name};
      return {name, advertised: await saveBoardName(port, name)};
    } finally { await this.release(); }
  }

  async restart(expected: BoardStatus) {
    await this.verifyIdentity(expected);
    await this.control(2, 10000n);
    // Closing the connection retires DEVICE/0. An accepted restart owns the
    // exclusion until reset and cannot be reaped like a regular grant.
    await restartBoard(async command => {
      const reply = await this.exchange(7, command, 1, this.session);
      return new Uint8Array(reply.buffer, reply.byteOffset + 48, reply.byteLength - 48);
    });
  }

  async transactions(intf: USBAlternateInterface, expected: BoardStatus, service: 'I2C' | 'SPI', commands: BridgeCommand[]) {
    await this.verifyIdentity(expected);
    const ep = (dir: USBDirection) => intf.endpoints.find(e => e.type === 'bulk' && e.direction === dir)?.endpointNumber;
    const input = ep('in'), output = ep('out');
    requireField(input && output, 'Missing bridge USB endpoints.');
    await this.control(2);
    try {
      let result: Uint8Array = new Uint8Array();
      for (const [index, command] of commands.entries()) {
        result = await bulkCommand(this.usb,input,output,service,this.connection,this.boot,this.session,index+1,command);
      }
      return result;
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

export async function restartUsbBoard(device: USBDevice, expected: BoardStatus): Promise<void> {
  const session = new HomeSession(device, 2, 0x60, 1);
  let accepted = false;
  try {
    await withUsbInterface(device, session, async () => {
      await session.openConnection();
      await session.restart(expected);
      accepted = true;
    });
  } catch (error) {
    // A disconnect after the verified EXECUTE reply can race USB cleanup.
    if (!accepted) throw error;
  }
}

export function usbBoardName(device: USBDevice, expected: BoardStatus, name?: string): Promise<{name: string; advertised?: string}> {
  const session = new HomeSession(device, 2, 0x60, 1);
  return withUsbInterface(device, session, async () => { await session.openConnection(); return session.boardName(expected, name); });
}

export function runUsbBridge(device: USBDevice, expected: BoardStatus, service: 'I2C' | 'SPI', commands: BridgeCommand[]): Promise<Uint8Array> {
  const intf = service === 'I2C' ? 1 : eskBusInterface(device, 'SPI');
  const session = new HomeSession(device,intf,0x60,service === 'I2C' ? 5 : 6);
  return withUsbInterface(device,session,async alt => {
    await session.openConnection();
    return session.transactions(alt,expected,service,commands);
  });
}
export async function readUsbBoardId(device: USBDevice, expected: BoardStatus): Promise<string> {
  return decodeBoardId(await runUsbBridge(device,expected,'I2C',[i2cCommand(0x51,Uint8Array.of(0,0),128)]));
}
