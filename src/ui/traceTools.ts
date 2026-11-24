// SPDX-License-Identifier: GPL-3.0-or-later
import { selectControl, type SelectOptionTuple } from './select.js';
import { findTraceEdge, findPulse, type TraceInput, type TraceHit } from './traceSearch.js';
import { protocolMatches, type ProtocolQuery } from './traceProtocol.js';

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
  private mode = 'pulse';
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
    this.mode = 'pulse';
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
    const container = this.root.querySelector<HTMLElement>('#rec-edge-channel')!;
    const prev = this.root.querySelector<HTMLButtonElement>('#rec-edge-previous')!;
    const next = this.root.querySelector<HTMLButtonElement>('#rec-edge-next')!;
    const cancel = this.root.querySelector<HTMLButtonElement>('#rec-edge-cancel')!;
    const result = this.root.querySelector<HTMLOutputElement>('#rec-edge-result')!;
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
    const apply = async (off: boolean) => {
      const n = off ? 0 : Math.ceil(width.valueAsNumber * source.rate / 1e9);
      if (!Number.isSafeInteger(n) || n < 0 || (!off && !width.validity.valid)) {
        result.value = 'Enter a nonnegative width in ns.'; return;
      }
      result.value = 'Updating waveform…';
      try {
        await this.setFilter(Number(ch.value), n);
        if (this.key === source.key) { this.renderEdges(source); this.renderSearch(); sync(); }
      }
      catch (error) { result.value = String(error); }
    };
    body.append(ch.el, field('Minimum width (ns)', width), action('Apply', () => void apply(false)),
      action('Show raw channel', () => void apply(true)), result);
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
    const tool = selectControl('analysis-tool', 'Find', [['pulse','Pulse'], ['protocol','Protocol']], this.mode);
    tool.addEventListener('change', () => { this.mode = tool.value; this.renderSearch(); });
    this.searchFields.append(tool.el);
    if (this.mode === 'protocol') { this.protocolPanel(source, channels); return; }
    const channel = choice('pulse-channel', 'Channel', channels);
    channel.value = String(this.pulseChannel);
    channel.addEventListener('change', () => { this.pulseChannel = Number(channel.value); });
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
    };
    this.searchFields.append(channel.el, level.el, compare.el, field('Width (ns)', width),
      action('Previous pulse', () => void search(true)), action('Next pulse', () => void search(false)),
      action('Cancel', cancel), result);
  }

  private protocolPanel(source: TraceInput, channels: SelectOptionTuple[]): void {
    const event = choice('event', 'Find', [['nack','I²C NACK'],['address','I²C address'],['uart','UART bytes (8N1)']]);
    const fields = document.createElement('div');
    fields.className = 'trace-options';
    const result = document.createElement('output');
    result.setAttribute('aria-live', 'polite');
    const hits = document.createElement('div');
    hits.className = 'trace-hits';
    let iterator: AsyncGenerator<TraceHit> | undefined;
    let lastProgress = 0;
    let query: () => ProtocolQuery;
    const clear = () => {
      this.job?.abort(); iterator = undefined;
      this.hit = null; this.redraw();
      hits.replaceChildren(); result.value = '';
      more.hidden = true; scan.disabled = false; stop.hidden = true;
    };
    const page = async (fresh: boolean) => {
      if (fresh) clear();
      const job = fresh ? this.job = new AbortController() : this.job!;
      try {
        if (fresh) {
          const current = this.source(job.signal);
          if (!current || current.key !== source.key) return;
          lastProgress = 0;
          iterator = protocolMatches(current, query(), job.signal, position => {
            if (performance.now() - lastProgress > 250 && !job.signal.aborted) {
              lastProgress = performance.now();
              result.value = 'Searching · ' + Math.floor(100 * position / source.length) + '%';
            }
          });
        }
        const stream = iterator;
        if (!stream) return;
        hits.replaceChildren();
        scan.disabled = true; more.hidden = true; stop.hidden = false;
        result.value = 'Searching…';
        for (let count = 0; count < 20; count++) {
          const item = await stream.next();
          if (job.signal.aborted || this.source()?.key !== source.key) return;
          if (item.done) {
            iterator = undefined;
            result.value = count ? 'End of capture' : 'No further matches';
            return;
          }
          const hit = item.value;
          hits.append(action(hit.label + ' · ' + hit.start.toLocaleString(), () => {
            void this.jump(hit).then(() => {
              if (!job.signal.aborted) { this.resetEdge?.(hit.bit); this.hit = hit; this.redraw(); }
            }).catch(e => { if (!job.signal.aborted) result.value = String(e); });
          }));
        }
        result.value = '20 matches'; more.hidden = false;
      } catch (error) {
        if (!job.signal.aborted) result.value = String(error);
      } finally {
        if (!job.signal.aborted) { scan.disabled = false; stop.hidden = true; }
      }
    };
    const scan = action('Search capture', () => void page(true));
    const more = action('More matches', () => void page(false));
    const stop = action('Cancel', clear);
    const render = () => {
      clear();
      const value = document.createElement('input');
      value.className = 'viewer-input';
      if (event.value === 'uart') {
        const rx = choice('rx','RX',channels);
        const baud = document.createElement('input');
        baud.type = 'number'; baud.min = '1'; baud.value = '115200'; baud.className = 'viewer-input';
        value.placeholder = '48 65 6C 6C 6F';
        fields.replaceChildren(rx.el, field('Baud', baud), field('Bytes (hex)', value));
        rx.addEventListener('change', clear);
        query = () => {
          const words = value.value.trim().split(/\s+/);
          if (!Number.isSafeInteger(baud.valueAsNumber) || baud.valueAsNumber < 1 ||
              words.length > 64 || words.some(w => !/^[0-9a-f]{2}$/i.test(w))) throw Error('Enter a valid baud and 1–64 hex byte pairs.');
          return {kind:'uart', rx:Number(rx.value), baud:baud.valueAsNumber, bytes:words.map(w => parseInt(w,16))};
        };
      } else {
        const scl = choice('scl','SCL',channels), sda = choice('sda','SDA',channels);
        sda.value = '1'; value.value = '51';
        fields.replaceChildren(scl.el, sda.el);
        if (event.value === 'address') fields.append(field('7-bit address (hex)', value));
        for (const control of [scl,sda]) control.addEventListener('change', clear);
        query = () => {
          const str = value.value.trim();
          if (event.value === 'address' && !/^(?:0x)?[0-7]?[0-9a-f]$/i.test(str)) throw Error('Enter a 7-bit hexadecimal address.');
          return {kind:'i2c', scl:Number(scl.value), sda:Number(sda.value), address:event.value === 'address' ? parseInt(str,16) : null};
        };
      }
    };
    fields.oninput = clear; event.addEventListener('change', render); render();
    this.searchFields.append(event.el, fields, scan, more, stop, result, hits);
  }
}
