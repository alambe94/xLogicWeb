// SPDX-License-Identifier: GPL-3.0-or-later
const key = 'xesk.archiveLimitGiB';
const gib = 2 ** 30;

export async function browserArchiveSpace() {
  const stored = localStorage.getItem(key);
  const limit = stored === null ? null : Number(stored);
  const budget = limit !== null && Number.isSafeInteger(limit) && limit >= 1 ? limit * gib : null;
  const {quota, usage} = await navigator.storage.estimate();
  const free = quota === undefined ? Infinity : Math.max(0, quota - (usage ?? 0));
  let used = 0;
  async function measure(dir: FileSystemDirectoryHandle) {
    for await (const handle of dir.values()) {
      if (handle.kind === 'directory') await measure(handle as FileSystemDirectoryHandle);
      else used += (await (handle as FileSystemFileHandle).getFile()).size;
    }
  }
  const root = await navigator.storage.getDirectory();
  await measure(await root.getDirectoryHandle('esk-recordings', {create: true}));
  return {budget, launchBudget: null, available: Math.min(free, budget === null ? Infinity : Math.max(0, budget - used)), used};
}

export async function withBrowserWriter<T>(work: () => Promise<T>): Promise<T> {
  return navigator.locks.request('xesk-browser-archive-writer', {ifAvailable: true}, async lock => {
    if (!lock) throw Error('A browser recording is already in progress.');
    return work();
  });
}

export async function setBrowserLimit(value: number | null) {
  return withBrowserWriter(async () => {
    if (value !== null && (!Number.isSafeInteger(value) || value < 1 || !Number.isSafeInteger(value * gib)))
      throw Error('Enter a whole number of GiB.');
    if (value !== null && value * gib < (await browserArchiveSpace()).used)
      throw Error('Limit is below the size of saved recordings.');
    if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, String(value));
    return browserArchiveSpace();
  });
}
