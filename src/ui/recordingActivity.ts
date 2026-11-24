// SPDX-License-Identifier: GPL-3.0-or-later
import { nativeRequest, type NativeRecord } from './nativeArchive.js';
import { displaySamples } from './eskRecorder.js';
import type { RowBox } from './waveformStack.js';

interface ActivityBins { first: number; end: number; stride: number; bins: number[] }
export interface ActivityFrame extends ActivityBins { record: NativeRecord }
type InspectSamples = (sample: number, span: number, fraction: number) => Promise<boolean>;

/** Each bin contains the AND and OR of every sample, including single-sample pulses. */
export class RecordingActivity {
  readonly canvas = document.createElement('canvas');
  start = 0;
  span: number;
  end = 0;
  private history: ActivityBins;
  private detail?: ActivityBins;
  private inspect: InspectSamples | undefined;
  private revision = 0;
  private fetching = false;
  private reading = false;
  private lastFrame = performance.now();

  constructor(private readonly record: NativeRecord, stride: number, private readonly redraw: () => void) {
    this.span = record.rate * 2;
    this.history = { first: 0, end: 0, stride, bins: [] };
    const c = this.canvas;
    c.className = 'recording-activity';
    c.setAttribute('aria-label', 'Recording activity');
    for (const event of ['pointerdown', 'pointermove', 'pointerup', 'dblclick']) {
      c.addEventListener(event, e => e.stopPropagation());
    }
    c.onclick = e => { e.stopPropagation(); void this.openAt(this.fraction(e.clientX), displaySamples); };
    c.onkeydown = e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      e.stopPropagation();
      const recordedFraction = Math.min(1, (this.end - this.start) / this.span);
      void this.openAt(recordedFraction / 2, displaySamples);
    };
    c.addEventListener('wheel', e => {
      e.preventDefault();
      e.stopPropagation();
      if (!this.inspect || this.reading || !e.deltaY) return;
      const fraction = this.fraction(e.clientX);
      const sample = this.start + fraction * this.span;
      if (sample >= this.end) return;
      const span = Math.min(record.rate * 2, this.span * (e.deltaY < 0 ? 0.5 : 2));
      if (span <= displaySamples) { void this.openAt(fraction, span); return; }
      const fullSpan = record.rate * 2;
      const left = Math.max(0, this.end - fullSpan * 0.75);
      this.start = Math.max(left, Math.min(left + fullSpan - span, sample - fraction * span));
      this.span = span;
      this.revision++;
      this.redraw();
      void this.refine();
    }, { passive: false });
  }

  update(frame: ActivityFrame): void {
    const h = this.history;
    if (h.end !== frame.first) { h.bins.length = 0; h.first = frame.first; }
    h.bins.push(...frame.bins);
    h.end = frame.end;
    const drop = Math.max(0, Math.floor((h.end - this.span - h.first) / h.stride));
    if (drop) { h.bins.splice(0, drop); h.first += drop * h.stride; }
  }

  advance(now: number): boolean {
    const elapsed = now - this.lastFrame;
    this.lastFrame = now;
    if (this.inspect || this.end >= this.history.end) return false;
    const rate = this.record.rate, stride = this.history.stride;
    const next = Math.max(this.end + elapsed * rate / 1000, this.history.end - rate * 0.075);
    const end = Math.min(this.history.end, Math.floor(next / stride) * stride);
    if (end <= this.end) return false;
    this.end = end;
    this.start = Math.max(0, end - 0.75 * this.span);
    return true;
  }

  freeze(inspect: InspectSamples): void {
    this.end = this.history.end;
    this.start = Math.max(0, this.end - 0.75 * this.span);
    this.inspect = inspect;
    this.canvas.tabIndex = 0;
    this.canvas.title = 'Scroll to zoom, or click to inspect the recorded samples';
    this.canvas.setAttribute('aria-label', this.canvas.title + '. Press Enter to inspect the center.');
  }

  dispose(): void {
    this.revision++;
    this.inspect = undefined;
    this.canvas.remove();
  }

  private fraction(x: number): number {
    const r = this.canvas.getBoundingClientRect();
    return Math.max(0, Math.min(1, (x - r.left) / Math.max(1, r.width)));
  }

  private async openAt(fraction: number, span: number): Promise<void> {
    const sample = Math.floor(this.start + fraction * this.span);
    if (!this.inspect || this.reading || sample >= this.end) return;
    this.reading = true;
    try { await this.inspect(sample, span, fraction); }
    finally { this.reading = false; }
  }

  private async refine(): Promise<void> {
    if (this.fetching) return;
    const rev = this.revision;
    const first = Math.floor(this.start), end = Math.min(this.end, Math.ceil(this.start + this.span));
    if (end <= first || end - first > 16 * 1024 ** 2 || this.span / this.canvas.clientWidth >= this.history.stride) return;
    this.fetching = true;
    try {
      const detail: ActivityBins = await (await nativeRequest('overview_detail', {id: this.record.id, first, end})).json();
      if (this.revision === rev) { this.detail = detail; this.redraw(); }
    } catch { /* The coarser confirmed bins remain visible. */ }
    finally {
      this.fetching = false;
      if (this.inspect && this.revision !== rev) void this.refine();
    }
  }

  draw(rows: readonly RowBox[], colors: readonly string[]): void {
    const c = this.canvas, w = c.clientWidth, h = c.clientHeight, dpr = devicePixelRatio || 1;
    if (!w || !h) return;
    if (c.width !== Math.round(w*dpr) || c.height !== Math.round(h*dpr)) {
      c.width = Math.round(w*dpr); c.height = Math.round(h*dpr);
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const last = Math.min(this.end, this.start + this.span);
    const b = this.detail && this.detail.first <= this.start && this.detail.end >= last ? this.detail : this.history;
    const from = Math.max(0, Math.floor((this.start - b.first) / b.stride));
    const to = Math.min(b.bins.length, Math.ceil((last - b.first) / b.stride));
    const x = (i: number) => (Math.min(last, b.first + i*b.stride) - this.start) * w / this.span;
    for (const {spec, top, band} of rows) {
      if (spec.kind !== 'channel') continue;
      const bit = 1 << spec.channel;
      const state = (i: number) => b.bins[i]! & bit ? 1 : b.bins[i]! & (bit << 8) ? 2 : 0;
      ctx.fillStyle = colors[spec.channel]!;
      const high = top + band * 0.23, low = top + band * 0.76;
      for (let i = from; i < to;) {
        const level = state(i), left = x(i);
        let j = i + 1;
        while (j < to && state(j) === level) j++;
        ctx.globalAlpha = level === 2 ? 0.75 : 1;
        ctx.fillRect(left, level === 0 ? low : high, Math.max(1 / dpr, x(j)-left), level === 2 ? low-high+1 : 1.5);
        if (level !== 2 && j < to && state(j) !== 2) ctx.fillRect(x(j), high, 1, low-high);
        i = j;
      }
    }
    ctx.globalAlpha = 1;
  }
}
