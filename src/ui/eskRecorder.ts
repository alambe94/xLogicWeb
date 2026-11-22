// SPDX-License-Identifier: GPL-3.0-or-later
import { OpfsRecordController, RecordArchive } from '../data/recordController.js';
import { createOpfsRecordStorage } from '../data/opfsStorage.js';
import { openEskReplay } from './srLoad.js';
import { t } from './i18n.js';

const MiB = 1024 * 1024;
const displaySamples = 65536;
type Display = (bytes: Uint8Array, rate: number, start: number, name: string) => void;

async function recordingRoot(): Promise<FileSystemDirectoryHandle> {
  return (await navigator.storage.getDirectory()).getDirectoryHandle('esk-recordings', { create: true });
}

async function withArchive(name: string, action: () => Promise<void>): Promise<void> {
  await navigator.locks.request('xesk-recording-' + name, { ifAvailable: true }, async lock => {
    if (!lock) throw new Error(t('rec.busy'));
    await action();
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

export function showEskRecorder(display: Display, confirmReplace: () => Promise<boolean>): void {
  const dialog = document.querySelector<HTMLDialogElement>('#esk-recorder')!;
  if (dialog.open) return;
  const get = <T extends HTMLElement>(id: string) => dialog.querySelector<T>('#rec-' + id)!;
  const source = get<HTMLInputElement>('source'), limit = get<HTMLInputElement>('limit');
  const record = get<HTMLButtonElement>('record'), stop = get<HTMLButtonElement>('stop');
  const archive = get<HTMLSelectElement>('archive'), first = get<HTMLInputElement>('first');
  const reopen = get<HTMLButtonElement>('reopen'), remove = get<HTMLButtonElement>('delete');
  const close = get<HTMLButtonElement>('close'), status = get<HTMLOutputElement>('status');
  let busy = false, abort: AbortController | null = null, ready = false;
  function update() {
    record.disabled = busy || !ready || !source.files?.length || !limit.validity.valid;
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
  const progress = (accepted: number, saved: number, queued: number) =>
    t('rec.progress', { accepted: accepted.toLocaleString(), saved: saved.toLocaleString(), queue: (queued / MiB).toFixed(1) });
  record.onclick = () => void run(async () => {
    const file = source.files?.[0];
    if (!file || !(await confirmReplace())) return;
    const replay = await openEskReplay(file);
    const budget = limit.value ? limit.valueAsNumber * MiB : Infinity;
    if (budget !== Infinity && !Number.isSafeInteger(budget)) throw new Error(t('rec.invalidLimit'));
    const root = await recordingRoot();
    const name = new Date().toISOString().replace(/:/g, '-') + ' ' +
      file.name.replace(/[^\p{L}\p{N} ._-]/gu, '_').slice(0, 48) + ' ' + crypto.randomUUID().slice(0, 8);
    await withArchive(name, async () => {
      const dir = await root.getDirectoryHandle(name, { create: true });
      const controller = new OpfsRecordController(await createOpfsRecordStorage(dir), {
        profile: { profileId: file.name, calibrationId: null, channels: 8, sampleRateHz: replay.rate, bytesPerSample: 1 },
        maxBytes: budget,
      });
      let accepted = 0;
      let invalidReplay = false;
      const signal = (abort = new AbortController()).signal;
      update();
      try {
        controller.arm();
        await controller.whenIdle();
        if (controller.lastError) throw new Error(controller.lastError);
        let nextBlock = performance.now();
        let tail = new Uint8Array(0);
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
          const block = sourceBlock.subarray(0, Math.min(sourceBlock.length, budget - accepted));
          nextBlock = performance.now() + block.length / replay.rate * 1000;
          controller.capture(block, { startSeconds: accepted / replay.rate, endSeconds: (accepted + block.length) / replay.rate });
          if (controller.lastError) throw new Error(controller.lastError);
          accepted += block.length;
          const n = Math.min(displaySamples, accepted);
          const next = new Uint8Array(n);
          const take = Math.min(n, block.length);
          if (take < n) next.set(tail.subarray(tail.length - (n - take)));
          next.set(block.subarray(block.length - take), n - take);
          tail = next;
          display(tail, replay.rate, accepted - n, file.name);
          status.value = progress(accepted, controller.bytes, controller.queuedBytes);
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
    });
  });
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
      display(data, manifest.profile.sampleRateHz, start, manifest.profile.profileId);
      status.value = t('rec.range', { start, end: start + data.length - 1, total: manifest.bytes });
    });
  });
  remove.onclick = () => void run(async () => {
    const name = archive.value;
    if (!window.confirm(t('rec.confirmDelete', { name }))) return;
    await withArchive(name, async () => { await (await recordingRoot()).removeEntry(name, { recursive: true }); });
    await list(); status.value = '';
  });
  archive.onchange = () => { first.value = '0'; update(); };
  source.onchange = first.oninput = limit.oninput = update;
  close.onclick = () => dialog.close();
  dialog.oncancel = event => { if (busy) { event.preventDefault(); abort?.abort(); update(); } };
  status.value = '';
  dialog.showModal();
  void run(async () => {
    if (!window.isSecureContext || !navigator.storage?.getDirectory || !navigator.locks) throw new Error(t('rec.unavailable'));
    await list(); ready = true;
  });
}
