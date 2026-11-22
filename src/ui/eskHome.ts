// SPDX-License-Identifier: GPL-3.0-or-later
import { announceBoardView, fromBoard, needsBoardConsent, readBoardStatus } from '../device/eskPairedBoard.js';
import { requestEskDevice, selectEskUsbDevice } from '../device/eskCapture.js';
import { readUsbBoardStatus, readUsbBoardId } from '../device/eskUsbHome.js';
import type { BoardStatus } from '../device/eskPairedBoard.js';
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

  const bridge = document.querySelector<HTMLElement>('#esk-bridge-page')!;
  const openBridge = document.querySelector<HTMLButtonElement>('#esk-bridge')!;
  const boardId = document.querySelector<HTMLButtonElement>('#bridge-read')!;
  const result = document.querySelector<HTMLOutputElement>('#bridge-result')!;
  let usbDevice: USBDevice | undefined, usbStatus: BoardStatus | undefined;
  let generation = 0, disconnected = false;

  function enableBridge(available: boolean) {
    openBridge.hidden = !available;
    boardId.disabled = !available;
  }

  async function updateStatus(userRequested = false): Promise<void> {
    if (refresh.disabled) return;
    const lan = fromBoard();
    if (!lan && usbStatus && !userRequested) return;
    identity.hidden = features.hidden = details.hidden = true;
    refresh.hidden = !lan && !navigator.usb;
    const label = lan ? (needsBoardConsent() ? 'toolbar.connect' : 'capturePanel.tempRate')
      : usbDevice ? 'capturePanel.tempRate' : 'home.connectUsb';
    refresh.dataset.i18n = label;
    refresh.textContent = t(label);
    if ((lan && needsBoardConsent() && !userRequested) || (!lan && (!navigator.usb || (!usbDevice && !userRequested)))) {
      connection.textContent = lan ? '' : t(disconnected ? 'home.usbGone' : 'home.unpaired');
      return;
    }
    refresh.disabled = true;
    connection.textContent = t('esk.reading');
    const token = ++generation;
    openLogic.disabled = !lan;
    enableBridge(false);
    try {
      if (!lan && !usbDevice) {
        const device = await requestEskDevice();
        if (token !== generation) return;
        usbDevice = device;
      }
      const board = lan ? await readBoardStatus() : await readUsbBoardStatus(usbDevice!);
      if (token !== generation) return;
      if (!lan) {
        if (usbStatus?.boot !== board.boot) result.value = '';
        disconnected = false;
        usbStatus = board;
        selectEskUsbDevice(usbDevice);
        enableBridge(board.features.some(f => f.name === 'I2C' && f.instance === 0 && f.enabled));
      }
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
      if (token !== generation) return;
      if (!lan) {
        usbDevice = undefined; usbStatus = undefined; selectEskUsbDevice();
        result.value = '';
        refresh.dataset.i18n = 'home.connectUsb'; refresh.textContent = t('home.connectUsb');
      }
      connection.textContent = error instanceof DOMException && error.name === 'NotFoundError' ? t('home.unpaired') :
        error instanceof Error ? error.message : String(error);
    } finally {
      if (token === generation) { refresh.disabled = false; openLogic.disabled = false; }
    }
  }

  boardId.onclick = async () => {
    if (!usbDevice || !usbStatus || boardId.disabled) return;
    const token = generation;
    boardId.disabled = true;
    result.value = t('esk.reading');
    try {
      const value = await readUsbBoardId(usbDevice, usbStatus);
      if (token === generation) result.value = value;
    } catch (error) {
      if (token === generation) result.value = error instanceof Error ? error.message : String(error);
    } finally { if (token === generation) boardId.disabled = false; }
  };
  navigator.usb?.addEventListener('disconnect', event => {
    if (event.device !== usbDevice) return;
    generation++;
    disconnected = true;
    usbDevice = undefined; usbStatus = undefined; selectEskUsbDevice();
    enableBridge(false);
    result.value = t('home.usbGone');
    identity.hidden = features.hidden = details.hidden = true;
    refresh.disabled = openLogic.disabled = false;
    refresh.dataset.i18n = 'home.connectUsb'; refresh.textContent = t('home.connectUsb');
    connection.textContent = t('home.usbGone');
  });

  let portableView: 'home' | 'logic' | 'bridge' = 'logic';
  function display(focus: boolean): void {
    const params = new URL(location.href).searchParams;
    const view = location.protocol === 'file:' ? portableView : params.get('view');
    // Existing portable, bridge and diagnostic entry points open the analyzer.
    const atBridge = view === 'bridge' && !!usbStatus;
    const atHome = view === 'home' || (view === 'bridge' && !atBridge) || (view === null && location.protocol !== 'file:' &&
      !params.size && !location.pathname.endsWith('/esk.html'));
    home.hidden = !atHome;
    bridge.hidden = !atBridge;
    logic.hidden = logic.inert = atHome || atBridge;
    document.title = atHome ? 'xEskWeb' : atBridge ? 'xBridgeWeb' : t('app.title');
    if (atHome) {
      if (focus) document.getElementById('esk-home-title')!.focus();
      void updateStatus();
    } else if (focus) { (atBridge ? document.getElementById('bridge-title')! : goHome).focus(); }
  }
  function navigate(view: 'home' | 'logic' | 'bridge'): void {
    const url = new URL(location.href);
    url.searchParams.set('view', view);
    if (location.protocol === 'file:') portableView = view;
    else history.pushState(null, '', url);
    display(true);
  }
  openBridge.onclick = () => navigate('bridge');
  document.querySelector<HTMLButtonElement>('#bridge-home')!.onclick = () => navigate('home');
  openLogic.onclick = () => navigate('logic');
  goHome.onclick = () => navigate('home');
  refresh.onclick = () => void updateStatus(true);
  window.addEventListener('popstate', () => display(true));
  display(false);
  announceBoardView();
}
