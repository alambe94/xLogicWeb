// SPDX-License-Identifier: GPL-3.0-or-later
import { DownloadActivity } from '../downloadActivity.js';
import { drawActivity, RecordingActivity } from '../recordingActivity.js';
import type { NativeRecord } from '../nativeArchive.js';
import type { RowBox } from '../waveformStack.js';

function check(value: boolean, label: string): void {
  if (!value) throw new Error(label);
}

const activity = new DownloadActivity(12288, 333333333);
activity.append(Uint8Array.of(8, 8));
activity.append(Uint8Array.of(0, 255, 255, 255, 0));
check(activity.end === 7 && activity.stride === 3, 'split blocks retain the confirmed prefix');
check(activity.bins[0] === 0x0800 && activity.bins[1] === 0xffff && activity.bins[2] === 0,
  'one-sample changes, constant high and low channels are distinct');
activity.append(Uint8Array.of(1, 0));
check(activity.bins[2] === 0x0100, 'a later block completes the partial bin');
const max = new DownloadActivity(2147483520, 41666666);
check(max.bins.byteLength <= 8192, 'the full board buffer needs at most 8 KiB of activity bins');

const rectangles: number[][] = [];
const ctx = {setTransform() {}, clearRect() {}, fillRect(...rect: number[]) { rectangles.push(rect); }};
const canvas = {width: 0, height: 0, clientWidth: 12288, clientHeight: 100, getContext: () => ctx};
const row: RowBox = {spec: {kind: 'channel', channel: 3, heightCss: 40}, top: 0, height: 40, band: 39};
Object.defineProperty(globalThis, 'devicePixelRatio', {value: 1, configurable: true});
drawActivity(canvas as unknown as HTMLCanvasElement, [row], ['','','','red'], activity, 0, activity.count, activity.end);
check(rectangles.some(([x,,width,height]) => x === 0 && width === 3 && height! > 2), 'D3 activity painted');
check(rectangles.every(([x,,w]) => x! + w! <= activity.end), 'undownloaded samples remain blank');
Object.defineProperty(globalThis, 'document', {value: {createElement: () => ({setAttribute() {}, addEventListener() {}})}, configurable: true});
const record: NativeRecord = {id: 'loop', rate: 333333333, bank: 'lower', loop: true, limit: 1024,
  samples: 1000000, state: 'recording', title: '', note: ''};
const loop = new RecordingActivity(record, 4, () => {});
loop.update({record, first: 998976, end: 1000000, stride: 4, bins: Array(256).fill(0x0800)});
loop.advance(performance.now());
check(loop.end === 1000000 && loop.start === loop.end - 768, 'wrapped loop immediately shows 75% confirmed activity');
console.log('Ethernet activity overview passed');
