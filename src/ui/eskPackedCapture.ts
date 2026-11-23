// SPDX-License-Identifier: GPL-3.0-or-later
import type { EskBank, EskEdgeTrigger } from '../device/eskCapture.js';
import type { EdgeRequest, EdgeReply } from '../device/eskEdgeWorker.js';

export async function capturePackedEdge(device: USBDevice, bank: EskBank, count: number, pre: number,
    trigger: EskEdgeTrigger): Promise<Uint8Array> {
  trigger.signal.throwIfAborted();
  const worker = new Worker(new URL('../device/eskEdgeWorker.ts', import.meta.url), {type: 'module'});
  const send = (message: EdgeRequest) => worker.postMessage(message);
  const cancel = () => send({type: 'cancel'});
  try {
    return await new Promise<Uint8Array>((resolve, reject) => {
      worker.onerror = event => reject(new Error(event.message));
      worker.onmessageerror = () => reject(new Error('Invalid packed trigger worker response'));
      worker.onmessage = ({data}: MessageEvent<EdgeReply>) => {
        if (data.type === 'armed') trigger.onArmed();
        else if (data.type === 'error') reject(new Error(data.detail));
        else if (trigger.signal.aborted) reject(trigger.signal.reason);
        else if (data.samples?.length === count) resolve(data.samples);
        else reject(new Error('Incomplete packed trigger window'));
      };
      trigger.signal.addEventListener('abort', cancel, {once: true});
      send({type: 'arm', serial: device.serialNumber ?? '', bank, channel: trigger.channel, edge: trigger.edge, count, pre});
    });
  } finally {
    trigger.signal.removeEventListener('abort', cancel);
    worker.terminate();
  }
}
