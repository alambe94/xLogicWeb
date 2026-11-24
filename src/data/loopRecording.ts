// SPDX-License-Identifier: GPL-3.0-or-later
export interface LoopManifest { capacity: number; total: number; rate: number; title: string }

interface SyncSink {
  write(data: Uint8Array, options: {at: number}): number;
  flush(): void;
  close(): void;
}

export class LoopRecording {
  total = 0;
  constructor(private readonly file: SyncSink, readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw Error('Invalid loop length');
  }

  append(bytes: Uint8Array): void {
    const end = this.total + bytes.length;
    if (!Number.isSafeInteger(end)) throw Error('Loop sample counter exceeded');
    const length = Math.min(bytes.length, this.capacity);
    const at = (end - length) % this.capacity;
    const first = Math.min(length, this.capacity - at);
    const tail = bytes.subarray(bytes.length - length);
    if (this.file.write(tail.subarray(0, first), {at}) !== first ||
        (first < length && this.file.write(tail.subarray(first), {at: 0}) !== length - first)) {
      throw Error('Incomplete loop write');
    }
    this.total = end;
  }

  close(): void { try { this.file.flush(); } finally { this.file.close(); } }
}

export function createMemoryLoop(capacity: number) {
  let memory: Uint8Array<ArrayBuffer>;
  try { memory = new Uint8Array(capacity); }
  catch { throw Error('Could not allocate the RAM loop. Reduce Samples or select disk in Storage.'); }
  const ring = new LoopRecording({
    write(block, {at}) { memory.set(block, at); return block.length; },
    close() {}, flush() {},
  }, capacity);
  return {memory, ring};
}

export async function createLoop(dir: FileSystemDirectoryHandle, capacity: number): Promise<LoopRecording> {
  const file = await dir.getFileHandle('loop.bin', {create: true});
  const sync = await (file as FileSystemFileHandle & {createSyncAccessHandle(): Promise<SyncSink>}).createSyncAccessHandle();
  return new LoopRecording(sync, capacity);
}

export async function finishLoop(dir: FileSystemDirectoryHandle, meta: LoopManifest): Promise<void> {
  const file = await dir.getFileHandle('loop.json', {create: true});
  const stream = await file.createWritable();
  await stream.write(JSON.stringify(meta));
  await stream.close();
}

export async function openLoop(dir: FileSystemDirectoryHandle) {
  let manifest: FileSystemFileHandle;
  try { manifest = await dir.getFileHandle('loop.json'); }
  catch (err) { if (err instanceof DOMException && err.name === 'NotFoundError') return null; throw err; }
  const meta: LoopManifest = JSON.parse(await (await manifest.getFile()).text());
  const {capacity, total, rate, title} = meta;
  const samples = Math.min(capacity, total);
  const file = await (await dir.getFileHandle('loop.bin')).getFile();
  if (![capacity, total, rate].every(n => Number.isSafeInteger(n) && n > 0) || typeof title !== 'string' || file.size !== samples)
    throw Error('Incomplete loop recording');
  return {samples, rate, title, async read(start: number, end: number) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > samples)
      throw Error('Invalid loop window');
    const pos = (total - samples + start) % capacity;
    const first = Math.min(end - start, capacity - pos);
    const head = file.slice(pos, pos + first);
    const blob = first === end - start ? head : new Blob([head, file.slice(0, end - start - first)]);
    return new Uint8Array(await blob.arrayBuffer());
  }};
}
