// SPDX-License-Identifier: GPL-3.0-or-later
import { ESK_PACKED_RATE, recordEskUsb, unpackEsk, type EskBank } from './eskCapture.js';
import { OpfsRecordController } from '../data/recordController.js';
import { createOpfsRecordStorage } from '../data/opfsStorage.js';

export type LiveRequest = { type: 'start'; directory: FileSystemDirectoryHandle; serial: string; limit: number; rate: number; bank: EskBank; title: string } |
  { type: 'stop' | 'displayed' };
export type LiveReply = { type: 'preview'; data: Uint8Array; accepted: number; saved: number; queue: number } |
  { type: 'end'; accepted: number; saved: number; wire: bigint | undefined; error: string | undefined };

const stop = new AbortController();
let displaying = false;
self.onmessage = ({ data }: MessageEvent<LiveRequest>) => {
  if (data.type === 'stop') stop.abort();
  else if (data.type === 'displayed') displaying = false;
  else if (data.type === 'start') void record(data);
};

async function record(request: Extract<LiveRequest, { type: 'start' }>) {
  let writer: OpfsRecordController | undefined, accepted = 0, wire: bigint | undefined;
  let error: string | undefined;
  try {
    const devices = (await navigator.usb.getDevices()).filter(d =>
      d.vendorId === 0x1209 && d.productId === 3 && (d.serialNumber ?? '') === request.serial);
    if (devices.length !== 1) throw new Error('Selected xESK device is unavailable or ambiguous');
    writer = new OpfsRecordController(await createOpfsRecordStorage(request.directory), {
      profile: { profileId: request.title, calibrationId: null, channels: request.rate === ESK_PACKED_RATE ? 4 : 8, sampleRateHz: request.rate, bytesPerSample: 1 },
      maxBytes: request.limit,
    });
    writer.arm();
    await writer.whenIdle();
    if (writer.lastError) throw new Error(writer.lastError);
    const recording = writer;
    wire = await recordEskUsb(devices[0], stop.signal, bytes => {
      if (recording.lastError) throw new Error(recording.lastError);
      const packed = request.rate === ESK_PACKED_RATE;
      const count = Math.min(bytes.length * (packed ? 2 : 1), request.limit - accepted);
      const block = packed ? unpackEsk(bytes, count) : bytes.subarray(0, count);
      const end = accepted + block.length;
      recording.capture(block, { startSeconds: accepted / request.rate, endSeconds: end / request.rate });
      if (recording.lastError) throw new Error(recording.lastError);
      accepted = end;
      if (!displaying) {
        displaying = true;
        const preview = block.slice(-65536);
        self.postMessage({ type: 'preview', data: preview, accepted, saved: recording.bytes,
          queue: recording.queuedBytes } satisfies LiveReply, { transfer: [preview.buffer] });
      }
      if (accepted === request.limit) stop.abort();
    }, request.rate, request.bank);
    if (request.rate === ESK_PACKED_RATE) wire *= 2n;
  } catch (e) { error = e instanceof Error ? e.message : String(e); }
  finally {
    await writer?.close();
    self.postMessage({ type: 'end', accepted, saved: writer?.bytes ?? 0, wire,
      error: error ?? writer?.lastError ?? undefined } satisfies LiveReply);
  }
}
