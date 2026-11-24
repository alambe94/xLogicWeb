// SPDX-License-Identifier: GPL-3.0-or-later
import { selectControl, type SelectOptionTuple } from './select.js';
import { findPulse, type TraceInput, type TraceHit } from './traceSearch.js';
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
  readonly root = document.getElementById('trace-tools')!;
  private key: object | undefined;
  private job?: AbortController;
  hit: TraceHit | null = null;
  private mode = 'pulse';
  constructor(private source: (signal?: AbortSignal) => TraceInput | null, private jump: (hit: TraceHit) => Promise<void>,
      private redraw: () => void, private filters: () => ReadonlyMap<number, number>,
      private setFilter: (bit: number, samples: number) => Promise<void>) {
    const toggle = document.getElementById('btn-trace-tools')!;
    window.addEventListener('pagehide', () => this.job?.abort());
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
    const modes: SelectOptionTuple[] = [['pulse','Pulse search'],['filter','Glitch filter'],['protocol','Protocol search']];
    const tool = selectControl('analysis-tool', 'Analysis', modes, this.mode);
    tool.addEventListener('change', () => { this.mode = tool.value; this.refresh(true); });
    this.root.append(tool.el);
    if (this.mode === 'protocol') {
      this.protocolPanel(source, channels);
      return;
    }
    if (this.mode === 'filter') {
      const ch = choice('filter-channel', 'Channel', channels);
      const width = document.createElement('input');
      width.type = 'number'; width.min = '0'; width.step = 'any'; width.className = 'viewer-input';
      const result = document.createElement('output');
      result.setAttribute('aria-live', 'polite');
      const sync = () => {
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
        try { await this.setFilter(Number(ch.value), n); sync(); }
        catch (error) { result.value = String(error); }
      };
      this.root.append(ch.el, field('Minimum width (ns)', width), action('Apply', () => void apply(false)),
        action('Show raw channel', () => void apply(true)), result);
      return;
    }
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
        const current = this.source(job.signal);
        if (!current || current.key !== source.key) return;
        const hit = await findPulse(current, Number(channel.value), Number(level.value), width.valueAsNumber,
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
              if (!job.signal.aborted) { this.hit = hit; this.redraw(); }
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
    this.root.append(event.el, fields, scan, more, stop, result, hits);
  }
}
