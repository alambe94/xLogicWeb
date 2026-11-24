// SPDX-License-Identifier: GPL-3.0-or-later
import { ESK_PACKED_RATE } from '../device/eskCapture.js';
import type { RecordingDisplay, SavedRecording } from './eskRecorder.js';

export interface NativeRecord {
  id: string; rate: number; bank: 'lower' | 'upper'; samples: number; bytes?: number;
  state: 'recording' | 'saved' | 'failed'; title: string; note: string;
}

export function nativeRecorderAvailable(): boolean {
  return location.hostname === '127.0.0.1' && !!document.querySelector('meta[name="esk-native-recorder"]');
}

export async function nativeRequest(op: string, params: Record<string, unknown> = {}): Promise<Response> {
  const response = await fetch('/api/native', {method: 'POST', cache: 'no-store',
    headers: {'Content-Type': 'application/json'}, body: JSON.stringify({op, ...params})});
  if (!response.ok) throw new Error(await response.text());
  return response;
}

export async function listNativeRecordings(): Promise<NativeRecord[]> {
  return (await nativeRequest('list')).json();
}

export function nativeRecordingTitle(row: NativeRecord): string {
  return row.rate === ESK_PACKED_RATE ? 'xLOGIC USB ' + (row.bank === 'upper' ? 'D4–D7' : 'D0–D3') : 'xLOGIC USB';
}

export async function displayNativeRecording(row: NativeRecord, display: RecordingDisplay, size: number, first?: number) {
  if (row.state !== 'saved') throw new Error(row.note || 'Recording is unavailable');
  if (!row.samples) throw new Error('This recording has no saved samples.');
  const analysis = !!document.querySelector('meta[name="esk-native-recorder"][data-analysis]');
  const saved: SavedRecording = {key: row.id, stored: {key: row.id, name: row.title, source: 'native'},
    ...(analysis ? {readSize: 1024 * 1024} : {}),
    samples: row.samples, summary: row.note,
    read: async (start, end) => {
      const op = analysis && end - start > 65536 ? 'analysis_window' : 'window';
      const bytes = new Uint8Array(await (await nativeRequest(op, {id: row.id, start, end})).arrayBuffer());
      if (bytes.length !== end - start) throw new Error('Incomplete native recording window');
      return bytes;
    }, edge: async (position, channel, direction) =>
      (await nativeRequest('edge', {id: row.id, position, channel, direction})).json()};
  const start = Math.min(first ?? Math.max(0, row.samples - size), row.samples - 1);
  const end = Math.min(start + size, row.samples);
  display(await saved.read(start, end), row.rate, start, nativeRecordingTitle(row), saved);
}
