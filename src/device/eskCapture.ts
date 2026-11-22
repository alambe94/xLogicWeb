// SPDX-License-Identifier: GPL-3.0-or-later
/** Finite raw8 capture on ESK's existing scoped xLOGIC USB interface. */
export const ESK_SAMPLES = 65_536;
export const ESK_RATE = 333_333_333;
export const ESK_STREAM_RATE = 41_666_666;
const streamReadBytes = 4 * 1024 * 1024;
const LOGIC = 2;
const USB_INTERFACE = 0;
const ABI_MAGIC = 0x584c4f47;
const CONTROL_MAGIC = new TextEncoder().encode('xESKCTRL');
const SCOPED_MAGIC = new TextEncoder().encode('xELG');

export function requestEskDevice(): Promise<USBDevice> {
  return navigator.usb.requestDevice({ filters: [{ vendorId: 0x1209, productId: 0x0003 }] });
}

function requireField(value: unknown, detail: string): asserts value {
  if (!value) throw new Error(detail);
}
function abi(view: DataView, length: number): void {
  requireField(view.byteLength === length && view.getUint32(0, true) === ABI_MAGIC &&
    view.getUint16(4, true) === 3 && view.getUint16(6, true) === length, 'Unexpected xLOGIC USB descriptor');
}
function words(...values: bigint[]): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(values.length * 8));
  values.forEach((value, index) => view.setBigUint64(index * 8, value, true));
  return view.buffer;
}
const delay = () => new Promise<void>(resolve => setTimeout(resolve, 2));

async function within<T>(operation: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('ESK USB transfer timed out')), ms);
    })]);
  } finally { clearTimeout(timer); }
}

class LogicSession {
  private connection = 0;
  private boot = 0n;
  private session = 0n;
  private sequence = 0n;
  private operation = 0n;
  constructor(private readonly usb: USBDevice) {}

  private setup(request: number, value = this.connection): USBControlTransferParameters {
    return { requestType: 'vendor', recipient: 'interface', request, value, index: USB_INTERFACE };
  }
  private async input(request: number, length: number, value = this.connection): Promise<DataView> {
    const r = await within(this.usb.controlTransferIn(this.setup(request, value), length), 1000);
    requireField(r.status === 'ok' && r.data?.byteLength === length, 'Short or failed xLOGIC control read');
    return r.data;
  }
  private async output(request: number, data: ArrayBuffer): Promise<void> {
    const r = await within(this.usb.controlTransferOut(this.setup(request), data), 1000);
    requireField(r.status === 'ok' && r.bytesWritten === data.byteLength, 'Short or failed xLOGIC control write');
  }
  private async fetchControl(): Promise<DataView> {
    const end = performance.now() + 500;
    do {
      const r = await within(this.usb.controlTransferIn(this.setup(0x72), 176), 500);
      if (r.status === 'stall') { await delay(); continue; }
      requireField(r.status === 'ok' && r.data && r.data.byteLength >= 48, 'Invalid ESK control response');
      return r.data;
    } while (performance.now() < end);
    throw new Error('ESK control reply deadline expired');
  }
  private async control(opcode: 2 | 3 | 4 | 5 | 6): Promise<number> {
    const claiming = opcode === 2;
    const request = new ArrayBuffer(claiming ? 64 : opcode === 3 ? 56 : 48);
    const bytes = new Uint8Array(request);
    const v = new DataView(request);
    bytes.set(CONTROL_MAGIC);
    bytes.set([2, 1, opcode], 8);
    v.setUint16(12, bytes.length, true);
    v.setBigUint64(16, ++this.sequence, true);
    v.setBigUint64(24, this.boot, true);
    v.setBigUint64(32, this.session, true);
    v.setUint16(40, LOGIC, true);
    if (claiming) {
      bytes[48] = 1; // deadline lease, 1,000 ticks on ESK's millisecond timebase
      v.setBigUint64(56, 1000n, true);
    }
    if (opcode === 3) v.setBigUint64(48, 1000n, true);
    await this.output(0x71, request);
    const r = await this.fetchControl();
    const accepted = r.getUint8(11) === 0;
    requireField(CONTROL_MAGIC.every((b, i) => r.getUint8(i) === b) && r.getUint8(8) === 2 &&
      r.getUint8(9) === 2 && r.getUint8(10) === opcode && r.getUint8(11) <= 10 &&
      r.getUint16(12, true) === r.byteLength && r.getUint16(14, true) === 0 &&
      r.getBigUint64(16, true) === this.sequence && r.getBigUint64(24, true) === this.boot &&
      r.getUint16(40, true) === LOGIC && r.getUint16(42, true) === 0 && r.getUint32(44, true) === 0 &&
      r.byteLength === (accepted && opcode !== 6 ? 100 : 48), 'Mismatched ESK control reply');
    const sid = r.getBigUint64(32, true);
    requireField(claiming ? ((sid !== 0n) === accepted) : sid === this.session, 'Mismatched ESK session');
    await this.output(0x73, words(this.boot, this.sequence));
    requireField(accepted, 'ESK rejected control request ' + opcode + ' (status ' + r.getUint8(11) + ')');
    if (opcode === 6) return 0;
    requireField(r.getUint32(48, false) === 0x7845534b && r.getUint8(52) === 1 && r.getUint8(53) === 5 &&
      r.getUint16(54, true) === 0 && r.getUint16(56, true) === 52 && r.getUint16(58, true) === 0 &&
      r.getBigUint64(60, true) === this.boot && r.getBigUint64(68, true) === sid &&
      r.getUint16(84, true) === LOGIC && r.getUint16(86, true) === 0 && r.getUint32(88, true) === 1 &&
      r.getUint8(92) === 1 && r.getUint8(93) === 1 && r.getUint8(95) === 1,
      'Unexpected LOGIC/0 session binding');
    const flags = r.getUint32(96, true);
    requireField(r.getUint8(94) === (opcode <= 3 ? 1 : 3) && (opcode <= 3 ? flags === 0 : flags <= 1),
      'Unexpected ESK session state');
    this.session = sid;
    return flags;
  }
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
  private async configure(stream: boolean): Promise<void> {
    const caps = await this.input(0x60, 56, 0);
    abi(caps, 56);
    const flags = caps.getUint32(32, true);
    const uniformMax = caps.getUint32(36, true);
    const supported = stream ? (flags & 4) && !(flags & 512) && (!uniformMax || uniformMax >= ESK_STREAM_RATE) :
      caps.getUint32(12, true) >= ESK_SAMPLES && caps.getUint32(20, true) >= ESK_SAMPLES;
    requireField(supported && caps.getUint32(8, true) === 0 && caps.getUint32(24, true) === ESK_RATE &&
      caps.getUint32(28, true) === 8 && (flags & 256), 'ESK firmware does not support the requested raw8 profile');
    const header = await this.input(0x70, 24, 0);
    requireField(header.getUint16(0, true) === 1 && header.getUint16(2, true) && header.getUint32(4, true) === 0 &&
      header.getBigUint64(8, true) && header.getUint32(16, true) === 5000 &&
      header.getUint16(20, true) === 176 && header.getUint16(22, true) === 0, 'Invalid ESK session header');
    this.connection = header.getUint16(2, true);
    this.boot = header.getBigUint64(8, true);
    await this.control(2);
    const config = new DataView(new ArrayBuffer(44));
    config.setUint32(0, ABI_MAGIC, true);
    config.setUint16(4, 3, true);
    config.setUint16(6, 44, true);
    config.setUint32(8, stream ? ESK_STREAM_RATE : ESK_RATE, true);
    config.setUint32(12, stream ? 0 : ESK_SAMPLES, true);
    config.setUint32(16, 0xff, true);
    await this.command(1, config.buffer);
  }
  async capture(): Promise<Uint8Array> {
    await this.configure(false);
    // Queue the exact-length read before START. A packet-aligned finite record has no trailing ZLP.
    const read = this.usb.transferIn(1, ESK_SAMPLES);
    void read.catch(() => {}); // START can fail before we await the pending read.
    await this.command(2);
    const data = await within(read, 700);
    requireField(data.status === 'ok' && data.data?.byteLength === ESK_SAMPLES, 'Incomplete xLOGIC sample record');
    await this.command(3);
    await this.checkFinalStatus(false);
    await this.release();
    return new Uint8Array(data.data.buffer, data.data.byteOffset, data.data.byteLength);
  }

