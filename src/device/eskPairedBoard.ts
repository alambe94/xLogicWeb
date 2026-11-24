// SPDX-License-Identifier: GPL-3.0-or-later
import { ESK_SAMPLES } from './eskCapture.js';

function boardWindow(): Window | null {
  if (window.parent !== window) return window.parent;
  return window.opener && !window.opener.closed ? window.opener : null;
}

let connected = false;
let captureMaximum: number | undefined;
export function boardCaptureMaximum(): number | undefined { return captureMaximum; }
export function needsBoardConsent(): boolean {
  return fromBoard() && window.parent !== window && !connected;
}

export function announceBoardView(): void {
  const board = launchingBoard();
  if (board && window.parent !== window) window.parent.postMessage('xesk.ready.v1', board);
}

async function connectBoard(): Promise<void> {
  if (!needsBoardConsent()) return;
  const result = await request('connect');
  if (result !== true) throw new Error('Board connection was not approved');
  connected = true;
}

function launchingBoard(): string | undefined {
  if (!boardWindow()) return;
  const value = new URLSearchParams(location.hash.slice(1)).get('eskBoard');
  if (!value) return;
  try {
    const board = new URL(value);
    if (board.origin === value && board.protocol === 'http:' && /^\d+\.\d+\.\d+\.\d+$/.test(board.hostname)) return value;
  } catch { /* Unrelated URL fragments do not select a board. */ }
}
export function fromBoard(): boolean { return launchingBoard() !== undefined; }

interface I2cTransfer { type: 'xesk.i2c.v1'; deviceId: string; boot: string; command: number; address: number; data: Uint8Array; count: number }
function request(kind: 'capture' | 'status' | 'connect' | I2cTransfer): Promise<unknown> {
  const board = launchingBoard();
  const peer = boardWindow();
  if (!board || !peer) return Promise.reject(new Error('Open xEskWeb at the board IP address.'));
  const {port1, port2} = new MessageChannel();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { port1.close(); reject(new Error(typeof kind === 'object'
      ? 'I²C reply timed out. Delivery is uncertain.' : 'Board tab did not reply. Reopen the viewer from the board.')); }, 65000);
    const finish = () => { clearTimeout(timer); port1.close(); };
    port1.onmessage = ({data}) => {
      finish();
      if (typeof data?.error === 'string') reject(new Error(data.error)); else resolve(data);
    };
    port1.onmessageerror = () => { finish(); reject(new Error('Unreadable board reply')); };
    try { peer.postMessage(typeof kind === 'object' ? kind : `xesk.${kind}.v1`, board, [port2]); }
    catch (error) { finish(); port2.close(); reject(error); }
  });
}

export async function capturePairedBoard(): Promise<{ samples: Uint8Array; ticks: string }> {
  await connectBoard();
  const data = await request('capture') as { samples?: unknown; ticks?: unknown } | null;
  if (!(data?.samples instanceof Uint8Array) || data.samples.length !== ESK_SAMPLES ||
      typeof data.ticks !== 'string' || !/^\d{1,20}$/.test(data.ticks)) throw new Error('Invalid ESK capture');
  return {samples: data.samples, ticks: data.ticks};
}

interface Feature { name: string; instance: number; enabled: boolean; ownership: string }
interface Catalog { services: string[][]; resources: string[][] }
interface I2cLimits { write: number; writeRead: number; read: number }
export interface BoardStatus { deviceId: string; boot: string; firmware: number; hardwareId?: number; captureMaxSamples?: number; features: Feature[]; catalog?: Catalog; i2cLimits?: I2cLimits | null }

export async function transferBoardI2c(board: BoardStatus, address: number, data: Uint8Array, count: number): Promise<Uint8Array> {
  const limits = board.i2cLimits;
  if (!limits || !Number.isInteger(address) || address < 8 || address > 0x77 ||
      !Number.isInteger(count) || count < 0 || count > limits.read || (!data.length && !count) ||
      data.length > (count ? limits.writeRead : limits.write)) throw new Error('I²C transaction exceeds the board’s Ethernet limits.');
  const reply = await request({type: 'xesk.i2c.v1', deviceId: board.deviceId, boot: board.boot,
    command: data.length ? (count ? 3 : 1) : 2, address, data, count});
  if (!(reply instanceof Uint8Array) || reply.length !== count) throw new Error('Invalid Ethernet I²C reply.');
  return reply;
}

