// SPDX-License-Identifier: GPL-3.0-or-later
import { ESK_PACKED_RATE } from '../device/eskCapture.js';
import { formatBytes } from './format.js';
import { displaySamples, type EskRecordingOptions, type SavedRecording } from './eskRecorder.js';

interface NativeRecord {
  id: string; rate: number; bank: 'lower' | 'upper'; samples: number; bytes?: number;
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

function drawPreview(canvas: HTMLCanvasElement, data: Uint8Array, row: NativeRecord) {
  const ctx = canvas.getContext('2d');
  if (!ctx || !data.length) return;
  const channels = row.rate === ESK_PACKED_RATE ? 4 : 8;
  const left = 30, width = Math.min(data.length, canvas.width - left);
  canvas.height = channels * 20;
  const style = getComputedStyle(canvas);
  ctx.font = '12px system-ui';
  ctx.fillStyle = style.color;
  ctx.strokeStyle = style.color;
  for (let ch = 0; ch < channels; ch++) {
    ctx.fillText('D' + (ch + (channels === 4 && row.bank === 'upper' ? 4 : 0)), 4, ch * 20 + 14);
  }
  // Draw the high/low envelope of every pixel so short pulses survive scaling.
  ctx.beginPath();
  for (let x = 0; x < width; x++) {
    const a = Math.floor(x * data.length / width), b = Math.floor((x + 1) * data.length / width);
    let high = data[a]!, low = high;
    for (let i = a + 1; i < b; i++) { high |= data[i]!; low &= data[i]!; }
    for (let ch = 0; ch < channels; ch++) {
      const baseline = ch * 20 + 16, bit = 1 << ch;
      const firstY = baseline - (data[a]! & bit ? 10 : 0);
      ctx.moveTo(left + x, baseline - (data[Math.max(a - 1, 0)]! & bit ? 10 : 0));
      ctx.lineTo(left + x, firstY);
      ctx.lineTo(left + x, baseline - (high & bit ? 10 : 0));
      ctx.lineTo(left + x, baseline - (low & bit ? 10 : 0));
      const lastY = baseline - (data[b - 1]! & bit ? 10 : 0);
      ctx.lineTo(left + x, lastY);
      ctx.lineTo(left + x + 1, lastY);
    }
  }
  ctx.stroke();
}

export function showNativeRecorder(action: 'capture' | 'browse', options: EskRecordingOptions, confirmReplace: () => Promise<boolean>,
    display: (bytes: Uint8Array, rate: number, start: number, name: string, saved: SavedRecording) => void,
    removed: (key: string) => void): void {
  const dialog = document.querySelector<HTMLDialogElement>('#native-recorder')!;
  if (dialog.open) return;
  const find = <T extends HTMLElement>(name: string) => dialog.querySelector<T>('#native-' + name)!;
  const record = find<HTMLButtonElement>('record'), stop = find<HTMLButtonElement>('stop');
  const reopen = find<HTMLButtonElement>('reopen'), close = find<HTMLButtonElement>('close');
  const list = find<HTMLSelectElement>('archive'), status = find<HTMLOutputElement>('status');
  const erase = find<HTMLButtonElement>('delete'), preview = find('preview');
  preview.hidden = true;
  find('profile').textContent = (options.rate / 1e6).toFixed(2) + ' MS/s · ' +
    (options.rate === ESK_PACKED_RATE ? (options.bank === 'upper' ? 'D4–D7' : 'D0–D3') : 'D0–D7') + ' · ' +
    (Number.isFinite(options.count) ? options.count.toLocaleString() + ' samples' : 'Until stopped');
  let active = '', busy = false;
  function controls() {
    record.disabled = close.disabled = busy;
    stop.disabled = !active;
    erase.disabled = list.disabled = busy || !list.value;
    reopen.disabled = list.disabled || list.selectedOptions[0]?.dataset.state !== 'saved';
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
      }, edge: async (position, channel, direction) =>
        (await request('edge', {id: row.id, position, channel, direction})).json()};
    const start = Math.max(0, row.samples - displaySamples);
    const title = row.rate === ESK_PACKED_RATE ? 'xLOGIC USB ' + (row.bank === 'upper' ? 'D4–D7' : 'D0–D3') : 'xLOGIC USB';
    display(await saved.read(start, row.samples), row.rate, start, title, saved);
    dialog.close();
  }
  async function follow(row: NativeRecord) {
    active = row.id; controls();
    let lastPreview = 0;
    while (row.state === 'recording') {
      status.value = row.samples.toLocaleString() + ' samples on disk';
      if (row.samples > lastPreview && !document.hidden) {
        const end = row.samples, start = Math.max(0, end - displaySamples);
        try {
          const data = new Uint8Array(await (await request('preview', {id: row.id, start, end})).arrayBuffer());
          if (data.length !== end - start) throw new Error('Incomplete preview');
          drawPreview(find<HTMLCanvasElement>('wave'), data, row);
          find('range').textContent = '· samples ' + start.toLocaleString() + '–' + (end - 1).toLocaleString();
          lastPreview = end;
          preview.hidden = false;
        } catch { preview.hidden = true; status.value += ' · Preview unavailable'; }
      }
      await new Promise(resolve => setTimeout(resolve, 250));
      row = await (await request('status', {id: row.id})).json();
    }
    await show(row);
  }
  async function refresh() {
    const rows: NativeRecord[] = await (await request('list')).json();
    const space = await (await request('storage')).json();
    find('storage').textContent = (space.available / 2 ** 30).toFixed(2) + ' GiB available · ' +
      (space.budget / 2 ** 30) + ' GiB archive limit';
    list.replaceChildren(...rows.filter(r => r.state !== 'recording').map(r => {
      const option = new Option(r.title + ' · ' + r.samples.toLocaleString() + ' samples · ' + formatBytes(r.bytes ?? 0) +
        (r.state === 'failed' ? ' · Failed' : ''), r.id);
      option.dataset.state = r.state;
      return option;
    }));
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
  list.onchange = controls;
  erase.onclick = () => void guarded(async () => {
    const key = list.value;
    if (!window.confirm('Permanently delete ' + list.selectedOptions[0]!.text + '?')) return;
    await request('delete', {id: key});
    removed(key);
    status.value = 'Recording deleted.';
    await refresh();
  });
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
