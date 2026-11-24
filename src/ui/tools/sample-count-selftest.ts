// SPDX-License-Identifier: GPL-3.0-or-later
import { expandDecimalSuffix, parseSampleCount } from '../sampleCount.js';

for (const [input, expected] of [
  ['1000', 1000], ['1k', 1000], ['100K', 100000], ['1M', 1000000],
  [' 5g ', 5000000000], ['1.25 M', 1250000], ['.001K', 1], ['1e3', 1000],
  ['9007199.254740991G', Number.MAX_SAFE_INTEGER],
] as const) {
  if (parseSampleCount(input) !== expected) throw Error('Incorrect count for ' + input);
}
for (const input of ['', '0', '-1K', '1.5', '0.0001K', '1GB', '1KM', '0x10', '1e999',
  '9007199254740991.1', '9007199.254740992G']) {
  if (parseSampleCount(input) !== undefined) throw Error('Unexpected valid count: ' + input);
}
if (parseSampleCount('5G', 2147483520) !== undefined || parseSampleCount('2G', 2147483520) !== 2000000000) {
  throw Error('Ethernet board limit not applied');
}
console.log('Sample-count units, exact integers and board limit passed.');

for (const [text, expected] of [['1M', '1000000'], ['115.2k', '115200'], ['-.002K', '-2'],
  ['0.00001G', '10000'], ['9.00025k', '9000.25'], ['0k', '0'], ['1mV', undefined], ['1e3k', undefined]]) {
  if (expandDecimalSuffix(text!) !== expected) throw Error('Incorrect quantity for ' + text);
}
