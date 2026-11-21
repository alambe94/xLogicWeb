// SPDX-License-Identifier: GPL-3.0-or-later
import { readBoardStatus } from '../device/eskPairedBoard.js';
import { t } from './i18n.js';

export async function showEskStatus(): Promise<void> {
  const dialog = document.createElement('dialog');
  dialog.className = 'shortcuts-dialog';
  dialog.setAttribute('aria-labelledby', 'esk-status-heading');
  const form = document.createElement('div');
  form.className = 'shortcuts-form';
  const heading = document.createElement('h2');
  heading.id = 'esk-status-heading';
  heading.textContent = t('open.eskStatus');
  const body = document.createElement('pre');
  body.style.whiteSpace = 'pre-wrap';
  body.textContent = t('esk.reading');
  const close = document.createElement('button');
  close.className = 'shortcuts-close';
  close.textContent = t('settings.close');
  close.onclick = () => dialog.close();
  form.append(heading, body, close);
  dialog.append(form);
  dialog.addEventListener('close', () => dialog.remove(), {once: true});
  document.body.append(dialog);
  dialog.showModal();
  try {
    const status = await readBoardStatus();
    body.textContent = [
      t('esk.identity', {id: status.deviceId, boot: status.boot, firmware: status.firmware.toString(16)}), '',
      ...status.features.map(row => `${row.name}/${row.instance}  ${row.enabled ? row.ownership : t('trigger.off')}`),
    ].join('\n');
  } catch (error) { body.textContent = error instanceof Error ? error.message : String(error); }
}
