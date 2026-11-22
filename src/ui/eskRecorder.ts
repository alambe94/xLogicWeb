// SPDX-License-Identifier: GPL-3.0-or-later
import { OpfsRecordController, RecordArchive } from '../data/recordController.js';
import { createOpfsRecordStorage } from '../data/opfsStorage.js';
import { ESK_STREAM_RATE, ESK_PACKED_RATE, requestEskDevice, type EskBank } from '../device/eskCapture.js';
import { downloadBoardTrace } from '../device/eskLanRecording.js';
import { openEskReplay } from './srLoad.js';
import { t } from './i18n.js';

import type { LiveReply, LiveRequest } from '../device/eskRecordWorker.js';

const MiB = 1024 * 1024;
export const displaySamples = 65536;
export interface SavedRecording {
  key: string;
  samples: number;
  summary?: string;
  read(start: number, end: number): Promise<Uint8Array>;
  dispose?(): void;
}
type Display = (bytes: Uint8Array, rate: number, start: number, name: string, saved?: SavedRecording) => void;

async function recordingRoot(): Promise<FileSystemDirectoryHandle> {
  return (await navigator.storage.getDirectory()).getDirectoryHandle('esk-recordings', { create: true });
}

async function withArchive<T>(name: string, action: () => Promise<T>): Promise<T> {
  return navigator.locks.request('xesk-recording-' + name, { ifAvailable: true }, async lock => {
    if (!lock) throw new Error(t('rec.busy'));
    return action();
  });
}

