// SPDX-License-Identifier: GPL-3.0-or-later
import { eskBusInterface, onControlPipe, requireField, withUsbInterface, within } from './eskUsbSession.js';
import { hexBytes } from './eskBridgeFrames.js';
function words(...values: number[]): ArrayBuffer {
  const data = new ArrayBuffer(values.length * 4), view = new DataView(data);
  values.forEach((value, i) => view.setUint32(i * 4, value, true));
  return data;
}
export type CanAction = 'loopback' | 'send' | 'listen';
export async function canTransaction(device: USBDevice, action: CanAction, nominal: number, id: number, data: Uint8Array) {
  requireField([125000, 250000, 500000, 1000000].includes(nominal), 'Unsupported nominal CAN bitrate.');
  requireField(Number.isInteger(id) && id >= 0 && id <= 0x7ff && data.length <= 8, 'Use a standard 11-bit CAN ID and up to eight data bytes.');
  const number = eskBusInterface(device, 'CAN');
  const native = (intf: number) => ({ intf, close: async () => { } });
  return withUsbInterface(device, native(number), async (alt) => withUsbInterface(device, native(0), async () => {
    const ep = (dir: USBDirection) => alt.endpoints.find(e => e.type === 'bulk' && e.direction === dir)?.endpointNumber;
    const rx = ep('in'), tx = ep('out');
    requireField(rx && tx, 'Missing CAN endpoints.');
    const setup = (request: number, global: boolean): USBControlTransferParameters => ({
      requestType: 'vendor', recipient: 'interface', index: global ? number : 0, value: global ? 1 : 0, request,
    });
    const out = async (request: number, payload: ArrayBuffer, global = false) => {
      const r = await onControlPipe(device, () => within(device.controlTransferOut(setup(request, global), payload), 1000));
      requireField(r.status === 'ok' && r.bytesWritten === payload.byteLength, 'CAN control request failed.');
    };
    const input = async (request: number, length: number, global = false) => {
      const r = await onControlPipe(device, () => within(device.controlTransferIn(setup(request, global), length), 1000));
      requireField(r.status === 'ok' && r.data?.byteLength === length, 'CAN control reply failed.');
      return r.data;
    };
    await out(0, words(0xbeef), true);
    requireField((await input(5, 12, true)).getUint32(0, true) === 0, 'Unexpected CAN channel count.');
    const caps = await input(4, 40);
    requireField(caps.getUint32(4, true) === 80000000, 'Unsupported CAN clock.');
    requireField((await input(14, 12)).getUint32(0, true) === 4, 'CAN controller is busy.');
    await out(1, words(7, 6, 2, 1, 5000000 / nominal));
    const frame = new Uint8Array(20), v = new DataView(frame.buffer);
    v.setUint32(0, 1, true);
    v.setUint32(4, id, true);
    frame[8] = data.length;
    frame.set(data, 12);
    try {
      await out(2, words(1, action === 'loopback' ? 2 : action === 'listen' ? 1 : 0));
      if (action !== 'listen') {
        const sent = await within(device.transferOut(tx, frame), 1500);
        requireField(sent.status === 'ok' && sent.bytesWritten === 20, 'CAN delivery uncertain.');
      }
      let echo = false, received = false;
      const deadline = performance.now() + 2000;
      while (performance.now() < deadline) {
        const result = await within(device.transferIn(rx, 20), Math.max(1, deadline - performance.now()));
        const r = result.data;
        requireField(result.status === 'ok' && r?.byteLength === 20 && r.getUint8(9) === 0, 'Invalid CAN record.');
        const bytes = new Uint8Array(r.buffer, r.byteOffset, 20);
        if (r.getUint32(0, true) === 0xffffffff) {
          if (action === 'listen') {
            const identifier = r.getUint32(4, true), length = Math.min(bytes[8], 8);
            requireField(bytes[8] <= 15 && bytes[10] === 0 && bytes[11] === 0, 'Invalid classical CAN record.');
            requireField(!(identifier & 0x20000000), 'CAN controller reported an error frame.');
            const extended = !!(identifier & 0x80000000);
            const arb = identifier & (extended ? 0x1fffffff : 0x7ff);
            const prefix = (extended ? 'Extended RX 0x' : 'RX 0x') + arb.toString(16).toUpperCase();
            return identifier & 0x40000000 ? prefix + ' · RTR ' + length : prefix + '  ' + hexBytes(bytes.subarray(12, 12 + length));
          }
          if (bytes.subarray(4).every((b, i) => b === frame[i + 4]))
            received = true;
        }
        else {
          requireField(bytes.every((b, i) => b === frame[i]), 'CAN completion echo mismatch.');
          echo = true;
        }
        if (echo && (action === 'send' || received))
          return action === 'send' ? 'Transmit confirmed' : 'Loopback RX and transmit echo matched';
      }
      throw Error('CAN frame deadline exceeded.');
    }
    finally {
      await out(2, words(0, 0));
    }
  }));
}
