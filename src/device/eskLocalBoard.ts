// SPDX-License-Identifier: GPL-3.0-or-later
import type { BoardStatus } from './eskPairedBoard.js';
import { type DdrTrigger, ddrEdgeRequest } from './eskDdrTrigger.js';

export function localEthernetAvailable(): boolean {
  return typeof location !== 'undefined' && location.hostname === '127.0.0.1' &&
    typeof document !== 'undefined' && !!document.querySelector('meta[name="esk-native-recorder"][data-local-board]');
}

export function localBoard(): string | undefined {
  if (!localEthernetAvailable()) return;
  const key = new URLSearchParams(location.hash.slice(1)).get('eskLocal');
  return key && /^[a-f0-9]{32}$/.test(key) ? key : undefined;
}

export async function localRequest(op: string, fields: Record<string, unknown> = {}, signal?: AbortSignal): Promise<Response> {
  const response = await fetch('/api/native', {method: 'POST', cache: 'no-store', redirect: 'error',
    headers: {'Content-Type': 'application/json'}, body: JSON.stringify({op, board: localBoard(), ...fields}),
    ...(signal ? {signal} : {})});
  if (!response.ok) throw new Error(await response.text());
  return response;
}

export async function selectLocalBoard(address: URL, discovered?: string): Promise<void> {
  const key = await (await localRequest('lan_select', {host: address.hostname, port: Number(address.port || 80), discovered})).json();
  if (typeof key !== 'string' || !/^[a-f0-9]{32}$/.test(key)) throw new Error('Invalid local board selection.');
  const next = new URL('/?view=home&lan=local', location.origin);
  next.hash = new URLSearchParams({eskLocal: key}).toString();
  location.assign(next.href);
}

export async function localBoardName(board: BoardStatus, name?: string): Promise<{name: string; advertised?: string}> {
  const result = await (await localRequest('lan_name', {boot: board.boot, name})).json();
  if (typeof result?.name !== 'string' || (name !== undefined && (result.name !== name || typeof result.advertised !== 'string')))
    throw new Error('Invalid board name reply.');
  return result;
}

export async function localCapture(boot: string, count: number, rate: number, signal: AbortSignal,
    accept: (data: Uint8Array, offset: number) => Promise<void>, trigger?: DdrTrigger): Promise<string> {
  const response = await localRequest('lan_capture', {boot, count, rate,
    ...(trigger ? {trigger: ddrEdgeRequest(trigger)} : {})}, signal);
  const prefix = trigger ? new Uint8Array(9) : undefined;
  let prefixUsed = 0;
  let ticks = response.headers.get('X-ESK-Ticks') ?? '';
  const reportedRate = response.headers.get('X-ESK-Rate');
  const checkGeometry = rate === 500_000_000 || reportedRate !== null;
  if (response.headers.get('Content-Length') !== String(count + (prefix?.length ?? 0)) ||
      (trigger ? response.headers.get('X-ESK-Armed') !== '1' : !/^\d{1,20}$/.test(ticks)) ||
      (checkGeometry && (reportedRate !== String(rate) || response.headers.get('X-ESK-Format') !== 'raw8' ||
        response.headers.get('X-ESK-Channel-Mask') !== '255')) ||
      response.headers.get('Content-Type') !== 'application/octet-stream' || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Invalid local capture header.');
  }
  const reader = response.body.getReader();
  let offset = 0;
  try {
    for (;;) {
      const {value: chunk, done} = await reader.read();
      if (done) break;
      let value = chunk;
      if (prefix && prefixUsed < prefix.length) {
        const take = Math.min(prefix.length - prefixUsed, value.byteLength);
        prefix.set(value.subarray(0, take), prefixUsed);
        if (!prefixUsed && take) {
          if (prefix[0] !== 1) throw new Error('Invalid local trigger acknowledgement.');
          trigger!.onArmed();
        }
        prefixUsed += take;
        if (prefixUsed === prefix.length) ticks = new DataView(prefix.buffer).getBigUint64(1, true).toString();
        value = value.subarray(take);
      }
      if (offset + value.byteLength > count) throw new Error('Capture exceeded the requested length.');
      for (let i = 0; i < value.byteLength; i += 32768) {
        signal.throwIfAborted();
        const block = value.byteLength <= 32768 && value.buffer.byteLength === value.byteLength ? value : value.slice(i, i + 32768);
        await accept(block, offset);
        offset += block.byteLength;
      }
    }
    if (offset !== count) throw new Error('Incomplete local capture.');
    return ticks;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