/** Let Stop interrupt a slow source's wait between blocks. */
function waitForBlock(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

export interface EskRecordingOptions { count: number; rate: number; bank: EskBank; ethernet?: boolean }
export function showEskRecorder(live: boolean, display: Display, confirmReplace: () => Promise<boolean>, removed: (key: string) => void, options?: EskRecordingOptions): void {
  const dialog = document.querySelector<HTMLDialogElement>('#esk-recorder')!;
  if (dialog.open) return;
  const get = <T extends HTMLElement>(id: string) => dialog.querySelector<T>('#rec-' + id)!;
  const source = get<HTMLInputElement>('source'), limit = get<HTMLInputElement>('limit');
  const record = get<HTMLButtonElement>('record'), stop = get<HTMLButtonElement>('stop');
  const archive = get<HTMLSelectElement>('archive'), first = get<HTMLInputElement>('first');
  const reopen = get<HTMLButtonElement>('reopen'), remove = get<HTMLButtonElement>('delete');
  const close = get<HTMLButtonElement>('close'), status = get<HTMLOutputElement>('status');
  const heading = get<HTMLElement>('heading');
  heading.dataset.i18n = live ? 'rec.live' : 'rec.title';
  heading.textContent = live ? t('rec.live') : t('rec.title');
  source.parentElement!.hidden = live;
  get<HTMLElement>('rate').hidden = !live || !!options;
  limit.parentElement!.hidden = !!options;
  record.hidden = !!options;
  let busy = false, abort: AbortController | null = null, ready = false;
  function update() {
    record.disabled = busy || !ready || (!live && !source.files?.length) || !limit.validity.valid;
    source.disabled = limit.disabled = archive.disabled = first.disabled = busy || !ready;
    stop.disabled = !abort || abort.signal.aborted;
    close.disabled = busy;
    reopen.disabled = busy || !archive.value || !first.validity.valid;
    remove.disabled = busy || !archive.value;
  }
  async function list(selected = archive.value) {
    const root = await recordingRoot();
    const names: string[] = [];
    for await (const entry of root.values()) if (entry.kind === 'directory') names.push(entry.name);
    archive.replaceChildren(...names.sort().reverse().map(name => new Option(name, name)));
    if (names.includes(selected)) archive.value = selected;
  }
  async function run(action: () => Promise<void>) {
    if (busy) return;
    busy = true; update();
    try { await action(); }
    catch (e) { status.value = e instanceof Error ? e.message : String(e); }
    finally { abort = null; busy = false; update(); }
  }
  function showSaved(bytes: Uint8Array, rate: number, start: number, title: string, key: string,
                     saved: RecordArchive, samples: number, summary = '') {
    display(bytes, rate, start, title, {
      key, samples, summary, read: (from, to) => withArchive(key, () => saved.readBytes(from, to)),
    });
  }
  const progress = (accepted: number, saved: number, queued: number) =>
    t('rec.progress', { accepted: accepted.toLocaleString(), saved: saved.toLocaleString(), queue: (queued / MiB).toFixed(1) });
  const startRecording = () => void run(async () => {
    const file = source.files?.[0];
    if (!live && !file) return;
    const device = live && !options?.ethernet ? await requestEskDevice() : null;
    if (!(await confirmReplace())) { if (options) dialog.close(); return; }
    const replay = live ? null : await openEskReplay(file!);
    const rate = replay?.rate ?? options?.rate ?? ESK_STREAM_RATE;
    const bank = options?.bank ?? 'lower';
    const title = options?.ethernet ? 'xLOGIC Ethernet' : live ? (rate === ESK_PACKED_RATE ? 'xLOGIC USB ' + (bank === 'upper' ? 'D4–D7' : 'D0–D3') : 'xLOGIC USB') : file!.name;
    const budget = options?.count ?? (limit.value ? limit.valueAsNumber * MiB : Infinity);
    if (budget !== Infinity && !Number.isSafeInteger(budget)) throw new Error(t('rec.invalidLimit'));
    if (live && Number.isFinite(budget) && navigator.storage?.estimate) {
      const {quota, usage} = await navigator.storage.estimate();
      if (quota !== undefined && usage !== undefined && budget > quota - usage) throw new Error(t('esk.storageFull'));
    }
    if (options?.ethernet) {
      abort = new AbortController();
      update();
      const saved = await downloadBoardTrace(budget, abort.signal, bytes => {
        status.value = progress(bytes, bytes, 0);
      });
      if (saved.samples) {
        const start = Math.max(0, saved.samples - displaySamples);
        try {
          const data = await saved.read(start, saved.samples);
          display(data, rate, start, title, {...saved, summary: status.value});
        } catch (error) { saved.dispose(); throw error; }
      } else saved.dispose();
      dialog.close();
      return;
    }
    const root = await recordingRoot();
    const name = new Date().toISOString().replace(/:/g, '-') + ' ' +
      title.replace(/[^\p{L}\p{N} ._-]/gu, '_').slice(0, 48) + ' ' + crypto.randomUUID().slice(0, 8);
    await withArchive(name, async () => {
      const dir = await root.getDirectoryHandle(name, { create: true });
      const signal = (abort = new AbortController()).signal;
      update();
      if (device) {
        const worker = new Worker(new URL('../device/eskRecordWorker.ts', import.meta.url), { type: 'module' });
        const send = (message: LiveRequest) => worker.postMessage(message);
        const stopWorker = () => send({ type: 'stop' });
        signal.addEventListener('abort', stopWorker, { once: true });
        let completed = false;
        try {
          const result = await new Promise<Extract<LiveReply, { type: 'end' }>>((resolve, reject) => {
            worker.onerror = e => reject(new Error(e.message));
            worker.onmessageerror = () => reject(new Error('Invalid USB recording worker response'));
            worker.onmessage = ({ data }: MessageEvent<LiveReply>) => {
              if (data.type === 'end') { resolve(data); return; }
              try {
                display(data.data, rate, data.accepted - data.data.length, title);
                status.value = progress(data.accepted, data.saved, data.queue);
              } finally { send({ type: 'displayed' }); }
            };
            send({ type: 'start', directory: dir, serial: device.serialNumber ?? '', limit: budget, rate, bank, title });
          });
          first.value = String(Math.max(0, result.saved - displaySamples));
          status.value = progress(result.accepted, result.saved, 0);
          if (result.error) throw new Error(result.error + ' · ' + status.value);
          if (result.wire !== undefined) status.value += ' · ' + t('rec.tail', { samples: (result.wire - BigInt(result.accepted)).toLocaleString() });
          if (result.accepted === budget) status.value = t('rec.atLimit') + ' · ' + status.value;
          // The last preview may have been skipped while the renderer was busy.
          if (result.saved) {
            const saved = new RecordArchive(await createOpfsRecordStorage(dir));
            const last = Number(first.value);
            showSaved(await saved.readBytes(last, result.saved), rate, last, title, name, saved, result.saved, status.value);
            completed = true;
          }
        } finally {
          signal.removeEventListener('abort', stopWorker);
          worker.terminate();
          await list(name);
        }
        if (completed) dialog.close();
        return;
      }
      if (!replay) return;
      const controller = new OpfsRecordController(await createOpfsRecordStorage(dir), {
        profile: { profileId: title, calibrationId: null, channels: 8, sampleRateHz: rate, bytesPerSample: 1 },
        maxBytes: budget,
      });
      let accepted = 0;
      let invalidReplay = false;
      let tail = new Uint8Array(0);
      function accept(sourceBlock: Uint8Array) {
        const block = sourceBlock.subarray(0, Math.min(sourceBlock.length, budget - accepted));
        controller.capture(block, { startSeconds: accepted / rate, endSeconds: (accepted + block.length) / rate });
        if (controller.lastError) throw new Error(controller.lastError);
        accepted += block.length;
        const n = Math.min(displaySamples, accepted);
        const next = new Uint8Array(n);
        const take = Math.min(n, block.length);
        if (take < n) next.set(tail.subarray(tail.length - (n - take)));
        next.set(block.subarray(block.length - take), n - take);
        tail = next;
        display(tail, rate, accepted - n, title);
        status.value = progress(accepted, controller.bytes, controller.queuedBytes);
      }
      try {
        controller.arm();
        await controller.whenIdle();
        if (controller.lastError) throw new Error(controller.lastError);
        let nextBlock = performance.now();
        for await (const sourceBlock of replay.blocks()) {
          // File replay can slow its producer without losing samples. Leave queue headroom
          // for the block being decoded and keep disk stalls from causing catch-up bursts.
          if (controller.queuedBytes >= 32 * MiB) {
            status.value = t('rec.draining', { saved: controller.bytes.toLocaleString() });
            await controller.whenIdle();
          }
          await waitForBlock(nextBlock - performance.now(), signal);
          if (controller.lastError) throw new Error(controller.lastError);
          if (signal.aborted) break;
          accept(sourceBlock);
          nextBlock = performance.now() + sourceBlock.length / rate * 1000;
          if (accepted === budget && accepted < replay.size) break;
        }
      } catch (error) {
        // A late ZIP checksum failure can invalidate blocks already written to this new archive.
        // Storage failures still leave a verified, readable prefix.
        if (!controller.lastError) { invalidReplay = true; throw error; }
      } finally {
        await controller.close();
        if (invalidReplay) await root.removeEntry(name, { recursive: true });
        first.value = String(Math.max(0, controller.bytes - displaySamples));
        await list(name);
        status.value = progress(accepted, controller.bytes, controller.queuedBytes);
      }
      if (controller.lastError) throw new Error(controller.lastError + ' · ' + status.value);
      if (accepted === budget && accepted < replay.size) status.value = t('rec.atLimit') + ' · ' + status.value;
      if (controller.bytes) {
        const saved = new RecordArchive(await createOpfsRecordStorage(dir));
        showSaved(tail, rate, accepted - tail.length, title, name, saved, controller.bytes, status.value);
        dialog.close();
      }
    });
  });
  record.onclick = startRecording;
  stop.onclick = () => { abort?.abort(); update(); };
  reopen.onclick = () => void run(async () => {
    if (!(await confirmReplace())) return;
    const name = archive.value;
    await withArchive(name, async () => {
      const dir = await (await recordingRoot()).getDirectoryHandle(name);
      const saved = new RecordArchive(await createOpfsRecordStorage(dir));
      let manifest = await saved.readManifest();
      if (manifest.status === 'open') manifest = (await saved.recover()).manifest;
      if (!manifest.bytes) throw new Error(t('rec.empty'));
      const start = Math.min(first.valueAsNumber, manifest.bytes - 1);
      first.value = String(start);
      const data = await saved.readBytes(start, Math.min(manifest.bytes, start + displaySamples));
      showSaved(data, manifest.profile.sampleRateHz, start, manifest.profile.profileId, name, saved, manifest.bytes);
      dialog.close();
      status.value = t('rec.range', { start, end: start + data.length - 1, total: manifest.bytes });
    });
  });
  remove.onclick = () => void run(async () => {
    const name = archive.value;
    if (!window.confirm(t('rec.confirmDelete', { name }))) return;
    await withArchive(name, async () => { await (await recordingRoot()).removeEntry(name, { recursive: true }); });
    removed(name);
    await list(); status.value = '';
  });
  archive.onchange = () => { first.value = '0'; update(); };
  source.onchange = first.oninput = limit.oninput = update;
  close.onclick = () => dialog.close();
  dialog.oncancel = event => { if (busy) { event.preventDefault(); abort?.abort(); update(); } };
  status.value = '';
  dialog.showModal();
  if (options) {
    ready = true;
    startRecording();
    return;
  }
  void run(async () => {
    if (!window.isSecureContext || !navigator.storage?.getDirectory || !navigator.locks) throw new Error(t('rec.unavailable'));
    await list(); ready = true;
  });
}
