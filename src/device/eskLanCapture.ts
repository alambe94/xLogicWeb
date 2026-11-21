import { ESK_SAMPLES } from './eskCapture.js';

import { capturePairedBoard, fromBoard } from './eskPairedBoard.js';

export function eskLanMode(): 'board' | 'paired' | 'bridge' | undefined {
  if (fromBoard()) return 'paired';
  if (new URL(location.href).searchParams.get('esk') === 'board' &&
      location.protocol === 'http:' && /^\d+\.\d+\.\d+\.\d+$/.test(location.hostname)) return 'board';
  if (document.querySelector('meta[name="esk-lan-capture"][content="finite"]')) return 'bridge';
  return undefined;
}

/** A same-origin bridge owns one fixed board. Each POST requests a new record. */
export async function captureEskLan(): Promise<{ samples: Uint8Array; ticks: string }> {
  const mode = eskLanMode();
  if (mode === 'paired') return capturePairedBoard();
  if (mode === 'board') return (await import('./eskBoardCapture.js')).captureBoardOrigin();
  if (mode !== 'bridge') throw new Error('Open the viewer from an ESK board or its LAN bridge');
  const reply = await fetch('/api/esk/capture', {
    method: 'POST', headers: { 'X-ESK-Capture': 'finite' }, cache: 'no-store', redirect: 'error',
  });
  if (!reply.ok) throw new Error(`ESK Ethernet capture: ${reply.status} ${reply.statusText}`);
  const ticks = reply.headers.get('X-ESK-Ticks') ?? '';
  if (reply.headers.get('Content-Type') !== 'application/octet-stream' ||
      reply.headers.get('Content-Length') !== String(ESK_SAMPLES) || !/^\d+$/.test(ticks)) {
    throw new Error('Invalid ESK Ethernet capture header');
  }
  const samples = new Uint8Array(await reply.arrayBuffer());
  if (samples.length !== ESK_SAMPLES) throw new Error('Incomplete ESK Ethernet capture');
  return { samples, ticks };
}
