// SPDX-License-Identifier: GPL-3.0-or-later
import { ESK_PACKED_RATE, recordEskUsb, type EskBank, type EskEdge } from './eskCapture.js';
import { PackedEdgeWindow } from './eskPackedEdge.js';

export type EdgeRequest = {type: 'arm'; serial: string; bank: EskBank; channel: number; edge: EskEdge; count: number; pre: number} | {type: 'cancel'};
export type EdgeReply = {type: 'armed'} | {type: 'done'; samples: Uint8Array<ArrayBuffer> | undefined} | {type: 'error'; detail: string};
const stop = new AbortController();
self.onmessage = ({data}: MessageEvent<EdgeRequest>) => {
  if (data.type === 'cancel') stop.abort();
  else void arm(data);
};

async function arm(req: Extract<EdgeRequest, {type: 'arm'}>): Promise<void> {
  try {
    const devices = (await navigator.usb.getDevices()).filter(d => d.vendorId === 0x1209 &&
      d.productId === 3 && (d.serialNumber ?? '') === req.serial);
    if (devices.length !== 1) throw Error('Selected xESK device is unavailable or ambiguous');
    const base = req.bank === 'upper' ? 4 : 0;
    const window = new PackedEdgeWindow(req.count, req.pre, req.channel - base, req.edge === 'rising');
    let armed = false, samples: Uint8Array<ArrayBuffer> | undefined;
    await recordEskUsb(devices[0]!, stop.signal, block => {
      if (!armed) { self.postMessage({type: 'armed'} satisfies EdgeReply); armed = true; }
      samples = window.push(block);
      if (samples) stop.abort();
    }, ESK_PACKED_RATE, req.bank);
    self.postMessage({type: 'done', samples} satisfies EdgeReply, {transfer: samples ? [samples.buffer] : []});
  } catch (error) {
    self.postMessage({type: 'error', detail: error instanceof Error ? error.message : String(error)} satisfies EdgeReply);
  }
}
