// SPDX-License-Identifier: GPL-3.0-or-later
import { requireField } from './eskUsbSession.js';
interface Settings {
  baudRate: number;
  dataBits: number;
  parity: 'none' | 'odd' | 'even';
  stopBits: number;
}
interface Port {
  open(options: Settings): Promise<void>;
  close(): Promise<void>;
  setSignals(options: {
    dataTerminalReady: boolean;
  }): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}
interface Serial {
  requestPort(options: {
    filters: {
      usbVendorId: number;
      usbProductId: number;
    }[];
  }): Promise<Port>;
}
export const eskSerial = (navigator as Navigator & {
  serial?: Serial;
}).serial;
export class BridgeUart {
  private constructor(private readonly port: Port, private readonly reader: ReadableStreamDefaultReader<Uint8Array>, private readonly writer: WritableStreamDefaultWriter<Uint8Array>) { }
  static async open(settings: Settings): Promise<BridgeUart> {
    requireField(eskSerial, 'This browser does not support Web Serial.');
    requireField(Number.isInteger(settings.baudRate) && settings.baudRate >= 9600 && settings.baudRate <= 115200 &&
      [7, 8].includes(settings.dataBits) && [1, 2].includes(settings.stopBits) && ['none', 'odd', 'even'].includes(settings.parity), 'Unsupported UART settings.');
    const port = await eskSerial.requestPort({ filters: [{ usbVendorId: 0x1209, usbProductId: 3 }] });
    await port.open(settings);
    try {
      await port.setSignals({ dataTerminalReady: true });
      requireField(port.readable && port.writable, 'UART streams unavailable.');
      return new BridgeUart(port, port.readable.getReader(), port.writable.getWriter());
    }
    catch (error) {
      await port.close();
      throw error;
    }
  }
  async receive(show: (bytes: Uint8Array) => void) {
    for (;;) {
      const { done, value } = await this.reader.read();
      if (done)
        break;
      show(value);
    }
  }
  async send(bytes: Uint8Array) { await this.writer.write(bytes); }
  async close() {
    try {
      await this.reader.cancel();
    }
    finally {
      this.reader.releaseLock();
      this.writer.releaseLock();
      try {
        await this.port.setSignals({ dataTerminalReady: false });
      }
      finally {
        await this.port.close();
      }
    }
  }
}
