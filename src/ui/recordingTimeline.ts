// SPDX-License-Identifier: GPL-3.0-or-later
import { displaySamples, type SavedRecording } from './eskRecorder.js';
import { formatDuration } from './format.js';
import { t } from './i18n.js';

export class RecordingTimeline {
  private readonly form = document.querySelector<HTMLFormElement>('#rec-timeline')!;
  private readonly slider = document.querySelector<HTMLInputElement>('#rec-slider')!;
  private readonly seconds = document.querySelector<HTMLInputElement>('#rec-seconds')!;
  private readonly duration = document.querySelector<HTMLOutputElement>('#rec-duration')!;
  private readonly error = document.querySelector<HTMLElement>('#rec-seek-error')!;
  private archive: SavedRecording | undefined;
  get current(): SavedRecording | undefined { return this.archive; }
  windowStart = 0;
  inspectSample: ((sample: number, span: number, fraction: number) => Promise<boolean>) | undefined;

  constructor(private readonly redraw: () => void, private readonly leaveOverview: () => void,
      private readonly onManualSeek: () => void) {}

  clear(key?: string): void {
    if (key !== undefined && this.archive?.key !== key) return;
    this.leaveOverview();
    this.inspectSample = undefined;
    this.archive?.dispose?.();
    this.archive = undefined;
    this.windowStart = 0;
    this.redraw();
    this.form.hidden = true;
    this.form.onsubmit = this.slider.oninput = null;
  }

  open(archive: SavedRecording, rate: number, first: number,
      display: (bytes: Uint8Array, start: number) => void,
      centerSample: (sample: number, span?: number, fraction?: number) => void): void {
    this.archive = archive;
    this.windowStart = first;
    this.form.hidden = false;
    const last = Math.max(0, archive.samples - displaySamples);
    let displayed = first, requested = first, reading: Promise<void> | undefined;
    this.slider.max = String(last);
    this.slider.disabled = last === 0;
    this.seconds.max = String(archive.samples / rate);
    this.duration.value = t('rec.duration', { duration: formatDuration(archive.samples / rate, 6) });
    this.duration.title = archive.summary ?? '';
    this.error.textContent = '';
    const position = (start: number) => {
      this.slider.value = String(start);
      this.slider.style.setProperty('--acquisition-fill', (last ? 100 * this.slider.valueAsNumber / last : 0) + '%');
      this.slider.setAttribute('aria-valuetext', formatDuration(start / rate, 8));
      this.seconds.value = String(start / rate);
    };
    position(first);
    const readRequested = async () => {
      try {
        while (this.archive === archive && requested !== displayed) {
          const start = requested;
          const bytes = await archive.read(start, Math.min(start + displaySamples, archive.samples));
          if (this.archive === archive && requested === start) {
            this.windowStart = start;
            display(bytes, start);
            displayed = start;
            this.error.textContent = '';
          }
        }
      } catch (error) {
        if (this.archive === archive) {
          position(displayed);
          this.error.textContent = error instanceof Error ? error.message : String(error);
        }
      }
    };
    const seek = (sample: number) => {
      requested = Math.max(0, Math.min(last, Math.round(sample)));
      position(requested);
      reading ??= readRequested().finally(() => { reading = undefined; });
      return reading;
    };
    this.inspectSample = async (sample, span, fraction) => {
      const target = Math.max(0, Math.min(last, Math.floor(sample - span * fraction - (displaySamples - span) / 2)));
      await seek(target);
      if (this.archive !== archive || displayed !== target) return false;
      this.leaveOverview();
      centerSample(sample - displayed, span, fraction);
      return true;
    };
    this.slider.oninput = () => { this.leaveOverview(); this.onManualSeek(); void seek(this.slider.valueAsNumber); };
    this.form.onsubmit = event => {
      event.preventDefault();
      if (this.seconds.validity.valid) { this.leaveOverview(); this.onManualSeek(); void seek(this.seconds.valueAsNumber * rate); }
    };
  }
}
