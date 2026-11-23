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
    while (row.state === 'recording') {
      if (!stopping) status.value = 'Live preview · ' + row.samples.toLocaleString() + ' samples on disk';
      if (row.samples > lastPreview && !document.hidden && !stopping) {
        const end = row.samples, start = Math.max(0, end - displaySamples);
        try {
          const data = new Uint8Array(await (await nativeRequest('preview', {id, start, end})).arrayBuffer());
          if (data.length !== end - start) throw new Error('Incomplete preview');
          preview(data, row.rate, start, nativeRecordingTitle(row));
          lastPreview = end;
        } catch { status.value += ' · Preview unavailable'; }
      }
      await new Promise(resolve => setTimeout(resolve, 250));
      row = await (await nativeRequest('status', {id})).json() as NativeRecord;
    }
    await displayNativeRecording(row, display, displaySamples);
  } finally { setStop(); status.hidden = true; }
}
