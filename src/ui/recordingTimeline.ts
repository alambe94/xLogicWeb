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

  clear(key?: string): void {
    if (key !== undefined && this.archive?.key !== key) return;
    this.archive?.dispose?.();
    this.archive = undefined;
    this.form.hidden = true;
    this.form.onsubmit = this.slider.oninput = null;
  }

  open(archive: SavedRecording, rate: number, first: number, display: (bytes: Uint8Array, start: number) => void): void {
    this.archive = archive;
    this.form.hidden = false;
    const last = Math.max(0, archive.samples - displaySamples);
    let displayed = first, requested = first, reading = false;
    this.slider.max = String(last);
    this.slider.disabled = last === 0;
    this.seconds.max = String(archive.samples / rate);
    document.querySelector<HTMLElement>('#rec-summary')!.textContent = archive.summary ?? '';
    this.duration.value = t('rec.duration', { duration: formatDuration(archive.samples / rate, 6) });
    this.error.textContent = '';
    const position = (start: number) => {
      this.slider.value = String(start);
      this.slider.setAttribute('aria-valuetext', formatDuration(start / rate, 8));
      this.seconds.value = String(start / rate);
    };
    position(first);
    const seek = async (sample: number) => {
      requested = Math.max(0, Math.min(last, Math.round(sample)));
      position(requested);
      if (reading) return;
      reading = true;
      try {
        while (this.archive === archive && requested !== displayed) {
          const start = requested;
          const bytes = await archive.read(start, Math.min(start + displaySamples, archive.samples));
          if (this.archive === archive && requested === start) {
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
      } finally { reading = false; }
    };
    this.slider.oninput = () => void seek(this.slider.valueAsNumber);
    this.form.onsubmit = event => {
      event.preventDefault();
      if (this.seconds.validity.valid) void seek(this.seconds.valueAsNumber * rate);
    };
  }
}
