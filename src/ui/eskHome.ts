// SPDX-License-Identifier: GPL-3.0-or-later
import { announceBoardView, fromBoard, needsBoardConsent, readBoardStatus } from '../device/eskPairedBoard.js';
import { t } from './i18n.js';

function showRows(body: HTMLTableSectionElement, rows: string[][]): void {
  body.replaceChildren();
  if (!rows.length) {
    const cell = body.insertRow().insertCell();
    cell.colSpan = 5;
    cell.textContent = t('home.empty');
  }
  for (const fields of rows) {
    const row = body.insertRow();
    for (const field of fields) row.insertCell().textContent = field;
  }
}

export function initEskHome(): void {
  const home = document.querySelector<HTMLElement>('#esk-home')!;
  const logic = document.querySelector<HTMLElement>('#app')!;
  const openLogic = document.querySelector<HTMLButtonElement>('#esk-logic')!;
  const goHome = document.querySelector<HTMLButtonElement>('#btn-esk-home')!;
  const refresh = document.querySelector<HTMLButtonElement>('#esk-refresh')!;
  const identity = document.querySelector<HTMLElement>('#esk-identity')!;
  const connection = document.querySelector<HTMLElement>('#esk-connection')!;
  const features = document.querySelector<HTMLDetailsElement>('#esk-features')!;

  const details = document.querySelector<HTMLDetailsElement>('#esk-details')!;
  const services = document.querySelector<HTMLTableSectionElement>('#esk-services')!;
  const resources = document.querySelector<HTMLTableSectionElement>('#esk-resources')!;

  async function updateStatus(userRequested = false): Promise<void> {
    if (refresh.disabled) return;
    identity.hidden = features.hidden = details.hidden = true;
    refresh.hidden = !fromBoard();
    if (refresh.hidden) {
      connection.textContent = t('home.unpaired');
      return;
    }
    const label = needsBoardConsent() ? 'toolbar.connect' : 'capturePanel.tempRate';
    refresh.dataset.i18n = label;
    refresh.textContent = t(label);
    if (needsBoardConsent() && !userRequested) {
      connection.textContent = '';
      return;
    }
    refresh.disabled = true;
    connection.textContent = t('esk.reading');
    try {
      const board = await readBoardStatus();
      refresh.dataset.i18n = 'capturePanel.tempRate';
      refresh.textContent = t('capturePanel.tempRate');
      connection.textContent = '';
      identity.textContent = t('esk.identity', {id: board.deviceId, boot: board.boot, firmware: board.firmware.toString(16)});
      identity.hidden = false;
      const rows = board.features.map(feature => {
        const li = document.createElement('li');
        li.textContent = `${feature.name}/${feature.instance} · ${feature.enabled ? feature.ownership : t('trigger.off')}`;
        return li;
      });
      features.querySelector('ul')!.replaceChildren(...rows);
      features.hidden = !rows.length;
      if (board.catalog) {
        showRows(services, board.catalog.services);
        showRows(resources, board.catalog.resources);
        details.hidden = false;
      }
    } catch (error) {
      connection.textContent = error instanceof Error ? error.message : String(error);
    } finally { refresh.disabled = false; }
  }

  let portableView: 'home' | 'logic' = 'logic';
  function display(focus: boolean): void {
    const params = new URL(location.href).searchParams;
    const view = location.protocol === 'file:' ? portableView : params.get('view');
    // Existing portable, bridge and diagnostic entry points open the analyzer.
    const atHome = view === 'home' || (view === null && location.protocol !== 'file:' &&
      !params.size && !location.pathname.endsWith('/esk.html'));
    home.hidden = !atHome;
    logic.hidden = atHome;
    logic.inert = atHome;
    document.title = atHome ? 'xEskWeb' : t('app.title');
    if (atHome) {
      if (focus) document.getElementById('esk-home-title')!.focus();
      void updateStatus();
    } else if (focus) { goHome.focus(); }
  }
  function navigate(view: 'home' | 'logic'): void {
    const url = new URL(location.href);
    url.searchParams.set('view', view);
    if (location.protocol === 'file:') portableView = view;
    else history.pushState(null, '', url);
    display(true);
  }
  openLogic.onclick = () => navigate('logic');
  goHome.onclick = () => navigate('home');
  refresh.onclick = () => void updateStatus(true);
  window.addEventListener('popstate', () => display(true));
  display(false);
  announceBoardView();
}
