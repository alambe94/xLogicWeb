// SPDX-License-Identifier: GPL-3.0-or-later
import { selectControl, type SelectOptionTuple } from './select.js';
import { findPulse, type TraceInput, type TraceHit } from './traceSearch.js';

function choice(key: string, label: string, options: SelectOptionTuple[]) {
  return selectControl('analysis-' + key, label, options, options[0]![0]);
}
function action(text: string, click: () => void) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'mini';
  button.textContent = text;
  button.onclick = click;
  return button;
}
function field(name: string, element: HTMLInputElement) {
  const label = document.createElement('label');
  label.className = 'field';
  label.append(name, element);
  return label;
}
export class TraceTools {
  readonly root = document.getElementById('trace-tools')!;
  private key: object | undefined;
  private job?: AbortController;
  hit: TraceHit | null = null;
  constructor(private source: () => TraceInput | null, private jump: (hit: TraceHit) => Promise<void>,
      private redraw: () => void) {
    const toggle = document.getElementById('btn-trace-tools')!;
    toggle.onclick = () => {
      this.root.hidden = !this.root.hidden;
      toggle.setAttribute('aria-expanded', String(!this.root.hidden));
      this.refresh(true);
    };
  }
  refresh(force = false): void {
    if (this.root.hidden && !force) return;
    const source = this.source();
    if (!force && source?.key === this.key && this.root.childNodes.length) return;
    this.key = source?.key;
    this.job?.abort();
    this.hit = null;
    this.redraw();
    this.root.replaceChildren();
    if (this.root.hidden) return;
    if (!source) { this.root.textContent = 'Open or stop a digital capture to analyze it.'; return; }
    const channels: SelectOptionTuple[] = Array.from({length: source.channels}, (_, i) => [String(i), 'D' + (i + source.firstChannel)]);
    const channel = choice('pulse-channel', 'Channel', channels);
    const level = choice('level', 'Pulse', [['1', 'High'], ['0', 'Low']]);
    const compare = choice('comparison', 'Width', [['lt', 'Shorter than'], ['gt', 'Longer than']]);
    const width = document.createElement('input');
    width.type = 'number'; width.step = 'any'; width.min = '0'; width.value = '50'; width.className = 'viewer-input';
    const result = document.createElement('output');
    result.setAttribute('aria-live', 'polite');
    const cancel = () => { this.job?.abort(); this.hit = null; result.value = ''; this.redraw(); };
    for (const control of [channel, level, compare]) control.addEventListener('change', cancel);
    width.oninput = cancel;
    const search = async (reverse: boolean) => {
      this.job?.abort();
      const job = this.job = new AbortController();
      try {
        if (!(width.valueAsNumber > 0)) throw Error('Enter a positive width in ns.');
        result.value = 'Searching…';
        const from = this.hit ? (reverse ? this.hit.start + 1 : this.hit.end - 1) : (reverse ? source.length : 0);
        const hit = await findPulse(source, Number(channel.value), Number(level.value), width.valueAsNumber,
          compare.value === 'lt', reverse, from, job.signal);
        if (job.signal.aborted || this.source()?.key !== source.key) return;
        if (!hit) { result.value = 'No further matching pulse'; return; }
        await this.jump(hit);
        if (job.signal.aborted) return;
        this.hit = hit; this.redraw();
        result.value = hit.label + ' · sample ' + hit.start.toLocaleString();
      } catch (error) { if (!job.signal.aborted) result.value = String(error); }
    };
    this.root.append(channel.el, level.el, compare.el, field('Width (ns)', width),
      action('Previous pulse', () => void search(true)), action('Next pulse', () => void search(false)),
      action('Cancel', cancel), result);
  }
}

