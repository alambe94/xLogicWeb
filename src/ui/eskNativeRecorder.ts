// SPDX-License-Identifier: GPL-3.0-or-later
import { ESK_PACKED_RATE, selectedEskUsbDevice } from '../device/eskCapture.js';
import { displaySamples, type EskRecordingOptions, type RecordingDisplay } from './eskRecorder.js';
import { displayNativeRecording, listNativeRecordings, nativeRequest as request, type NativeRecord } from './nativeArchive.js';

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

export function showNativeRecorder(options: EskRecordingOptions, confirmReplace: () => Promise<boolean>, display: RecordingDisplay): void {
  const dialog = document.querySelector<HTMLDialogElement>('#native-recorder')!;
  if (dialog.open) return;
  const find = <T extends HTMLElement>(name: string) => dialog.querySelector<T>('#native-' + name)!;
  const stop = find<HTMLButtonElement>('stop'), close = find<HTMLButtonElement>('close');
  const status = find<HTMLOutputElement>('status'), preview = find('preview');
  preview.hidden = true;
  find('profile').textContent = (options.rate / 1e6).toFixed(2) + ' MS/s · ' +
    (options.rate === ESK_PACKED_RATE ? (options.bank === 'upper' ? 'D4–D7' : 'D0–D3') : 'D0–D7') + ' · ' +
    (Number.isFinite(options.count) ? options.count.toLocaleString() + ' samples' : 'Until stopped');
  let active = '', busy = false;
  function controls() {
    close.disabled = busy;
    stop.disabled = !active;
  }
  async function guarded(fn: () => Promise<void>) {
    if (busy) return;
    busy = true; controls();
    try { await fn(); }
    catch (e) { status.value = e instanceof Error ? e.message : String(e); }
    finally { busy = false; active = ''; controls(); }
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
    await displayNativeRecording(row, display, displaySamples);
    dialog.close();
  }
  async function start() {
    if (!await confirmReplace()) { dialog.close(); return; }
    const running = (await listNativeRecordings()).find(row => row.state === 'recording');
    if (running) { await follow(running); return; }
    status.value = 'Starting USB recording…';
    const selected = selectedEskUsbDevice();
    if (selected && !selected.serialNumber) throw new Error('The selected USB board has no serial number for native recording');
    await follow(await (await request('start', {rate: options.rate, bank: options.bank,
      samples: Number.isFinite(options.count) ? options.count : null, serial: selected?.serialNumber})).json());
  }
  stop.onclick = async () => {
    stop.disabled = true;
    try { await request('stop', {id: active}); }
    catch (e) { status.value = String(e); controls(); }
  };
  dialog.oncancel = e => { if (busy) e.preventDefault(); };
  close.onclick = () => dialog.close();
  status.value = '';
  dialog.showModal();
  void guarded(start);
}
