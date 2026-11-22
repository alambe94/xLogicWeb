// SPDX-License-Identifier: GPL-3.0-or-later
const CONTROL_MAGIC = new TextEncoder().encode('xESKCTRL');
export function requireField(value: unknown, detail: string): asserts value {
  if (!value) throw new Error(detail);
}
function words(...values: bigint[]): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(values.length * 8));
  values.forEach((value, index) => view.setBigUint64(index * 8, value, true));
  return view.buffer;
}
export const delay = () => new Promise<void>(resolve => setTimeout(resolve, 2));

export async function within<T>(operation: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('ESK USB transfer timed out')), ms);
    })]);
  } finally { clearTimeout(timer); }
}

export class EskUsbSession {
  protected connection = 0;
  protected boot = 0n;
  protected session = 0n;
  private sequence = 0n;
  constructor(protected readonly usb: USBDevice, readonly intf: number, private readonly base: number, private readonly service: number) {}

  private setup(request: number, value = this.connection): USBControlTransferParameters {
    return { requestType: 'vendor', recipient: 'interface', request, value, index: this.intf };
  }
  protected async input(request: number, length: number, value = this.connection): Promise<DataView> {
    const r = await within(this.usb.controlTransferIn(this.setup(request, value), length), 1000);
    requireField(r.status === 'ok' && r.data?.byteLength === length, 'Short or failed ESK control read');
    return r.data;
  }
  protected async output(request: number, data: ArrayBuffer): Promise<void> {
    const r = await within(this.usb.controlTransferOut(this.setup(request), data), 1000);
    requireField(r.status === 'ok' && r.bytesWritten === data.byteLength, 'Short or failed ESK control write');
  }
  private async fetchControl(): Promise<DataView> {
    const end = performance.now() + 500;
    do {
      const r = await within(this.usb.controlTransferIn(this.setup(this.base + 2), 176), 500);
      if (r.status === 'stall') { await delay(); continue; }
      requireField(r.status === 'ok' && r.data && r.data.byteLength >= 48, 'Invalid ESK control response');
      return r.data;
    } while (performance.now() < end);
    throw new Error('ESK control reply deadline expired');
  }
  async openConnection(): Promise<void> {
    const header = await this.input(this.base, 24, 0);
    requireField(header.getUint16(0, true) === 1 && header.getUint16(2, true) && header.getUint32(4, true) === 0 &&
      header.getBigUint64(8, true) && header.getUint32(16, true) === 5000 &&
      header.getUint16(20, true) === 176 && header.getUint16(22, true) === 0, 'Invalid ESK session header');
    this.connection = header.getUint16(2, true);
    this.boot = header.getBigUint64(8, true);
  }

  protected async exchange(opcode: number, payload: Uint8Array, service = 0, session = 0n): Promise<DataView> {
    const frame = new Uint8Array(48 + payload.length);
    const v = new DataView(frame.buffer);
    frame.set(CONTROL_MAGIC);
    frame.set([2, 1, opcode], 8);
    v.setUint16(12, frame.length, true);
    v.setBigUint64(16, ++this.sequence, true);
    v.setBigUint64(24, this.boot, true);
    v.setBigUint64(32, session, true);
    v.setUint16(40, service, true);
    frame.set(payload, 48);
    await this.output(this.base + 1, frame.buffer);
    const reply = await this.fetchControl();
    const status = reply.getUint8(11);
    requireField(CONTROL_MAGIC.every((b, i) => reply.getUint8(i) === b) &&
      reply.getUint8(8) === 2 && reply.getUint8(9) === 2 && reply.getUint8(10) === opcode && status <= 10 &&
      reply.getUint16(12, true) === reply.byteLength && reply.getUint16(14, true) === 0 &&
      reply.getBigUint64(16, true) === this.sequence && reply.getBigUint64(24, true) === this.boot &&
      reply.getUint16(40, true) === service && reply.getUint16(42, true) === 0 && reply.getUint32(44, true) === 0 &&
      (opcode === 2 && status === 0 ? reply.getBigUint64(32, true) !== 0n : reply.getBigUint64(32, true) === session) &&
      (status === 0 || reply.byteLength === 48), 'Mismatched ESK control reply');
    await this.output(this.base + 3, words(this.boot, this.sequence));
    requireField(status === 0, 'ESK rejected control request ' + opcode + ' (status ' + status + ')');
    return reply;
  }

  protected async control(opcode: 2 | 3 | 4 | 5 | 6): Promise<number> {
    const payload = new Uint8Array(opcode === 2 ? 16 : opcode === 3 ? 8 : 0);
    if (opcode === 2) payload[0] = 1;
    if (payload.length) new DataView(payload.buffer).setBigUint64(payload.length - 8, 1000n, true);
    const r = await this.exchange(opcode, payload, this.service, this.session);
    requireField(r.byteLength === (opcode === 6 ? 48 : 100), 'Malformed service session reply');
    const sid = r.getBigUint64(32, true);
    if (opcode === 6) return 0;
    requireField(r.getUint32(48, false) === 0x7845534b && r.getUint8(52) === 1 && r.getUint8(53) === 5 &&
      r.getUint16(54, true) === 0 && r.getUint16(56, true) === 52 && r.getUint16(58, true) === 0 &&
      r.getBigUint64(60, true) === this.boot && r.getBigUint64(68, true) === sid &&
      r.getUint16(84, true) === this.service && r.getUint16(86, true) === 0 && r.getUint32(88, true) === 1 &&
      r.getUint8(92) === 1 && r.getUint8(93) === 1 && r.getUint8(95) === 1,
      'Unexpected ESK service session binding');
    const flags = r.getUint32(96, true);
    requireField(r.getUint8(94) === (opcode <= 3 ? 1 : 3) && (opcode <= 3 ? flags === 0 : flags <= 1),
      'Unexpected ESK session state');
    this.session = sid;
    return flags;
  }
  protected async release(): Promise<void> {
    let safe = await this.control(4);
    const until = performance.now() + 500;
    while (!safe && performance.now() < until) { await delay(); safe = await this.control(5); }
    requireField(safe === 1, 'ESK has not confirmed safe release');
    await this.control(6);
  }
  async close(): Promise<void> {
    if (this.connection) await this.output(this.base + 5, words(this.boot));
  }
}

const active = new WeakSet<USBDevice>();
export async function withUsbInterface<T>(device: USBDevice, session: EskUsbSession,
    run: (intf: USBAlternateInterface) => Promise<T>): Promise<T> {
  requireField(!active.has(device), 'ESK USB is busy');
  active.add(device);
  try {
    await device.open();
    if (!device.configuration) await device.selectConfiguration(1);
    const intf = device.configuration?.interfaces.find(i => i.interfaceNumber === session.intf);
    requireField(intf?.alternate.interfaceClass === 255, 'Missing ESK USB interface');
    await device.claimInterface(session.intf);
    return await run(intf.alternate);
  } finally {
    try { await session.close(); }
    finally {
      try { if (device.opened) await device.close(); }
      finally { active.delete(device); }
    }
  }
}
