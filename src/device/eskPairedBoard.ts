// SPDX-License-Identifier: GPL-3.0-or-later
import { ESK_FINITE_RATES, ESK_PACKED_RATE, ESK_RATE, ESK_SAMPLES } from './eskCapture.js';
import { EskControlRejection } from './eskUsbSession.js';
import { localBoard, localCapture, localRequest } from './eskLocalBoard.js';
import { DDR_PRETRIGGER_PERCENTS, type DdrTrigger, ddrEdgeRequest, validDdrEdge } from './eskDdrTrigger.js';

function boardWindow(): Window | null {
  if (window.parent !== window) return window.parent;
  return window.opener && !window.opener.closed ? window.opener : null;
}

let connected = false;
let captureMaximum: number | undefined;
let localBoot: string | undefined;
const legacyRates = [ESK_RATE];
let advertisedRates: number[] | undefined;
let triggerRates: number[] = [];
let preTriggerPercents: number[] = [];
export const boardPreTriggerPercents = (): readonly number[] => preTriggerPercents;
export function boardDdrTriggerAvailable(rate: number): boolean { return triggerRates.includes(rate); }
export function boardCaptureRates(): readonly number[] { return advertisedRates ?? legacyRates; }
export function boardCaptureMaximum(rate = ESK_RATE): number | undefined {
  if (rate !== ESK_PACKED_RATE || captureMaximum === undefined) return captureMaximum;
  return Math.floor(Math.min(captureMaximum, 2_147_483_520) / 192) * 192;
}
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
export function fromBoard(): boolean { return launchingBoard() !== undefined || localBoard() !== undefined; }

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
  if (localBoard()) {
    const samples = new Uint8Array(ESK_SAMPLES);
    const ticks = await receiveBoardCapture(samples.length, new AbortController().signal, async (block, offset) => { samples.set(block, offset); });
    return {samples, ticks};
  }
  await connectBoard();
  const data = await request('capture') as { samples?: unknown; ticks?: unknown } | null;
  if (!(data?.samples instanceof Uint8Array) || data.samples.length !== ESK_SAMPLES ||
      typeof data.ticks !== 'string' || !/^\d{1,20}$/.test(data.ticks)) throw new Error('Invalid ESK capture');
  return {samples: data.samples, ticks: data.ticks};
}

interface Feature { name: string; instance: number; enabled: boolean; ownership: string }
interface Catalog { services: string[][]; resources: string[][] }
interface I2cLimits { write: number; writeRead: number; read: number }
export interface BoardStatus { deviceId: string; boot: string; firmware: number; hardwareId?: number; networkManagement?: boolean; captureMaxSamples?: number; captureRates?: number[]; captureTriggerRates?: number[]; capturePreTriggerPercents?: number[]; features: Feature[]; catalog?: Catalog; i2cLimits?: I2cLimits | null }

/** Keep a single DEVICE grant across read, apply, observation and EEPROM save. */
export async function withBoardManagement<T>(board: BoardStatus, run: (exchange: (payload: Uint8Array) => Promise<Uint8Array>) => Promise<T>): Promise<T> {
  const peer = boardWindow(), origin = launchingBoard();
  if (!board.networkManagement || !origin || !peer) throw new Error('Reconnect to a board with Ethernet management support.');
  const {port1, port2} = new MessageChannel();
  let id = 0;
  function reply(send: () => void, timeout: number): Promise<{id?: number; ready?: boolean; status?: number; payload?: Uint8Array}> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Board did not reply. Refresh before trying again.')), timeout);
      port1.onmessageerror = () => { clearTimeout(timer); reject(new Error('Unreadable board reply')); };
      port1.onmessage = ({data}) => {
        clearTimeout(timer);
        if (!data || data.error) reject(new Error(data?.error || 'Invalid board reply'));
        else resolve(data);
      };
      try { send(); } catch (error) { clearTimeout(timer); reject(error); }
    });
  }
  try {
    const open = await reply(() => peer.postMessage({type: 'xesk.management.v1', deviceId: board.deviceId, boot: board.boot}, origin, [port2]), 20000);
    if (open.ready !== true) throw new Error('Board did not grant management access.');
    const result = await run(async payload => {
      const expected = ++id;
      const r = await reply(() => port1.postMessage({id: expected, payload}), 5000);
      if (r.id === expected && typeof r.status === 'number' && Number.isInteger(r.status) && r.status > 0 && r.status <= 10)
        throw new EskControlRejection(r.status, 7);
      if (r.id !== expected || !(r.payload instanceof Uint8Array) || r.payload.length > 128) throw new Error('Invalid board management reply.');
      return r.payload;
    });
    return result;
  } finally {
    port1.postMessage({id: ++id, close: true});
    port1.close();
  }
}

