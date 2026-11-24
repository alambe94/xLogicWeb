// SPDX-License-Identifier: GPL-3.0-or-later
import { selectControl, type SelectOptionTuple } from './select.js';
import { findTraceEdge, findPulse, type TraceInput, type TraceHit } from './traceSearch.js';

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
  readonly root = document.querySelector<HTMLTemplateElement>('#trace-tools-template')!.content.firstElementChild as HTMLElement;
  readonly edges = this.root.querySelector<HTMLElement>('.trace-edges')!;
  private readonly filter = this.root.querySelector<HTMLDetailsElement>('#trace-filter')!;
  private readonly search = this.root.querySelector<HTMLDetailsElement>('#trace-search')!;
  private readonly searchFields = this.search.querySelector<HTMLElement>('.trace-fields')!;
  private key: object | undefined;
  private initialized = false;
  private job?: AbortController;
  private edgeJob?: AbortController;
  private resetEdge?: (bit?: number) => void;
  edge: TraceHit | null = null;
  hit: TraceHit | null = null;
  private pulseChannel = 0;
  private edgeChannel = 0;
  private readonly toggle = document.getElementById('btn-trace-tools')!;

  constructor(private source: (signal?: AbortSignal) => TraceInput | null, private jump: (hit: TraceHit) => Promise<void>,
      private redraw: () => void, private filters: () => ReadonlyMap<number, number>,
      private setFilter: (bit: number, samples: number) => Promise<void>, private showPanel: () => void,
      private edgeOrigin: (forward: boolean) => number) {
    window.addEventListener('pagehide', () => { this.job?.abort(); this.edgeJob?.abort(); });
    this.toggle.onclick = () => this.showSearch();
    this.search.ontoggle = () => {
      this.toggle.setAttribute('aria-expanded', String(this.search.open && this.root.getClientRects().length > 0));
      this.renderSearch();
    };
  }

  resetNavigation(): void {
    this.resetEdge?.();
    this.renderSearch();
  }

  private showSearch(): void {
    this.showPanel();
    this.search.open = true;
    this.toggle.setAttribute('aria-expanded', 'true');
    this.search.scrollIntoView({block: 'nearest'});
    this.search.querySelector('summary')!.focus({preventScroll: true});
  }

  openPulseSearch(channel: number): void {
    this.pulseChannel = this.edgeChannel = channel;
    this.showSearch();
    this.refresh(true);
  }

  refresh(force = false): void {
    const source = this.source();
    this.toggle.setAttribute('aria-expanded', String(this.search.open && this.root.getClientRects().length > 0));
    if (!force && this.initialized && source?.key === this.key) return;
    this.initialized = true;
    this.key = source?.key;
    this.edgeJob?.abort();
    this.edge = null;
    if (source && this.pulseChannel >= source.channels) this.pulseChannel = 0;
    if (source && this.edgeChannel >= source.channels) this.edgeChannel = 0;
    this.renderFilter(source);
    this.renderEdges(source);
    this.renderSearch();
  }

  private channels(source: TraceInput): SelectOptionTuple[] {
    return Array.from({length: source.channels}, (_, i) => [String(i), 'D' + (i + source.firstChannel)]);
  }

  private renderEdges(source: TraceInput | null): void {
    const container = this.edges.querySelector<HTMLElement>('#rec-edge-channel')!;
    const prev = this.edges.querySelector<HTMLButtonElement>('#rec-edge-previous')!;
    const next = this.edges.querySelector<HTMLButtonElement>('#rec-edge-next')!;
    const cancel = this.edges.querySelector<HTMLButtonElement>('#rec-edge-cancel')!;
    const result = this.edges.querySelector<HTMLOutputElement>('#rec-edge-result')!;
    const reset = () => {
      this.edgeJob?.abort(); this.edge = null; result.value = '';
      cancel.hidden = true; prev.disabled = next.disabled = !source;
      this.redraw();
    };
    this.resetEdge = reset;
    reset();
    container.replaceChildren();
    prev.onclick = next.onclick = cancel.onclick = null;
    if (!source) return;
    const channel = selectControl('rec-edge-channel', 'Edge channel', this.channels(source), String(this.edgeChannel));
    container.append(channel.el);
    this.resetEdge = bit => {
      if (bit !== undefined) { this.edgeChannel = bit; channel.value = String(bit); }
      reset();
    };
    channel.addEventListener('change', () => { this.edgeChannel = Number(channel.value); reset(); });
    cancel.onclick = reset;
    const step = async (forward: boolean) => {
      this.edgeJob?.abort();
      const job = this.edgeJob = new AbortController();
      const current = this.source(job.signal);
      if (!current || current.key !== source.key) return;
      const bit = Number(channel.value), name = 'D' + (bit + current.firstChannel);
      const from = this.edge?.start ?? this.hit?.start ?? this.edgeOrigin(forward);
      prev.disabled = next.disabled = true; cancel.hidden = false;
      result.value = 'Searching ' + name + '…';
      try {
        const sample = await findTraceEdge(current, bit, from, forward, job.signal);
        if (job.signal.aborted) return;
        if (sample === null) { result.value = 'No further edge on ' + name; return; }
        const edge = {start: sample, end: sample, bit, label: name};
        await this.jump(edge);
        if (job.signal.aborted) return;
        this.edge = edge; this.redraw();
        result.value = name + ' · sample ' + sample.toLocaleString();
      } catch (error) { if (!job.signal.aborted) result.value = String(error); }
      finally { if (!job.signal.aborted) { prev.disabled = next.disabled = false; cancel.hidden = true; } }
    };
    prev.onclick = () => void step(false);
    next.onclick = () => void step(true);
  }

  private renderFilter(source: TraceInput | null): void {
    const body = this.filter.querySelector<HTMLElement>('.trace-fields')!;
    const summary = this.filter.querySelector<HTMLElement>('.trace-filter-summary')!;
    body.replaceChildren(); summary.textContent = '';
    if (!source) { body.textContent = 'Open or stop a four- or eight-channel capture to filter it.'; return; }
    const channels = this.channels(source);
    const ch = choice('filter-channel', 'Channel', channels);
    const width = document.createElement('input');
    width.type = 'number'; width.min = '0'; width.step = 'any'; width.className = 'viewer-input';
    const result = document.createElement('output');
    result.setAttribute('aria-live', 'polite');
    const sync = () => {
      summary.textContent = [...this.filters()].map(([bit, n]) =>
        'D' + (source.firstChannel + bit) + ' ≥ ' + Number((n * 1e9 / source.rate).toPrecision(6)) + ' ns').join(', ');
      const n = this.filters().get(Number(ch.value));
      width.value = n ? String(n * 1e9 / source.rate) : '0';
      result.value = n ? 'Minimum retained width: ' + n + ' samples' : 'Raw signal';
    };
    ch.addEventListener('change', sync); sync();
    const apply = async () => {
      const n = Math.ceil(width.valueAsNumber * source.rate / 1e9);
      if (!Number.isSafeInteger(n) || n < 0 || !width.validity.valid) {
        result.value = 'Enter a nonnegative width in ns.'; return;
      }
      result.value = 'Updating waveform…';
      try {
        await this.setFilter(Number(ch.value), n);
        if (this.key === source.key) { this.renderEdges(source); this.renderSearch(); sync(); }
      }
      catch (error) { result.value = String(error); }
    };
    const buttons = document.createElement('div');
    buttons.className = 'trace-filter-actions';
    buttons.append(action('Apply', () => void apply()), action('Reset', () => {
      width.value = '0';
      void apply();
    }));
    body.append(ch.el, field('Minimum width (ns)', width), buttons, result);
  }

  private renderSearch(): void {
    this.job?.abort(); this.hit = null; this.redraw();
    this.searchFields.replaceChildren();
    if (!this.search.open) return;
    const source = this.source();
    if (!source) {
      this.searchFields.textContent = 'Open or stop a four- or eight-channel digital capture to search it.';
      const demo = document.querySelector<HTMLAnchorElement>('#esk-analysis-demo');
      if (demo && !demo.hidden) {
        const link = document.createElement('a');
        link.href = demo.href; link.target = demo.target; link.rel = demo.rel;
        link.textContent = demo.textContent; this.searchFields.append(link);
      }
      return;
    }
    const channels = this.channels(source);
    const channel = choice('pulse-channel', 'Channel', channels);
    channel.value = String(this.pulseChannel);
    channel.addEventListener('change', () => { this.pulseChannel = Number(channel.value); });
    const level = choice('level', 'Pulse', [['1', 'High'], ['0', 'Low']]);
    const compare = choice('comparison', 'Width', [['lt', 'Shorter than'], ['gt', 'Longer than']]);
    const width = document.createElement('input');
    width.type = 'number'; width.step = 'any'; width.min = '0'; width.value = '50'; width.className = 'viewer-input';
    const result = document.createElement('output');
    result.setAttribute('aria-live', 'polite');
    const cancel = () => {
      this.job?.abort(); this.hit = null; result.value = ''; setBusy(false); this.redraw();
    };
    const stop = action('Cancel', cancel);
    const previous = action('«', () => void search(true));
    const next = action('»', () => void search(false));
    previous.setAttribute('aria-label', previous.title = 'Previous pulse');
    next.setAttribute('aria-label', next.title = 'Next pulse');
    const setBusy = (busy: boolean) => {
      stop.hidden = !busy; previous.disabled = next.disabled = busy;
    };
    setBusy(false);
    for (const control of [channel, level, compare]) control.addEventListener('change', cancel);
    width.oninput = cancel;
    const search = async (reverse: boolean) => {
      this.job?.abort();
      const job = this.job = new AbortController();
      try {
        if (!(width.valueAsNumber > 0)) throw Error('Enter a positive width in ns.');
        setBusy(true);
        result.value = 'Searching…';
        const from = this.hit ? (reverse ? this.hit.start + 1 : this.hit.end - 1) : (reverse ? source.length : 0);
        const current = this.source(job.signal);
        if (!current || current.key !== source.key) return;
        const hit = await findPulse(current, Number(channel.value), Number(level.value), width.valueAsNumber,
          compare.value === 'lt', reverse, from, job.signal);
        if (job.signal.aborted || this.source()?.key !== source.key) return;
        if (!hit) { result.value = 'No further matching pulse'; return; }
        await this.jump(hit);
        if (job.signal.aborted) return;
        this.resetEdge?.(hit.bit); this.hit = hit; this.redraw();
        result.value = hit.label + ' · sample ' + hit.start.toLocaleString();
      } catch (error) { if (!job.signal.aborted) result.value = String(error); }
      finally { if (!job.signal.aborted) setBusy(false); }
    };
    const buttons = document.createElement('div');
    buttons.className = 'trace-search-actions';
    buttons.append(previous, next, stop);
    this.searchFields.append(channel.el, level.el, compare.el, field('Width (ns)', width), buttons, result);
  }
}
