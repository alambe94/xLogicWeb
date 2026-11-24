// SPDX-License-Identifier: GPL-3.0-or-later
import { validBoardName } from '../device/eskBoardName.js';
import type { BoardStatus } from '../device/eskPairedBoard.js';
import { usbBoardName } from '../device/eskUsbHome.js';
import { t } from './i18n.js';

export function initBoardName() {
  const panel = document.querySelector<HTMLDetailsElement>('#esk-network')!;
  const form = document.querySelector<HTMLFormElement>('#esk-name-form')!;
  const name = document.querySelector<HTMLInputElement>('#esk-name-input')!;
  const save = document.querySelector<HTMLButtonElement>('#esk-name-save')!;
  const status = document.getElementById('esk-name-status')!;
  let target: {device: USBDevice; board: BoardStatus} | undefined;
  let busy = false;
  async function update(write: boolean) {
    const active = target;
    if (!active || busy) return;
    busy = true;
    name.disabled = save.disabled = true;
    status.textContent = t(write ? 'home.savingName' : 'esk.reading');
    try {
      const result = await usbBoardName(active.device, active.board, write ? name.value : undefined);
      if (target !== active) return;
      name.value = result.name;
      status.textContent = result.advertised ? t('home.savedName', {name: result.advertised}) : '';
      name.disabled = save.disabled = false;
    } catch (err) {
      if (target !== active) return;
      status.textContent = (err instanceof Error ? err.message : String(err)) + ' ' + t('home.refreshNetwork');
    } finally { if (target === active) busy = false; }
  }
  panel.ontoggle = () => { if (panel.open) void update(false); };
  name.oninput = () => name.setCustomValidity('');
  form.onsubmit = e => {
    e.preventDefault();
    if (!validBoardName(name.value)) {
      name.setCustomValidity(t('home.boardNameHint'));
      name.reportValidity();
      return;
    }
    void update(true);
  };
  return (device?: USBDevice, board?: BoardStatus) => {
    if (target && target.device === device && target.board.boot === board?.boot) return;
    target = device && board && board.firmware >= 0x2800 && board.features.some(f => f.name === 'Device' && f.enabled)
      ? {device, board} : undefined;
    panel.open = false;
    panel.hidden = !target;
    busy = false;
    name.value = '';
    name.setCustomValidity('');
    status.textContent = '';
    name.disabled = save.disabled = true;
  };
}
