// SPDX-License-Identifier: GPL-3.0-or-later
import { validBoardName, readBoardPolicy, saveBoardName } from '../device/eskBoardName.js';
import { withBoardManagement, type BoardStatus } from '../device/eskPairedBoard.js';
import { usbBoardName } from '../device/eskUsbHome.js';
import { t } from './i18n.js';

export function initBoardName() {
  const panel = document.querySelector<HTMLDetailsElement>('#esk-network')!;
  const form = document.querySelector<HTMLFormElement>('#esk-name-form')!;
  const hint = document.getElementById('esk-name-connect')!;
  const help = document.getElementById('esk-name-help')!;
  const name = document.querySelector<HTMLInputElement>('#esk-name-input')!;
  const save = document.querySelector<HTMLButtonElement>('#esk-name-save')!;
  const status = document.getElementById('esk-name-status')!;
  let target: {device: USBDevice | undefined; board: BoardStatus} | undefined;
  let busy = false;
  async function update(write: boolean) {
    const active = target;
    if (!active || busy) return;
    busy = true;
    name.disabled = save.disabled = true;
    status.textContent = t(write ? 'home.savingName' : 'esk.reading');
    try {
      const requested = write ? name.value : undefined;
      const result = active.device ? await usbBoardName(active.device, active.board, requested) :
        await withBoardManagement(active.board, async exchange => {
          const service = async (p: Uint8Array) => {
            const r = await exchange(p);
            return new DataView(r.buffer, r.byteOffset, r.byteLength);
          };
          const query = new Uint8Array(16);
          query.set([0x4e, 1, 6]);
          const port = {service, status: () => service(query), stageBeforeSave: true};
          return requested === undefined ? {name: (await readBoardPolicy(port)).name, advertised: undefined}
            : {name: requested, advertised: await saveBoardName(port, requested)};
        });
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
  function setTarget(device?: USBDevice, board?: BoardStatus) {
    if (target && target.device === device && target.board.deviceId === board?.deviceId && target.board.boot === board.boot) return;
    target = board && (device ? board.firmware >= 0x2800 && board.features.some(f => f.name === 'Device' && f.enabled) : board.networkManagement)
      ? {device, board} : undefined;
    form.hidden = help.hidden = !target;
    hint.hidden = !!target;
    const message = !board ? 'home.nameConnect' : board.firmware < 0x2800 ? 'home.nameFirmware' : 'home.nameViaUsb';
    hint.dataset.i18n = message;
    hint.textContent = t(message);
    busy = false;
    name.value = '';
    name.setCustomValidity('');
    status.textContent = '';
    name.disabled = save.disabled = true;
    if (target && panel.open) void update(false);
  }
  setTarget();
  return setTarget;
}
