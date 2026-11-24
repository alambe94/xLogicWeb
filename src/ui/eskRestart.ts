// SPDX-License-Identifier: GPL-3.0-or-later
import { withBoardManagement, type BoardStatus } from '../device/eskPairedBoard.js';
import { restartBoard } from '../device/eskRestart.js';
import { restartUsbBoard } from '../device/eskUsbHome.js';
import { t } from './i18n.js';

export function initEskRestart() {
  const button = document.querySelector<HTMLButtonElement>('#esk-restart')!;
  const status = document.getElementById('esk-restart-status')!;
  let target: {device: USBDevice | undefined; board: BoardStatus} | undefined;
  button.onclick = async () => {
    const current = target;
    if (!current || button.disabled || !window.confirm(t('home.confirmRestart'))) return;
    button.disabled = true;
    status.textContent = '';
    try {
      if (current.device) await restartUsbBoard(current.device, current.board);
      else await withBoardManagement(current.board, restartBoard);
      if (target === current) status.textContent = t('home.restartAccepted');
    } catch (error) {
      if (target !== current) return;
      status.textContent = error instanceof Error ? error.message : String(error);
      button.disabled = false;
    }
  };
  return (device?: USBDevice, board?: BoardStatus) => {
    if (target && target.device === device && target.board.boot === board?.boot && target.board.deviceId === board?.deviceId) return;
    target = board && board.firmware >= 0x2900 &&
      (device ? board.features.some(f => f.name === 'Device' && f.enabled) : board.networkManagement) ? {device, board} : undefined;
    button.disabled = button.hidden = !target;
    status.textContent = '';
  };
}
