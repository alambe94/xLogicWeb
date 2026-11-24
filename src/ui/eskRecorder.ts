// SPDX-License-Identifier: GPL-3.0-or-later
import { OpfsRecordController, RecordArchive } from '../data/recordController.js';
import { createOpfsRecordStorage } from '../data/opfsStorage.js';
import { ESK_STREAM_RATE, ESK_PACKED_RATE, requestEskDevice, type EskBank } from '../device/eskCapture.js';
import { downloadBoardTrace } from '../device/eskLanRecording.js';
import { receiveUsbDdr } from '../device/eskUsbDdr.js';
import { openEskReplay } from './srLoad.js';
import { selectControl } from './select.js';
import type { ConfirmDialog } from './confirmDialog.js';
import { t } from './i18n.js';
import { displayNativeRecording, listNativeRecordings, nativeRecorderAvailable, nativeRequest, type NativeRecord } from './nativeArchive.js';
import { browserArchiveSpace, loopRamMiB, withBrowserWriter } from './browserArchiveSpace.js';
import { finishLoop, openLoop, type LoopManifest } from '../data/loopRecording.js';
import { formatBytes } from './format.js';

import type { LiveReply, LiveRequest } from '../device/eskRecordWorker.js';

const MiB = 1024 * 1024;
export const displaySamples = 65536;
export interface StoredRecording { key: string; name: string; source: 'native' | 'browser' }
export interface SavedRecording {
  readSize?: number;
  key: string;
  stored?: StoredRecording;
  samples: number;
  summary?: string;
  read(start: number, end: number): Promise<Uint8Array>;
  edge?(position: number, channel: number, direction: 'previous' | 'next'): Promise<{match: number | null; resume: number | null}>;
  persist?(): Promise<void>;
  dispose?(): void;
}
export type RecordingDisplay = (bytes: Uint8Array, rate: number, start: number, name: string, saved?: SavedRecording) => void;

function ramRecording(key: string, memory: Uint8Array | undefined, meta: LoopManifest): SavedRecording {
  const samples = Math.min(meta.total, meta.capacity);
  const saved: SavedRecording = {
    key, samples,
    async read(start, end) {
      if (!memory || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
          start < 0 || end < start || end > samples) throw Error('Invalid RAM loop window');
      const pos = (meta.total - samples + start) % meta.capacity;
      const size = end - start, head = Math.min(size, meta.capacity - pos);
      const bytes = new Uint8Array(size);
      bytes.set(memory.subarray(pos, pos + head));
      if (head < size) bytes.set(memory.subarray(0, size - head), head);
      return bytes;
    },
    async persist() {
      await withBrowserWriter(() => withArchive(key, async () => {
        if (!memory || saved.stored) return;
        if ((await browserArchiveSpace()).available < samples) throw Error(t('esk.storageFull'));
        const root = await recordingRoot();
        const dir = await root.getDirectoryHandle(key, {create: true});
        try {
          const file = await dir.getFileHandle('loop.bin', {create: true});
          const output = await file.createWritable();
          try {
            for (let i = 0; i < samples; i += MiB) await output.write(memory.slice(i, Math.min(i + MiB, samples)));
            await output.close();
          } catch (err) { await output.abort().catch(() => {}); throw err; }
          await finishLoop(dir, meta);
          const disk = await openLoop(dir);
          if (!disk) throw Error('Could not reopen saved loop');
          saved.read = (a, b) => withArchive(key, () => disk.read(a, b));
          saved.stored = {key, name: key, source: 'browser'};
          delete saved.persist;
          memory = undefined;
        } catch (err) { await root.removeEntry(key, {recursive: true}); throw err; }
      }));
    },
    dispose() { memory = undefined; },
  };
  return saved;
}

async function recordingRoot(): Promise<FileSystemDirectoryHandle> {
  return (await navigator.storage.getDirectory()).getDirectoryHandle('esk-recordings', { create: true });
}

async function withArchive<T>(name: string, action: () => Promise<T>): Promise<T> {
  return navigator.locks.request('xesk-recording-' + name, { ifAvailable: true }, async lock => {
    if (!lock) throw new Error(t('rec.busy'));
    return action();
  });
}

export function deletionPrompt(record: StoredRecording): string {
  return t(record.source === 'native' ? 'rec.confirmNativeDelete' : 'rec.confirmDelete', { name: record.name });
}

