// SPDX-License-Identifier: GPL-3.0-or-later
import { supportsUsbEightChannelCount, USB_EIGHT_CHANNEL_MAXIMUM } from '../eskUsbChannels.js';

for (const [count, expected] of [
  ['1', true], ['1.999999999G', true], [String(USB_EIGHT_CHANNEL_MAXIMUM), true],
  ['2G', false], ['2000000000', false], ['2000M', false], ['2e9', false], ['2.000000001G', false],
  ['4G', false], ['', true],
] as const) {
  if (supportsUsbEightChannelCount(500000000, 'count', count) !== expected) throw Error('USB bank boundary at ' + count);
}
for (const mode of ['untilStop', 'loop'] as const) {
  if (supportsUsbEightChannelCount(500000000, mode, '100K')) throw Error('Four channels required for ' + mode);
}
if (supportsUsbEightChannelCount(333333333, 'count', '2M')) throw Error('USB bank selection only applies at 500 MS/s');
console.log('USB 500 MS/s bank selection passed');
