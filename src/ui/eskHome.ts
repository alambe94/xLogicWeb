// SPDX-License-Identifier: GPL-3.0-or-later
import { announceBoardView, fromBoard, needsBoardConsent, readBoardStatus } from '../device/eskPairedBoard.js';
import { requestEskDevice, selectedEskUsbDevice, selectEskUsbDevice } from '../device/eskCapture.js';
import { initBridgeTools } from './eskBridge.js';
import { readUsbBoardStatus } from '../device/eskUsbHome.js';
import type { BoardStatus } from '../device/eskPairedBoard.js';
import { t } from './i18n.js';
import { nativeRecorderAvailable } from './nativeArchive.js';

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
  const change = document.querySelector<HTMLButtonElement>('#esk-change')!;
  const identity = document.querySelector<HTMLElement>('#esk-identity')!;
  const connection = document.querySelector<HTMLElement>('#esk-connection')!;
  const features = document.querySelector<HTMLDetailsElement>('#esk-features')!;

  const newLogic = document.querySelector<HTMLAnchorElement>('#esk-logic-tab')!;
  const newBridge = document.querySelector<HTMLAnchorElement>('#esk-bridge-tab')!;
  const usbSite = document.querySelector<HTMLAnchorElement>('#esk-usb-site')!;
  const lanChoice = document.querySelector<HTMLDetailsElement>('#esk-lan-choice')!;
  const address = document.querySelector<HTMLInputElement>('#esk-board-address')!;
  const form = document.querySelector<HTMLFormElement>('#esk-board-form')!;
  const browserSite = new URL(location.href);
  browserSite.search = browserSite.hash = '';
  usbSite.href = browserSite.href;
  const paired = fromBoard();
  const nativeHome = nativeRecorderAvailable();
  usbSite.hidden = !paired;
  lanChoice.hidden = paired || location.protocol === 'file:';
  newLogic.hidden = paired || location.protocol === 'file:';
  newBridge.hidden = location.protocol === 'file:';
  document.getElementById('esk-analysis-demo')!.hidden = location.protocol === 'file:';
  for (const [link, view] of [[newLogic, 'logic'], [newBridge, 'bridge']] as const) {
    const url = new URL(browserSite);
    url.searchParams.set('view', view);
    link.href = url.href;
  }
  address.oninput = () => address.setCustomValidity('');
  form.onsubmit = event => {
    event.preventDefault();
    const match = /^(?:http:\/\/)?(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?\/?$/i.exec(address.value.trim());
    const port = Number(match?.[2] ?? 5555);
    if (!match || match[1]!.split('.').some(part => String(Number(part)) !== part || Number(part) > 255) ||
        port < 1 || port > 65535) {
      address.setCustomValidity(t('home.invalidAddress'));
      address.reportValidity();
      return;
    }
    location.assign('http://' + match[1] + ':' + port + '/');
  };

  const details = document.querySelector<HTMLDetailsElement>('#esk-details')!;
  const services = document.querySelector<HTMLTableSectionElement>('#esk-services')!;
  const resources = document.querySelector<HTMLTableSectionElement>('#esk-resources')!;

  const bridge = document.querySelector<HTMLElement>('#esk-bridge-page')!;
  const openBridge = document.querySelector<HTMLButtonElement>('#esk-bridge')!;
  const setBridge = initBridgeTools();
  const bridgeConnect = document.querySelector<HTMLButtonElement>('#bridge-connect')!;
  const result = document.querySelector<HTMLOutputElement>('#bridge-result')!;
  const dock = document.querySelector<HTMLElement>('#bridge-dock')!;
  const toggle = document.querySelector<HTMLButtonElement>('#btn-bridge-panel')!;
  const controls = document.querySelector<HTMLElement>('#bridge-controls')!;
  const standalone = controls.parentElement!;
  toggle.onclick = () => {
    dock.hidden = !dock.hidden;
    toggle.setAttribute('aria-expanded', String(!dock.hidden));
    if (!dock.hidden && !paired) void updateStatus();
  };
  let usbDevice: USBDevice | undefined, usbStatus: BoardStatus | undefined;
  let generation = 0, disconnected = false;
  function syncBridgeConnect(): void {
    bridgeConnect.hidden = !!usbStatus || !navigator.usb;
    bridgeConnect.disabled = refresh.disabled;
    if (!navigator.usb) result.value = t('diagnostic.usb.unavailable');
  }
  bridgeConnect.onclick = () => {
    if (paired) newBridge.click();
    else void updateStatus(true);
  };
  syncBridgeConnect();

  async function updateStatus(userRequested = false): Promise<void> {
    if (refresh.disabled) return;
    const lan = fromBoard();
    if (!lan && !usbDevice) usbDevice = selectedEskUsbDevice();
    if (!lan && usbStatus && !userRequested) return;
    identity.hidden = features.hidden = details.hidden = true;
    refresh.hidden = !lan && !navigator.usb;
    const label = lan ? (needsBoardConsent() ? 'home.connectLan' : 'capturePanel.tempRate')
      : usbDevice ? 'capturePanel.tempRate' : 'home.connectUsb';
    refresh.dataset.i18n = label;
    refresh.textContent = t(label);
    if ((lan && needsBoardConsent() && !userRequested) || (!lan && (!navigator.usb || (!usbDevice && !userRequested)))) {
      connection.textContent = lan ? '' : t(disconnected ? 'home.usbGone' : nativeHome ? 'home.nativeConnection' : 'home.unpaired');
      return;
    }
    change.hidden = true;
    refresh.disabled = true;
    syncBridgeConnect();
    connection.textContent = t('esk.reading');
    const token = ++generation;
    openLogic.disabled = !lan;
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
        change.hidden = false;
        setBridge(usbDevice, board);
      }
      refresh.dataset.i18n = 'capturePanel.tempRate';
      refresh.textContent = t('capturePanel.tempRate');
      connection.textContent = lan ? 'Ethernet' : 'USB';
      identity.textContent = t('esk.identity', {id: board.deviceId, boot: board.boot, firmware: board.firmware.toString(16)});
      identity.hidden = false;
      const rows = board.features.map(f => [f.name, String(f.instance), f.enabled ? f.ownership : t('trigger.off')]);
      showRows(document.querySelector<HTMLTableSectionElement>('#esk-feature-rows')!, rows);
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
        setBridge();
        result.value = '';
        refresh.dataset.i18n = 'home.connectUsb'; refresh.textContent = t('home.connectUsb');
      }
      connection.textContent = error instanceof DOMException && error.name === 'NotFoundError' ? t('home.unpaired') :
        error instanceof Error ? error.message : String(error);
      if (!lan) result.value = error instanceof DOMException && error.name === 'NotFoundError' ? '' : connection.textContent;
    } finally {
      if (token === generation) { refresh.disabled = false; openLogic.disabled = false; syncBridgeConnect(); }
    }
  }

  navigator.usb?.addEventListener('disconnect', event => {
    if (event.device !== usbDevice) return;
    generation++;
    change.hidden = true;
    disconnected = true;
    usbDevice = undefined; usbStatus = undefined; selectEskUsbDevice();
    setBridge();
    result.value = t('home.usbGone');
    identity.hidden = features.hidden = details.hidden = true;
    refresh.disabled = openLogic.disabled = false;
    syncBridgeConnect();
    refresh.dataset.i18n = 'home.connectUsb'; refresh.textContent = t('home.connectUsb');
    connection.textContent = t('home.usbGone');
  });

  let portableView: 'home' | 'logic' | 'bridge' = 'logic';
  function display(focus: boolean): void {
    const params = new URL(location.href).searchParams;
    const view = location.protocol === 'file:' ? portableView : params.get('view');
    // Existing portable, bridge and diagnostic entry points open the analyzer.
    const atBridge = view === 'bridge';
    const atHome = view === 'home' || (view === null && location.protocol !== 'file:' &&
      !params.size && !location.pathname.endsWith('/esk.html'));
    const host = atBridge || atHome ? standalone : dock;
    if (controls.parentElement !== host) host.appendChild(controls);
    home.hidden = !atHome;
    bridge.hidden = !atBridge;
    logic.hidden = logic.inert = atHome || atBridge;
    document.title = atHome ? 'xEskWeb' : atBridge ? 'xBridgeWeb' : t('app.title');
    if (atHome) {
      if (focus) document.getElementById('esk-home-title')!.focus();
      void updateStatus();
    } else {
      if (focus) (atBridge ? document.getElementById('bridge-title')! : goHome).focus();
      if (atBridge && !paired) void updateStatus();
    }
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
  change.onclick = async () => {
    if (change.disabled || refresh.disabled) return;
    change.disabled = refresh.disabled = true;
    try {
      const device = await requestEskDevice(true);
      if (device !== usbDevice) {
        setBridge();
        usbStatus = undefined;
        result.value = '';
      }
      usbDevice = device;
      refresh.disabled = false;
      await updateStatus(true);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'NotFoundError')) connection.textContent = String(error);
    } finally { change.disabled = refresh.disabled = false; }
  };
  refresh.onclick = () => void updateStatus(true);
  window.addEventListener('popstate', () => display(true));
  display(false);
  announceBoardView();
}
