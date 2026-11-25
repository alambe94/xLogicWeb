// SPDX-License-Identifier: GPL-3.0-or-later

/** Summarize a finite eight-channel trace in capture time, independent of block boundaries. */
export class DownloadActivity {
  readonly first = 0;
  readonly stride: number;
  readonly bins: Uint16Array;
  end = 0;

  constructor(readonly count: number, readonly rate: number) {
    this.stride = Math.ceil(count / 4096);
    this.bins = new Uint16Array(Math.ceil(count / this.stride));
  }

  append(block: Uint8Array): void {
    if (block.length > this.count - this.end) throw new RangeError('Download exceeds capture size');
    let pos = 0;
    while (pos < block.length) {
      const index = Math.floor(this.end / this.stride), used = this.end % this.stride;
      const stop = Math.min(block.length, pos + this.stride - used);
      let all = used ? this.bins[index]! & 255 : 255;
      let any = used ? this.bins[index]! >>> 8 : 0;
      this.end += stop - pos;
      for (; pos < stop; pos++) {
        all &= block[pos]!;
        any |= block[pos]!;
      }
      this.bins[index] = all | (any << 8);
    }
  }
}
