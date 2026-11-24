// SPDX-License-Identifier: GPL-3.0-or-later
import { expandDecimalSuffix } from './sampleCount.js';

/** Expand typed or pasted engineering quantities in the native number editor.
 * The browser still owns undo, selection, change-on-blur and range/step validation. */
export function initQuantityInputs(): void {
  const expand = (event: Event, text: string) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.type !== 'number' ||
        input.disabled || input.readOnly || !event.cancelable || event.defaultPrevented) return;
    const multiplier = /^[kmg]$/i.test(text);
    const value = expandDecimalSuffix(multiplier ? input.value + text : text);
    if (value === undefined) return;
    event.preventDefault();
    if (multiplier) input.select();
    // insertText edits the native selection and fires input like a keyboard edit.
    document.execCommand('insertText', false, value);
  };
  document.addEventListener('keydown', event => {
    if (!event.isComposing && !event.metaKey && !event.ctrlKey && !event.altKey && /^[kmg]$/i.test(event.key)) {
      if (!event.repeat) expand(event, event.key);
    }
  });
  document.addEventListener('beforeinput', event => {
    if (!event.isComposing && event.inputType === 'insertText' && event.data) expand(event, event.data);
  });
  document.addEventListener('paste', event => {
    const text = event.clipboardData?.getData('text/plain');
    if (text) expand(event, text);
  });
}
