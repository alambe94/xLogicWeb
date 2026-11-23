// SPDX-License-Identifier: GPL-3.0-or-later
import { ESK_PACKED_RATE } from '../device/eskCapture.js';
import { displaySamples, type EskRecordingOptions, type SavedRecording } from './eskRecorder.js';

interface NativeRecord {
  id: string; rate: number; bank: 'lower' | 'upper'; samples: number;
  state: 'recording' | 'saved' | 'failed'; title: string; note: string;
}

export function nativeRecorderAvailable(): boolean {
  return location.hostname === '127.0.0.1' && !!document.querySelector('meta[name="esk-native-recorder"]');
}

async function request(op: string, params: Record<string, unknown> = {}): Promise<Response> {
  const response = await fetch('/api/native', {method: 'POST', cache: 'no-store',
    headers: {'Content-Type': 'application/json'}, body: JSON.stringify({op, ...params})});
  if (!response.ok) throw new Error(await response.text());
  return response;
}

export function showNativeRecorder(action: 'capture' | 'browse', options: EskRecordingOptions, confirmReplace: () => Promise<boolean>,
    display: (bytes: Uint8Array, rate: number, start: number, name: string, saved: SavedRecording) => void): void {
  const dialog = document.querySelector<HTMLDialogElement>('#native-recorder')!;
  if (dialog.open) return;
  const find = <T extends HTMLElement>(name: string) => dialog.querySelector<T>('#native-' + name)!;
  const record = find<HTMLButtonElement>('record'), stop = find<HTMLButtonElement>('stop');
  const reopen = find<HTMLButtonElement>('reopen'), close = find<HTMLButtonElement>('close');
  const list = find<HTMLSelectElement>('archive'), status = find<HTMLOutputElement>('status');
  find('profile').textContent = (options.rate / 1e6).toFixed(2) + ' MS/s · ' +
    (options.rate === ESK_PACKED_RATE ? (options.bank === 'upper' ? 'D4–D7' : 'D0–D3') : 'D0–D7') + ' · ' +
    (Number.isFinite(options.count) ? options.count.toLocaleString() + ' samples' : 'Until stopped');
  let active = '', busy = false;
  function controls() {
    record.disabled = close.disabled = busy;
    stop.disabled = !active;
    reopen.disabled = list.disabled = busy || !list.value;
  }
  async function guarded(fn: () => Promise<void>) {
    if (busy) return;
    busy = true; controls();
    try { await fn(); }
    catch (e) { status.value = e instanceof Error ? e.message : String(e); }
    finally { busy = false; active = ''; controls(); }
  }
  async function show(row: NativeRecord) {
    if (row.state !== 'saved') throw new Error(row.note || 'Recording is unavailable');
    const saved: SavedRecording = {key: row.id, samples: row.samples, summary: row.note,
      read: async (start, end) => {
        const bytes = new Uint8Array(await (await request('window', {id: row.id, start, end})).arrayBuffer());
        if (bytes.length !== end - start) throw new Error('Incomplete native recording window');
        return bytes;
      }};
    const start = Math.max(0, row.samples - displaySamples);
    const title = row.rate === ESK_PACKED_RATE ? 'xLOGIC USB ' + (row.bank === 'upper' ? 'D4–D7' : 'D0–D3') : 'xLOGIC USB';
    display(await saved.read(start, row.samples), row.rate, start, title, saved);
    dialog.close();
  }
  async function follow(row: NativeRecord) {
    active = row.id; controls();
    while (row.state === 'recording') {
      status.value = row.samples.toLocaleString() + ' samples on disk';
      await new Promise(resolve => setTimeout(resolve, 250));
      row = await (await request('status', {id: row.id})).json();
    }
    await show(row);
  }
  async function refresh() {
    const rows: NativeRecord[] = await (await request('list')).json();
    list.replaceChildren(...rows.filter(r => r.state === 'saved').map(r => new Option(
      r.title + ' · ' + r.samples.toLocaleString() + ' samples', r.id)));
    const running = rows.find(r => r.state === 'recording');
    if (running) await follow(running);
    else if (rows[0]?.state === 'failed') status.value = rows[0].note;
  }
  async function start() {
    if (!await confirmReplace()) {
      if (action === 'capture') dialog.close();
      return;
    }
    status.value = 'Starting USB recording…';
    await follow(await (await request('start', {rate: options.rate, bank: options.bank,
      samples: Number.isFinite(options.count) ? options.count : null})).json());
  }
  record.onclick = () => void guarded(start);
  stop.onclick = async () => {
    stop.disabled = true;
    try { await request('stop', {id: active}); }
    catch (e) { status.value = String(e); controls(); }
  };
  reopen.onclick = () => void guarded(async () => {
    if (await confirmReplace()) await show(await (await request('status', {id: list.value})).json());
  });
  dialog.oncancel = e => { if (busy) e.preventDefault(); };
  close.onclick = () => dialog.close();
  record.hidden = find('library').hidden = action === 'capture';
  status.value = '';
  dialog.showModal();
  void guarded(action === 'capture' ? start : refresh);
}