  async stream(signal: AbortSignal, accept: (bytes: Uint8Array) => void): Promise<bigint> {
    if (signal.aborted) return 0n;
    await this.configure(true);
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
      try { transmitted = await this.checkFinalStatus(true); }
      finally { await this.release(); }
    }
    requireField(transmitted >= received, 'ESK transmitted fewer bytes than the host received');
    return transmitted;
  }

  private async release(): Promise<void> {
    let safe = await this.control(4);
    const until = performance.now() + 500;
    while (!safe && performance.now() < until) { await delay(); safe = await this.control(5); }
    requireField(safe === 1, 'ESK has not confirmed safe release');
    await this.control(6);
  }
  private async checkFinalStatus(stream: boolean): Promise<bigint> {
    const end = performance.now() + 400;
    do {
      const s = await this.input(0x64, 64, 0);
      abi(s, 64);
      const flags = s.getUint32(56, true);
      requireField(!(flags & 32), 'ESK capture session fault');
      if (!s.getUint32(12, true) && (flags & 28) === 4) {
        const sent = s.getBigUint64(24, true);
        const rate = stream ? ESK_STREAM_RATE : ESK_RATE;
        requireField((stream ? s.getUint32(8, true) === 1 && s.getUint32(44, true) === rate : (s.getBigUint64(16, true) === BigInt(ESK_SAMPLES) && sent === BigInt(ESK_SAMPLES))) &&
          [32, 36, 40, 52, 60].every(i => !s.getUint32(i, true)) && (flags & 1) &&
          s.getUint32(48, true) === rate, 'xLOGIC sample counts, rate or error counters differ');
        return sent;
      }
      await delay();
    } while (performance.now() < end);
    throw new Error('ESK capture did not reach quiescence');
  }
  async close(): Promise<void> {
    if (this.connection) await this.output(0x75, words(this.boot));
  }
}

/** One acquisition owns only MI0. Closing its handle cancels pending endpoint work on failure. */
async function withLogic<T>(device: USBDevice, run: (session: LogicSession) => Promise<T>): Promise<T> {
  const session = new LogicSession(device);
  try {
    await device.open();
    if (!device.configuration) await device.selectConfiguration(1);
    const intf = device.configuration?.interfaces.find(i => i.interfaceNumber === USB_INTERFACE);
    requireField(intf?.alternate.interfaceClass === 255 && intf.alternate.endpoints.some(
      ep => ep.type === 'bulk' && ep.direction === 'in' && ep.endpointNumber === 1), 'Missing xLOGIC bulk IN endpoint');
    await device.claimInterface(USB_INTERFACE);
    return await run(session);
  } finally {
    try { await session.close(); }
    finally { if (device.opened) await device.close(); }
  }
}

export function captureEsk(device: USBDevice): Promise<Uint8Array> {
  return withLogic(device, session => session.capture());
}

export function recordEskUsb(device: USBDevice, signal: AbortSignal, accept: (bytes: Uint8Array) => void): Promise<bigint> {
  return withLogic(device, session => session.stream(signal, accept));
}
