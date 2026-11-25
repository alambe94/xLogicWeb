// SPDX-License-Identifier: GPL-3.0-or-later
import { ESK_PACKED_RATE } from '../device/eskCapture.js';
import { parseSampleCount } from './sampleCount.js';

export const USB_EIGHT_CHANNEL_MAXIMUM = 2_000_000_000;

/** While a count is being edited, its ordinary input validation controls whether capture can start. */
export function supportsUsbEightChannelCount(rate: number, mode: 'count' | 'untilStop' | 'loop', text: string): boolean {
  return rate === ESK_PACKED_RATE && mode === 'count' && (parseSampleCount(text) ?? 0) <= USB_EIGHT_CHANNEL_MAXIMUM;
}
