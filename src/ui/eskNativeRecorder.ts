// SPDX-License-Identifier: GPL-3.0-or-later
import { loopRamMiB } from './browserArchiveSpace.js';
import { selectedEskUsbDevice } from '../device/eskCapture.js';
import { displaySamples, type EskRecordingOptions, type RecordingDisplay } from './eskRecorder.js';
import { displayNativeRecording, listNativeRecordings, nativeRecordingTitle, nativeRequest, type NativeRecord } from './nativeArchive.js';
import type { ActivityFrame } from './recordingActivity.js';

export async function recordNative(options: EskRecordingOptions, preview: RecordingDisplay, display: RecordingDisplay,
    setStop: (stop?: () => void) => void, activity: (frame: ActivityFrame) => void): Promise<void> {
  const status = document.querySelector<HTMLOutputElement>('#native-status')!;
  status.hidden = false;
  status.value = 'Starting USB recording…';
  try {
    let row = (await listNativeRecordings()).find(record => record.state === 'recording');
    if (options.loop && !document.querySelector('meta[name="esk-native-recorder"][data-loop]'))
      throw new Error('Update the local xEskWeb recorder to use Loop.');
    if (row && (Boolean(row.loop) !== Boolean(options.loop) || (options.loop && row.limit !== options.count)))
      throw Error('Another recording is active with different retention settings.');
    if (!row) {
      const selected = selectedEskUsbDevice();
      if (selected && !selected.serialNumber) throw new Error('The selected USB board has no serial number for native recording');
      row = await (await nativeRequest('start', {rate: options.rate, bank: options.bank,
        samples: Number.isFinite(options.count) ? options.count : null, loop: options.loop === true,
        ramMiB: options.loop && document.querySelector('[data-ram-loop]') ? loopRamMiB() : 0, serial: selected?.serialNumber})).json();
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
    if (document.querySelector('meta[name="esk-native-recorder"][data-overview]')) {
      let cursor = 0, nextStatus = 0;
      for (;;) {
        const now = performance.now();
        if (document.hidden && row.state === 'recording') {
          await new Promise(resolve => setTimeout(resolve, 250));
          row = await (await nativeRequest('status', {id})).json() as NativeRecord;
          if (row.state === 'recording') continue;
        }
        let frame: ActivityFrame;
        try {
          frame = await (await nativeRequest('overview', {id, start: cursor})).json();
        } catch {
          row = await (await nativeRequest('status', {id})).json() as NativeRecord;
          if (row.state !== 'recording') break;
          if (!stopping) status.value = 'Live preview unavailable';
          await new Promise(resolve => setTimeout(resolve, 250));
          continue;
        }
        row = frame.record;
        if (row.state === 'failed') throw new Error(row.note);
        if (row.state === 'saved' && row.loop) break;
        activity(frame);
        cursor = frame.end;
        if (row.state === 'saved' && cursor === row.samples) break;
        if (!stopping && now >= nextStatus) {
          status.value = 'Live preview · ' + row.samples.toLocaleString() + (row.loop ? ' samples captured · retaining latest ' + row.limit?.toLocaleString() : ' samples on disk');
          nextStatus = now + 250;
        }
        // A short loop can wrap between two frames. Longer loops can catch up
        // through contiguous history while the canvas animates independently.
        const shortLoop = row.loop && row.limit !== undefined && row.limit <= row.rate / 20;
        const interval = shortLoop ? 50 : row.samples - cursor < frame.stride ? 25 : 0;
        if (interval) await new Promise(resolve => setTimeout(resolve, Math.max(0, now + interval - performance.now())));
      }
      await displayNativeRecording(row, display, displaySamples);
      return;
    }
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
        status.value = 'Live preview · ' + row.samples.toLocaleString() + (row.loop ? ' samples captured · retaining latest ' + row.limit?.toLocaleString() : ' samples on disk');
        nextStatus = now + 250;
      }
      // One read in flight. Include the time spent reading and preparing the frame.
      const interval = document.hidden || stopping ? 250 : 1000 / 60;
      await new Promise(resolve => setTimeout(resolve, Math.max(0, now + interval - performance.now())));
    }
    await displayNativeRecording(row, display, displaySamples);
  } finally { setStop(); status.hidden = true; }
}
