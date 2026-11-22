// SPDX-License-Identifier: GPL-3.0-or-later
// Two successive four-bit samples per byte, earliest in the low nibble.
function sample(block: Uint8Array, i: number): number {
  return (block[i >>> 1]! >>> (4 * (i & 1))) & 15;
}

// While the selected line is idle, skip eight samples per comparison.
function firstLevel(block: Uint8Array, start: number, bit: number, high: boolean): number {
  const end = block.length * 2;
  const words = block.byteOffset % 4 === 0
    ? new Uint32Array(block.buffer, block.byteOffset, Math.floor(block.length / 4)) : null;
  const mask = (0x11111111 * bit) >>> 0;
  const absent = high ? 0 : mask;
  let i = start;
  while (i < end) {
    if (words && !(i & 7)) {
      let word = i >>> 3;
      while (word < words.length && ((words[word]! & mask) >>> 0) === absent) word++;
      i = word * 8;
      if (i === end) break;
    }
    if (!!(sample(block, i) & bit) === high) return i;
    i++;
  }
  return -1;
}

/** One bounded result buffer doubles as the sliding pre-trigger history. */
export class PackedEdgeWindow {
  private readonly data: Uint8Array<ArrayBuffer>;
  private history = 0;
  private previous: number | undefined;
  private written: number | undefined;
  constructor(count: number, private readonly pre: number, private readonly channel: number,
      private readonly rising: boolean) {
    if (!Number.isInteger(count) || count < 1 || count > 65536 || !Number.isInteger(pre) || pre < 0 ||
        pre >= count || !Number.isInteger(channel) || channel < 0 || channel > 3) throw Error('Invalid packed trigger window');
    this.data = new Uint8Array(count);
  }

  push(block: Uint8Array): Uint8Array<ArrayBuffer> | undefined {
    const size = block.length * 2;
    if (!size) return;
    let start = 0;
    if (this.written === undefined) {
      // Edges during initial history fill cannot supply the requested prefix.
      const eligible = Math.min(size, this.pre - this.history);
      const before = eligible ? sample(block, eligible - 1) : this.previous;
      const bit = 1 << this.channel;
      let edge = -1;
      if (eligible < size) {
        const ready = before !== undefined && !!(before & bit) !== this.rising;
        if (ready) edge = firstLevel(block, eligible, bit, this.rising);
        else {
          const opposite = firstLevel(block, eligible, bit, !this.rising);
          if (opposite >= 0) edge = firstLevel(block, opposite + 1, bit, this.rising);
        }
      }
      const end = edge < 0 ? size : edge;
      const take = Math.min(this.pre, end);
      const keep = Math.min(this.history, this.pre - take);
      this.data.copyWithin(0, this.history - keep, this.history);
      for (let i = 0; i < take; i++) this.data[keep + i] = sample(block, end - take + i);
      this.history = keep + take;
      this.previous = sample(block, size - 1);
      if (edge < 0) return;
      this.written = this.pre;
      start = edge;
    }
    const count = Math.min(size - start, this.data.length - this.written);
    for (let i = 0; i < count; i++) this.data[this.written + i] = sample(block, start + i);
    this.written += count;
    if (this.written === this.data.length) return this.data;
  }
}