export async function transferBoardI2c(board: BoardStatus, address: number, data: Uint8Array, count: number): Promise<Uint8Array> {
  const limits = board.i2cLimits;
  if (!limits || !Number.isInteger(address) || address < 8 || address > 0x77 ||
      !Number.isInteger(count) || count < 0 || count > limits.read || (!data.length && !count) ||
      data.length > (count ? limits.writeRead : limits.write)) throw new Error('I²C transaction exceeds the board’s Ethernet limits.');
  const reply = localBoard() ? new Uint8Array(await (await localRequest('lan_i2c',
    {boot: board.boot, data: Array.from(data), address, count})).arrayBuffer()) : await request({type: 'xesk.i2c.v1', deviceId: board.deviceId, boot: board.boot,
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
  const local = localBoard();
  const data = (local ? await (await localRequest('lan_status')).json() : await request('status')) as BoardStatus | null;
  if (!data || !/^[0-9a-f]{32}$/i.test(data.deviceId) || !/^\d{1,20}$/.test(data.boot) ||
      !Number.isSafeInteger(data.firmware) || !Array.isArray(data.features) || data.features.length > 64 ||
      !data.features.every(row => row && typeof row.name === 'string' && Number.isInteger(row.instance) &&
        typeof row.enabled === 'boolean' && typeof row.ownership === 'string')) throw new Error('Invalid ESK status');
  if (data.catalog !== undefined && (!data.catalog ||
      !validRows(data.catalog.services, 32) || !validRows(data.catalog.resources, 64))) {
    throw new Error('Invalid ESK device catalog');
  }
  const max = data.captureMaxSamples;
  if (data.networkManagement !== undefined && typeof data.networkManagement !== 'boolean') throw new Error('Invalid Ethernet management capability');
  if (data.i2cLimits != null && ![data.i2cLimits.write, data.i2cLimits.writeRead, data.i2cLimits.read].every(
    n => Number.isInteger(n) && n > 0 && n <= 128)) throw new Error('Invalid board I²C limits');
  if (data.hardwareId !== undefined && (!Number.isInteger(data.hardwareId) || data.hardwareId < 0 || data.hardwareId > 0xffffffff)) {
    throw new Error('Invalid ESK hardware ID');
  }
  if (max !== undefined && (!Number.isSafeInteger(max) || max < 0 || max > 0xffffffff || max % 64)) {
    throw new Error('Invalid board capture capacity');
  }
  const rates = data.captureRates;
  if (rates !== undefined && (!Array.isArray(rates) || rates.length > 32 || rates.some(rate => !Number.isSafeInteger(rate) || rate <= 0 || rate > 0xffffffff) ||
      (!!rates.length !== !!max) || (max && !rates.includes(ESK_RATE)))) throw new Error('Invalid Ethernet sampling rates');
  const supported = rates && [ESK_PACKED_RATE, ...ESK_FINITE_RATES].filter(hz => rates.includes(hz));
  const triggers = data.captureTriggerRates ?? [];
  if (!Array.isArray(triggers) || triggers.length > ESK_FINITE_RATES.length || triggers.some(hz =>
      data.firmware < 0x2c00 || !ESK_FINITE_RATES.includes(hz) || !supported?.includes(hz))) throw new Error('Invalid Ethernet trigger rates.');
  const percents = data.capturePreTriggerPercents ?? [];
  if (!Array.isArray(percents) || percents.length > DDR_PRETRIGGER_PERCENTS.length || new Set(percents).size !== percents.length ||
      percents.some(p => data.firmware < 0x2d00 || (max ?? 0) < 1024 || !triggers.includes(41_666_666) ||
        !DDR_PRETRIGGER_PERCENTS.includes(p))) throw new Error('Invalid Ethernet pretrigger capabilities.');
  if (captureMaximum !== max || advertisedRates?.join() !== supported?.join() || triggerRates.join() !== triggers.join() ||
      preTriggerPercents.join() !== percents.join()) {
    preTriggerPercents = percents;
    triggerRates = triggers;
    advertisedRates = supported;
    captureMaximum = max;
    window.dispatchEvent(new Event('esk-capture-capacity'));
  }
  if (local) localBoot = data.boot;
  return data;
}

/** Receive one board block at a time. Acknowledge only after the sink accepts it. */
export async function receiveBoardCapture(count: number, signal: AbortSignal,
    accept: (block: Uint8Array, offset: number) => Promise<void>, rate = ESK_RATE, trigger?: DdrTrigger): Promise<string> {
  await connectBoard();
  signal.throwIfAborted();
  if (trigger && (!validDdrEdge(trigger, rate, count, preTriggerPercents) || !boardDdrTriggerAvailable(rate))) throw new Error('Unsupported Ethernet edge trigger.');
  if (localBoard()) {
    if (!localBoot) await readBoardStatus();
    if (!Number.isSafeInteger(count) || count < 1 || count > (boardCaptureMaximum(rate) ?? 0) || !boardCaptureRates().includes(rate))
      throw new Error('Capture exceeds the board limits.');
    return localCapture(localBoot!, count, rate, signal, accept, trigger);
  }
  const origin = launchingBoard(), peer = boardWindow();
  if (!origin || !peer || !Number.isSafeInteger(count) || count < 1 || count > (boardCaptureMaximum(rate) ?? 0)) {
    throw new Error('Capture exceeds board capacity');
  }
  const rated = advertisedRates !== undefined;
  if (!boardCaptureRates().includes(rate)) throw new Error('Unsupported Ethernet capture rate');
  const {port1, port2} = new MessageChannel();
  return new Promise((resolve, reject) => {
    let bytes = 0, receiving = false, finished = false;
    let timer: ReturnType<typeof setTimeout>;
      let armed = false;
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
        if (trigger && data.armed === true && !armed && !bytes) {
          armed = true; deadline(); trigger.onArmed(); return;
        }
        if (trigger && armed && data.waiting === true && !bytes) { deadline(); port1.postMessage('alive'); return; }
        if (trigger && !armed) throw new Error('Board did not confirm the trigger was armed.');
        if (data.done === true) {
          if (bytes !== count || (rated && data.rate !== rate) || typeof data.ticks !== 'string' || !/^\d{1,20}$/.test(data.ticks)) throw new Error('Incomplete board capture');
          if (rate === ESK_PACKED_RATE && (data.format !== 1 || data.channelMask !== 255)) throw new Error('Invalid eight-channel capture format');
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
    const message = trigger ? {type: 'xesk.capture.v4', count, rate, trigger: ddrEdgeRequest(trigger)}
      : rated ? {type: 'xesk.capture.v3', count, rate} : {type: 'xesk.capture.v2', count};
    try { peer.postMessage(message, origin, [port2]); }
    catch (error) { finish(); port2.close(); reject(error); }
  });
}
