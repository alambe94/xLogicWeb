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

  open(archive: SavedRecording, rate: number, first: number, channels: number, firstChannel: number,
      display: (bytes: Uint8Array, start: number) => void): void {
    this.archive = archive;
    this.form.hidden = false;
    const last = Math.max(0, archive.samples - displaySamples);
    let displayed = first, requested = first, reading = false;
    const channel = document.querySelector<HTMLSelectElement>('#rec-edge-channel')!;
    const prev = document.querySelector<HTMLButtonElement>('#rec-edge-previous')!;
    const next = document.querySelector<HTMLButtonElement>('#rec-edge-next')!;
    const cancel = document.querySelector<HTMLButtonElement>('#rec-edge-cancel')!;
    const result = document.querySelector<HTMLOutputElement>('#rec-edge-result')!;
    channel.replaceChildren(...Array.from({length: channels}, (_, i) =>
      new Option('D' + (i + firstChannel), String(i + firstChannel))));
    let generation = 0, match: number | null = null;
    function resetSearch() {
      generation++; match = null; result.value = ''; cancel.hidden = true;
      prev.disabled = next.disabled = false;
    }
    resetSearch();
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
    const findEdge = async (direction: 'previous' | 'next') => {
      const selected = Number(channel.value), token = ++generation;
      const forward = direction === 'next';
      let cursor: number | null = match ?? (forward ? requested : Math.min(archive.samples, requested + displaySamples));
      prev.disabled = next.disabled = true; cancel.hidden = false;
      result.value = 'Searching D' + selected + '…';
      try {
        while (cursor !== null && this.archive === archive && generation === token) {
          let found: number | null, resume: number | null;
          if (archive.edge) {
            ({match: found, resume} = await archive.edge(cursor, selected, direction));
          } else {
            const start: number = forward ? cursor : Math.max(0, cursor - displaySamples);
            const end: number = forward ? Math.min(archive.samples, start + displaySamples) : cursor;
            if (end - start < 2) break;
            const data = await archive.read(start, end);
            const mask = 1 << (selected - firstChannel);
            found = null;
            for (let i = forward ? 1 : data.length - 1; i > 0 && i < data.length; i += forward ? 1 : -1) {
              if ((data[i]! ^ data[i - 1]!) & mask) { found = start + i; break; }
            }
            resume = forward ? (end < archive.samples ? end - 1 : null) : (start ? start + 1 : null);
          }
          if (generation !== token || this.archive !== archive) return;
          if (found !== null) {
            match = found;
            await seek(found - Math.floor(displaySamples / 2));
            if (generation === token && this.archive === archive)
              result.value = 'D' + selected + ' edge at sample ' + found.toLocaleString();
            return;
          }
          cursor = resume;
        }
        if (generation === token && this.archive === archive) result.value = 'No further edge on D' + selected;
      } catch (error) {
        if (generation === token && this.archive === archive) result.value = error instanceof Error ? error.message : String(error);
      } finally {
        if (generation === token && this.archive === archive) { cancel.hidden = true; prev.disabled = next.disabled = false; }
      }
    };
    prev.onclick = () => void findEdge('previous');
    next.onclick = () => void findEdge('next');
    channel.onchange = cancel.onclick = resetSearch;
    this.slider.oninput = () => { resetSearch(); void seek(this.slider.valueAsNumber); };
    this.form.onsubmit = event => {
      event.preventDefault();
      if (this.seconds.validity.valid) { resetSearch(); void seek(this.seconds.valueAsNumber * rate); }
    };
  }
}
