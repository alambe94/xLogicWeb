// SPDX-License-Identifier: GPL-3.0-or-later
import { receiveBoardCapture } from './eskPairedBoard.js';
import type { DdrTrigger } from './eskDdrTrigger.js';

function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('Browser storage write interrupted'));
  });
}

/** The HTTP board embeds the viewer. IndexedDB also works in that insecure ancestor context. */
export async function downloadBoardTrace(count: number, rate: number, signal: AbortSignal, progress: (bytes: number, block: Uint8Array) => void, trigger?: DdrTrigger) {
  const id = Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16)).join('-');
  const key = 'xesk-ethernet-' + id;
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(key, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('blocks');
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  let samples = 0;
  let pendingWrite: Promise<void> | undefined;
  const dispose = () => {
    window.removeEventListener('pagehide', leave);
    db.close();
    indexedDB.deleteDatabase(key);
  };
  const leave = (event: PageTransitionEvent) => { if (!event.persisted) dispose(); };
  window.addEventListener('pagehide', leave);
  try {
    await receiveBoardCapture(count, signal, async (block, offset) => {
      const tx = db.transaction('blocks', 'readwrite');
      tx.objectStore('blocks').add(block, offset);
      pendingWrite = committed(tx).then(() => {
        samples += block.length;
        progress(samples, block);
      });
      await pendingWrite;
    }, rate, trigger);
  } catch (error) {
    if (!signal.aborted) { dispose(); throw error; }
    // Stop can arrive between the last IndexedDB add and its commit.
    try { await pendingWrite; } catch (writeError) { dispose(); throw writeError; }
  }
  const read = (start: number, end: number): Promise<Uint8Array> => {
    if (!(start >= 0 && start < end && end <= samples)) return Promise.reject(new RangeError('Invalid sample window'));
    return new Promise((resolve, reject) => {
      const tx = db.transaction('blocks');
      const result = new Uint8Array(end - start);
      let filled = 0;
      // Include a block that starts before the requested window.
      const range = IDBKeyRange.bound(Math.max(0, start - 32767), end, false, true);
      const cursor = tx.objectStore('blocks').openCursor(range);
      cursor.onsuccess = () => {
        const entry = cursor.result;
        if (!entry) return;
        const offset = Number(entry.key), block: Uint8Array = entry.value;
        const from = Math.max(start, offset), to = Math.min(end, offset + block.length);
        if (to > from) {
          result.set(block.subarray(from - offset, to - offset), from - start);
          filled += to - from;
        }
        entry.continue();
      };
      tx.onabort = () => reject(tx.error ?? new Error('Browser storage read interrupted'));
      tx.oncomplete = () => filled === result.length ? resolve(result) : reject(new Error('Incomplete sample window'));
    });
  };
  return {key, samples, read, dispose};
}