export async function removeStoredRecording(record: StoredRecording): Promise<void> {
  if (record.source === 'native') await nativeRequest('delete', {id: record.key});
  else await withArchive(record.key, async () => (await recordingRoot()).removeEntry(record.key, {recursive: true}));
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

export interface EskRecordingOptions { count: number; rate: number; bank: EskBank; ethernet?: boolean; usbDdr?: boolean; loop?: boolean }
type DownloadPreview = (count: number, rate: number) => {append(block: Uint8Array): void; close(): void};
export function showEskRecorder(live: boolean, display: RecordingDisplay, confirmation: ConfirmDialog, confirmReplace: () => Promise<boolean>, removed: (key: string) => void, options?: EskRecordingOptions, captureChanged = () => false, downloadPreview?: DownloadPreview): void {
  const dialog = document.querySelector<HTMLDialogElement>('#esk-recorder')!;
  if (dialog.open) return;
  const get = <T extends HTMLElement>(id: string) => dialog.querySelector<T>('#rec-' + id)!;
  const source = get<HTMLInputElement>('source'), limit = get<HTMLInputElement>('limit');
  const record = get<HTMLButtonElement>('record'), stop = get<HTMLButtonElement>('stop');
  const archiveHost = get('archive'), first = get<HTMLInputElement>('first');
  let archive = selectControl('rec-archive', t('rec.archive'), [], '');
  archiveHost.replaceChildren(archive.el);
  const reopen = get<HTMLButtonElement>('reopen'), remove = get<HTMLButtonElement>('delete');
  const close = get<HTMLButtonElement>('close'), status = get<HTMLOutputElement>('status');
  const heading = get<HTMLElement>('heading');
  const titleKey = options?.ethernet ? 'rec.ethernet' : options?.usbDdr ? 'rec.usbFinite' : live ? 'rec.live' : 'rec.title';
  heading.dataset.i18n = titleKey;
  heading.textContent = t(titleKey);
  const importer = get<HTMLDetailsElement>('import');
  importer.hidden = live;
  importer.open = false;
  get('library').hidden = live;
  first.value = '';
  const nativeRows = new Map<string, NativeRecord>();
  const diskSpace = get('storage');
  diskSpace.textContent = '';
  const warnings = get<HTMLOutputElement>('warnings');
  warnings.value = '';
  let canImport = false;
  get<HTMLElement>('rate').hidden = !live || !!options;
  limit.parentElement!.hidden = !!options;
  record.hidden = !!options;
  let busy = false, abort: AbortController | null = null, ready = false;
  function update() {
    record.disabled = busy || !ready || (!live && (!canImport || !source.files?.length)) || !limit.validity.valid;
    source.disabled = limit.disabled = first.disabled = busy || !ready;
    archive.disabled = busy || !ready || !archive.value;
    stop.hidden = !live && !abort;
    stop.disabled = !abort || abort.signal.aborted;
    close.disabled = busy;
    const native = nativeRows.get(archive.value);
    reopen.disabled = busy || !archive.value || !first.validity.valid || (!!native && native.state !== 'saved');
    remove.disabled = busy || !archive.value;
  }
  async function list(selected = archive.value) {
    if (live) return;
    const choices: [string, string][] = [];
    const errors: string[] = [];
    nativeRows.clear();
    if (nativeRecorderAvailable()) {
      try {
        for (const row of await listNativeRecordings()) {
          if (row.state === 'recording') continue;
          const key = 'native:' + row.id;
          nativeRows.set(key, row);
          choices.push([key, row.title + (row.volatile ? ' · RAM' : '') + ' · ' + row.samples.toLocaleString() + ' samples · ' +
            formatBytes(row.bytes ?? 0) + (row.state === 'failed' ? ' · ' + (row.note || 'Failed') : '')]);
        }
        const space = await (await nativeRequest('storage')).json();
        const quota = space.budget == null ? '' : ' · ' + space.budget / 2 ** 30 + ' GiB archive limit';
        diskSpace.textContent = (space.available / 2 ** 30).toFixed(2) + ' GiB available' + quota;
      } catch (error) { errors.push(String(error)); }
    }
    try {
      if (!navigator.locks || !navigator.storage?.getDirectory) throw new Error(t('rec.unavailable'));
      const names: string[] = [];
      for await (const entry of (await recordingRoot()).values()) if (entry.kind === 'directory') names.push(entry.name);
      for (const name of names.sort().reverse()) choices.push(['browser:' + name, name]);
      canImport = true;
    } catch (error) { canImport = false; errors.push(String(error)); }
    warnings.value = errors.join(' · ');
    archive = selectControl('rec-archive', t('rec.archive'), choices,
      choices.some(([key]) => key === selected) ? selected : choices[0]?.[0] ?? '');
    function select() {
      const row = nativeRows.get(archive.value);
      first.value = row ? String(Math.max(0, row.samples - displaySamples)) : '0';
      update();
    }
    archive.addEventListener('change', select);
    archiveHost.replaceChildren(archive.el);
    select();
    if (!choices.length && !errors.length) status.value = t('rec.noSaved');
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
      key, stored: {key, name: key, source: 'browser'}, samples, summary,
      read: (from, to) => withArchive(key, () => saved.readBytes(from, to)),
    });
  }
  async function displayLoop(dir: FileSystemDirectoryHandle, key: string, firstSample: number, summary = '') {
    const saved = await openLoop(dir);
    if (!saved) return false;
    const start = Math.max(0, Math.min(firstSample, saved.samples - 1));
    const bytes = await saved.read(start, Math.min(start + displaySamples, saved.samples));
    display(bytes, saved.rate, start, saved.title, {key, samples: saved.samples, summary,
      stored: {key, name: key, source: 'browser'}, read: (from,to) => withArchive(key, () => saved.read(from,to))});
    return true;
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
    const title = options?.ethernet ? 'xLOGIC Ethernet' : options?.usbDdr ? 'xLOGIC USB D0–D7' : live ? (rate === ESK_PACKED_RATE ? 'xLOGIC USB ' + (bank === 'upper' ? 'D4–D7' : 'D0–D3') : 'xLOGIC USB') : file!.name;
    let budget = options?.count ?? (limit.value ? limit.valueAsNumber * MiB : Infinity);
    if (budget !== Infinity && !Number.isSafeInteger(budget)) throw new Error(t('rec.invalidLimit'));
    const ram = !!(device && options?.loop && budget <= loopRamMiB() * MiB);
    if (!ram && live && Number.isFinite(budget) && navigator.storage?.estimate) {
      const {quota, usage} = await navigator.storage.estimate();
      if (quota !== undefined && usage !== undefined && budget > quota - usage) throw new Error(t('esk.storageFull'));
    }
    if (options?.ethernet) {
      abort = new AbortController();
      update();
      const preview = downloadPreview?.(budget, rate);
      const saved = await downloadBoardTrace(budget, rate, abort.signal, (bytes, block) => {
        preview?.append(block);
        status.value = progress(bytes, bytes, 0);
      }).finally(() => preview?.close());
      if (saved.samples) {
        const start = Math.max(0, saved.samples - displaySamples);
        try {
          const data = await saved.read(start, saved.samples);
          if (captureChanged() && !(await confirmReplace())) {
            saved.dispose();
            dialog.close();
            return;
          }
          display(data, rate, start, title, {...saved, summary: status.value});
        } catch (error) { saved.dispose(); throw error; }
      } else saved.dispose();
      dialog.close();
      return;
    }
    const name = new Date().toISOString().replace(/:/g, '-') + ' ' +
      title.replace(/[^\p{L}\p{N} ._-]/gu, '_').slice(0, 48) + ' ' + crypto.randomUUID().slice(0, 8);
    await withBrowserWriter(() => withArchive(name, async () => {
      const available = ram ? Infinity : (await browserArchiveSpace()).available;
      if (budget === Infinity) budget = Math.floor(available);
      if (budget < 1 || budget > available) throw Error(t('esk.storageFull'));
      const dir = ram ? undefined : await (await recordingRoot()).getDirectoryHandle(name, { create: true });
      const signal = (abort = new AbortController()).signal;
      update();
      if (device && options?.usbDdr) {
        const storage = await createOpfsRecordStorage(dir!);
        const writer = new OpfsRecordController(storage, {profile: {profileId: title, calibrationId: null,
          channels: 8, sampleRateHz: rate, bytesPerSample: 1}, maxBytes: budget});
        const preview = downloadPreview?.(budget, rate);
        const staging = new Uint8Array(Math.min(budget, 4 * MiB));
        let used = 0, saved = 0;
        async function flush() {
          if (!used) return;
          writer.capture(staging.subarray(0, used), {startSeconds: saved / rate, endSeconds: (saved + used) / rate});
          await writer.whenIdle();
          if (writer.lastError) throw new Error(writer.lastError);
          saved += used; used = 0;
        }
        let keep = false;
        try {
          writer.arm();
          await writer.whenIdle();
          if (writer.lastError) throw new Error(writer.lastError);
          try {
            await receiveUsbDdr(device, budget, signal, async block => {
              let offset = 0;
              while (offset < block.length) {
                const n = Math.min(staging.length - used, block.length - offset);
                staging.set(block.subarray(offset, offset + n), used); used += n; offset += n;
                if (used === staging.length) await flush();
              }
              preview?.append(block);
              status.value = progress(saved + used, saved, used);
            });
          } catch (error) { if (!signal.aborted || error !== signal.reason) throw error; }
          await flush();
          await writer.close();
          if (writer.lastError) throw new Error(writer.lastError);
          if (saved && (!captureChanged() || await confirmReplace())) {
            const archive = new RecordArchive(storage), start = Math.max(0, saved - displaySamples);
            showSaved(await archive.readBytes(start, saved), rate, start, title, name, archive, saved, progress(saved, saved, 0));
            keep = true;
          }
          dialog.close();
        } finally {
          preview?.close();
          if (!keep) {
            try { await writer.close(); }
            finally { await (await recordingRoot()).removeEntry(name, {recursive: true}); }
          }
        }
        return;
      }
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
            send({ type: 'start', directory: dir, ram, serial: device.serialNumber ?? '', limit: budget, rate, bank, title, loop: !!options?.loop });
          });
          first.value = String(Math.max(0, result.saved - displaySamples));
          status.value = progress(result.accepted, result.saved, 0);
          if (result.error) throw new Error(result.error + ' · ' + status.value);
          if (result.wire !== undefined) status.value += ' · ' + t('rec.tail', { samples: (result.wire - BigInt(result.accepted)).toLocaleString() });
          if (!options?.loop && result.accepted === budget) status.value = t('rec.atLimit') + ' · ' + status.value;
          // The last preview may have been skipped while the renderer was busy.
          if (result.saved && result.memory) {
            const saved = ramRecording(name, result.memory, {capacity: budget, total: result.accepted, title, rate});
            const start = Number(first.value);
            display(await saved.read(start, saved.samples), rate, start, title, saved);
            completed = true;
          } else if (result.saved && options?.loop) {
            completed = await displayLoop(dir!, name, Number(first.value), status.value);
            if (!completed) throw Error('Loop recording did not finalize');
          } else if (result.saved) {
            const saved = new RecordArchive(await createOpfsRecordStorage(dir!));
            const last = Number(first.value);
            showSaved(await saved.readBytes(last, result.saved), rate, last, title, name, saved, result.saved, status.value);
            completed = true;
          }
        } finally {
          signal.removeEventListener('abort', stopWorker);
          worker.terminate();
          await list('browser:' + name);
        }
        if (completed) dialog.close();
        return;
      }
      if (!replay) return;
      const controller = new OpfsRecordController(await createOpfsRecordStorage(dir!), {
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
        if (invalidReplay) await (await recordingRoot()).removeEntry(name, { recursive: true });
        first.value = String(Math.max(0, controller.bytes - displaySamples));
        await list('browser:' + name);
        status.value = progress(accepted, controller.bytes, controller.queuedBytes);
      }
      if (controller.lastError) throw new Error(controller.lastError + ' · ' + status.value);
      if (accepted === budget && accepted < replay.size) status.value = t('rec.atLimit') + ' · ' + status.value;
      if (controller.bytes) {
        const saved = new RecordArchive(await createOpfsRecordStorage(dir!));
        showSaved(tail, rate, accepted - tail.length, title, name, saved, controller.bytes, status.value);
        dialog.close();
      }
    }));
  });
  record.onclick = startRecording;
  stop.onclick = () => { abort?.abort(); update(); };
  reopen.onclick = () => void run(async () => {
    if (!(await confirmReplace())) return;
    const row = nativeRows.get(archive.value);
    if (row) {
      await displayNativeRecording(row, display, displaySamples, first.valueAsNumber);
      dialog.close();
      return;
    }
    const name = archive.value.slice('browser:'.length);
    await withArchive(name, async () => {
      const dir = await (await recordingRoot()).getDirectoryHandle(name);
      if (await displayLoop(dir, name, first.valueAsNumber)) { dialog.close(); return; }
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
  remove.onclick = async () => {
    const row = nativeRows.get(archive.value);
    const name = row?.title ?? archive.value.slice('browser:'.length);
    const target: StoredRecording = {key: row?.id ?? name, name, source: row ? 'native' : 'browser'};
    if (!await confirmation.ask({title: t('rec.delete'), body: deletionPrompt(target),
      confirm: t('rec.delete'), cancel: t('reset.cancel')}, remove)) return;
    await run(async () => {
      await removeStoredRecording(target);
      removed(target.key);
      status.value = '';
      await list();
    });
  };
  source.onchange = first.oninput = limit.oninput = update;
  close.onclick = () => dialog.close();
  dialog.oncancel = event => { if (busy) { event.preventDefault(); abort?.abort(); update(); } };
  status.value = '';
  if (options?.ethernet || options?.usbDdr) dialog.show();
  else dialog.showModal();
  if (options) {
    ready = true;
    startRecording();
    return;
  }
  void run(async () => {
    await list(); ready = true;
  });
}
