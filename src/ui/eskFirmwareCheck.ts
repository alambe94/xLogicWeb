// SPDX-License-Identifier: GPL-3.0-or-later
import { verifyFirmware } from '../device/eskSignedFirmware.js';
import { t } from './i18n.js';

export function initFirmwareCheck() {
  const button = document.querySelector<HTMLButtonElement>('#esk-firmware-check')!;
  const input = document.querySelector<HTMLInputElement>('#esk-firmware-files')!;
  const result = document.getElementById('esk-firmware-result')!;
  const spki = import.meta.env.VITE_ESK_SIGNER_SPKI, keyId = import.meta.env.VITE_ESK_SIGNER_ID;
  let target: { hardware: number; version: number } | undefined;
  button.onclick = () => { input.value = ''; input.click(); };
  input.onchange = async () => {
    const board = target;
    if (!board) return;
    const files = Array.from(input.files ?? []);
    const image = files.find(f => /\.appimage$/i.test(f.name)), record = files.find(f => /\.sig$/i.test(f.name));
    try {
      if (files.length !== 2 || !image || !record || record.size !== 148 || image.size > 0x800000 - 148) {
        throw new Error('Select an image and its signature');
      }
      button.disabled = true;
      const version = await verifyFirmware(await image.arrayBuffer(), await record.arrayBuffer(), board.hardware,
        keyId, Uint8Array.from(atob(spki), c => c.charCodeAt(0)).buffer);
      if (target !== board) return;
      const value = [version >>> 16, version >>> 8 & 255, version & 255].join('.');
      result.textContent = t(version > board.version ? 'home.firmwareNewer' :
        version < board.version ? 'home.firmwareOlder' : 'home.firmwareCurrent', {version: value});
    } catch {
      if (target === board) result.textContent = t('home.firmwareInvalid');
    } finally { button.disabled = false; }
  };
  return (hardware?: number, version?: number) => {
    target = hardware === 0x534b3634 && version !== undefined ? {hardware, version} : undefined;
    button.hidden = !(target && keyId && spki && globalThis.crypto?.subtle);
    result.textContent = '';
  };
}