function validRows(rows: unknown, limit: number): boolean {
  return Array.isArray(rows) && rows.length <= limit && rows.every(row =>
    Array.isArray(row) && row.length === 5 && row.every(cell => typeof cell === 'string'));
}
export async function readBoardStatus(): Promise<BoardStatus> {
  await connectBoard();
  const data = await request('status') as BoardStatus | null;
  if (!data || !/^[0-9a-f]{32}$/i.test(data.deviceId) || !/^\d{1,20}$/.test(data.boot) ||
      !Number.isSafeInteger(data.firmware) || !Array.isArray(data.features) || data.features.length > 64 ||
      !data.features.every(row => row && typeof row.name === 'string' && Number.isInteger(row.instance) &&
        typeof row.enabled === 'boolean' && typeof row.ownership === 'string')) throw new Error('Invalid ESK status');
  if (data.catalog !== undefined && (!data.catalog ||
      !validRows(data.catalog.services, 32) || !validRows(data.catalog.resources, 64))) {
    throw new Error('Invalid ESK device catalog');
  }
  const max = data.captureMaxSamples;
  if (data.i2cLimits != null && ![data.i2cLimits.write, data.i2cLimits.writeRead, data.i2cLimits.read].every(
    n => Number.isInteger(n) && n > 0 && n <= 128)) throw new Error('Invalid board I²C limits');
  if (data.hardwareId !== undefined && (!Number.isInteger(data.hardwareId) || data.hardwareId < 0 || data.hardwareId > 0xffffffff)) {
    throw new Error('Invalid ESK hardware ID');
  }
  if (max !== undefined && (!Number.isSafeInteger(max) || max < 0 || max > 0xffffffff || max % 64)) {
    throw new Error('Invalid board capture capacity');
  }
  if (captureMaximum !== max) {
    captureMaximum = max;
    window.dispatchEvent(new Event('esk-capture-capacity'));
  }
  return data;
}

/** Receive one board block at a time. Acknowledge only after the sink accepts it. */
export async function receiveBoardCapture(count: number, signal: AbortSignal,
    accept: (block: Uint8Array, offset: number) => Promise<void>): Promise<string> {
  await connectBoard();
  signal.throwIfAborted();
  const origin = launchingBoard(), peer = boardWindow();
  if (!origin || !peer || !Number.isSafeInteger(count) || count < 1 || count > (captureMaximum ?? 0)) {
    throw new Error('Capture exceeds board capacity');
  }
  const {port1, port2} = new MessageChannel();
  return new Promise((resolve, reject) => {
    let bytes = 0, receiving = false, finished = false;
    let timer: ReturnType<typeof setTimeout>;
    function finish() {
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      port1.close();
    }
    function fail(error: unknown) {
      if (finished) return;
      port1.postMessage('cancel');
      finish();
      reject(error);
    }
    function abort() { fail(signal.reason); }
    function deadline() {
      clearTimeout(timer);
      timer = setTimeout(() => fail(new Error('Board capture timed out')), 65000);
    }
    port1.onmessage = async ({data}) => {
      if (finished) return;
      try {
        if (receiving || !data) throw new Error('Unexpected board capture reply');
        if (typeof data.error === 'string') throw new Error(data.error);
        if (data.done === true) {
          if (bytes !== count || typeof data.ticks !== 'string' || !/^\d{1,20}$/.test(data.ticks)) throw new Error('Incomplete board capture');
          finish(); resolve(data.ticks); return;
        }
        const block = data.data;
        if (!(block instanceof Uint8Array) || data.offset !== bytes || !block.length || block.length > 32768 ||
            bytes + block.length > count) throw new Error('Invalid board capture block');
        receiving = true;
        await accept(block, bytes);
        if (finished) return;
        bytes += block.length;
        receiving = false;
        deadline();
        port1.postMessage('ack');
      } catch (error) { fail(error); }
    };
    port1.onmessageerror = () => fail(new Error('Unreadable capture block'));
    signal.addEventListener('abort', abort, {once: true});
    deadline();
    try { peer.postMessage({type: 'xesk.capture.v2', count}, origin, [port2]); }
    catch (error) { finish(); port2.close(); reject(error); }
  });
}
