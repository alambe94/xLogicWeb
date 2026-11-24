// SPDX-License-Identifier: GPL-3.0-or-later
import { selectedEskUsbDevice } from '../device/eskCapture.js';
import { displaySamples, type EskRecordingOptions, type RecordingDisplay } from './eskRecorder.js';
import { displayNativeRecording, listNativeRecordings, nativeRecordingTitle, nativeRequest, type NativeRecord } from './nativeArchive.js';

export async function recordNative(options: EskRecordingOptions, preview: RecordingDisplay, display: RecordingDisplay,
    setStop: (stop?: () => void) => void): Promise<void> {
  const status = document.querySelector<HTMLOutputElement>('#native-status')!;
  status.hidden = false;
  status.value = 'Starting USB recording…';
  try {
    let row = (await listNativeRecordings()).find(record => record.state === 'recording');
    if (!row) {
      const selected = selectedEskUsbDevice();
      if (selected && !selected.serialNumber) throw new Error('The selected USB board has no serial number for native recording');
      row = await (await nativeRequest('start', {rate: options.rate, bank: options.bank,
        samples: Number.isFinite(options.count) ? options.count : null, serial: selected?.serialNumber})).json();
    }
    if (!row) throw new Error('The recorder returned no recording');
    const id = row.id;
    let stopping = false, lastPreview = 0;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      status.value = 'Stopping USB recording…';
      try { await nativeRequest('stop', {id}); }
      catch (error) { status.value = String(error); stopping = false; }
    };
    setStop(stop);
    let previousFrame = performance.now(), nextStatus = 0;
    while (row.state === 'recording') {
      const now = performance.now();
      const advance = Math.round(row.rate * (now - previousFrame) / 1000);
      previousFrame = now;
      if (document.hidden || stopping) {
        row = await (await nativeRequest('status', {id})).json() as NativeRecord;
      } else {
        try {
          const response = await nativeRequest('status', {id, preview_after: lastPreview, advance});
          let data: Uint8Array | undefined, end = 0;
          if (response.headers.get('Content-Type') === 'application/octet-stream') {
            const buffer = await response.arrayBuffer(), header = new DataView(buffer);
            row.samples = Number(header.getBigUint64(0, true));
            end = Number(header.getBigUint64(8, true));
            data = new Uint8Array(buffer, 16);
          } else {
            row = await response.json() as NativeRecord;
            if (row.state === 'recording' && row.samples > lastPreview && advance > 0) {
              // Older native helpers return status and sample data in separate replies.
              end = row.samples;
              const start = Math.max(0, end - displaySamples);
              data = new Uint8Array(await (await nativeRequest('preview', {id, start, end})).arrayBuffer());
            }
          }
          if (data && !document.hidden && !stopping) {
            if (!Number.isSafeInteger(end) || end <= lastPreview || end > row.samples ||
                data.length !== Math.min(end, displaySamples)) throw new Error('Incomplete preview');
            preview(data, row.rate, end - data.length, nativeRecordingTitle(row));
            lastPreview = end;
          }
        } catch {
          row = await (await nativeRequest('status', {id})).json() as NativeRecord;
          if (!stopping) {
            status.value = 'Live preview unavailable';
            nextStatus = now + 250;
          }
        }
      }
      if (row.state !== 'recording') break;
      if (!stopping && now >= nextStatus) {
        status.value = 'Live preview · ' + row.samples.toLocaleString() + ' samples on disk';
        nextStatus = now + 250;
      }
      // One read in flight. Include the time spent reading and preparing the frame.
      const interval = document.hidden || stopping ? 250 : 1000 / 60;
      await new Promise(resolve => setTimeout(resolve, Math.max(0, now + interval - performance.now())));
    }
    await displayNativeRecording(row, display, displaySamples);
  } finally { setStop(); status.hidden = true; }
}
