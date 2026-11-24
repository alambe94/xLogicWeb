// SPDX-License-Identifier: GPL-3.0-or-later
import { announceBoardView, fromBoard, needsBoardConsent, readBoardStatus } from '../device/eskPairedBoard.js';
import { requestEskDevice, selectedEskUsbDevice, selectEskUsbDevice } from '../device/eskCapture.js';
import { initBridgeTools } from './eskBridge.js';
import { readUsbBoardStatus } from '../device/eskUsbHome.js';
import type { BoardStatus } from '../device/eskPairedBoard.js';
import { onLocaleChange, t } from './i18n.js';
import { aboutView } from './about.js';
import { initFirmwareCheck } from './eskFirmwareCheck.js';
import { initBoardName } from './eskBoardName.js';
import { initEskRestart } from './eskRestart.js';
import { boardAddress } from '../device/eskBoardName.js';
import { localBoard, localEthernetAvailable, selectLocalBoard } from '../device/eskLocalBoard.js';
import { applyUpdate, getUpdateState, onUpdateStateChange } from './pwaUpdate.js';
import { nativeRecorderAvailable, nativeRequest } from './nativeArchive.js';

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
  const localConnect = document.querySelector<HTMLButtonElement>('#esk-connect-local')!;
  const directConnect = document.querySelector<HTMLButtonElement>('#esk-connect-address')!;
  const localAvailable = localEthernetAvailable();
  let discovered: string | undefined;
  localConnect.hidden = !localAvailable;
  if (localAvailable) {
    directConnect.dataset.i18n = 'home.openBoardAddress';
    directConnect.textContent = t('home.openBoardAddress');
  }
  const browserSite = new URL(location.href);
  browserSite.search = browserSite.hash = '';
  usbSite.href = browserSite.href;
  const localSelection = localBoard();
  if (localSelection) {
    usbSite.target = '_self';
    usbSite.dataset.i18n = 'home.changeConnection';
    usbSite.textContent = t('home.changeConnection');
  }
  const paired = fromBoard();
  const nativeHome = nativeRecorderAvailable();
  const discovery = document.getElementById('esk-lan-boards')!;
  if (nativeHome && document.querySelector('meta[data-discovery]')) {
    discovery.hidden = false;
    const scan = document.querySelector<HTMLButtonElement>('#esk-lan-scan')!;
    const status = document.getElementById('esk-lan-scan-status')!;
    const results = document.getElementById('esk-lan-results')!;
    scan.onclick = async () => {
      scan.disabled = true;
      results.replaceChildren();
      status.textContent = 'Searching the local network…';
      try {
        const boards: {id: string; name: string; address: string; port: number; alias: string}[] =
          await (await nativeRequest('discover')).json();
        status.textContent = boards.length ? '' : 'No boards found. Try again or enter the address below.';
        for (const board of boards) {
          const row = document.createElement('div');
          const connect = document.createElement('button'), rename = document.createElement('button');
          connect.className = rename.className = 'mini';
          connect.type = rename.type = 'button';
          connect.textContent = board.alias || board.name;
          connect.title = board.name + '.local · ' + board.address + ':' + board.port;
          connect.onclick = () => { address.value = board.address + ':' + board.port; discovered = board.id; address.setCustomValidity(''); form.requestSubmit(); };
          rename.textContent = 'Rename on this laptop';
          rename.onclick = async () => {
            const value = window.prompt('Board name on this laptop', board.alias || board.name);
            if (value === null) return;
            try {
              board.alias = await (await nativeRequest('name_board', {id: board.id, name: value})).json();
              connect.textContent = board.alias || board.name;
            } catch (error) { status.textContent = String(error); }
          };
          row.append(connect, rename);
          results.append(row);
        }
      } catch (error) { status.textContent = String(error); }
      finally { scan.disabled = false; }
    };
    lanChoice.addEventListener('toggle', () => { if (lanChoice.open && !scan.disabled) scan.click(); });
  }
  const setFirmwareTarget = initFirmwareCheck();
  const setBoardName = initBoardName();
  const setRestart = initEskRestart();
  function setNetworkTarget(device?: USBDevice, board?: BoardStatus) {
    setBoardName(device, board);
    setRestart(device, board);
  }
  const firmware = document.getElementById('esk-firmware')!;
  const firmwareGuide = document.getElementById('esk-firmware-guide')!;
  const webBuild = document.getElementById('esk-web-build')!;
  const recorder = document.getElementById('esk-recorder-version')!;
  const update = document.querySelector<HTMLButtonElement>('#esk-web-update')!;
  let recorderBuild = '';
  let boardFirmware: number | undefined;
  function renderVersions(): void {
    firmware.textContent = boardFirmware === undefined ? t('home.boardDisconnected') :
      [boardFirmware >>> 16, (boardFirmware >>> 8) & 255, boardFirmware & 255].join('.');
    firmwareGuide.hidden = boardFirmware === undefined;
    webBuild.textContent = aboutView().version;
    recorder.textContent = nativeHome ? recorderBuild || t('home.versionUnknown') : t('home.recorderDisconnected');
    update.hidden = getUpdateState() !== 'ready';
  }
  update.onclick = applyUpdate;
  onUpdateStateChange(renderVersions);
  onLocaleChange(renderVersions);
  renderVersions();
  if (nativeHome) {
    void nativeRequest('version').then(reply => reply.json()).then(info => {
      if (!/^[0-9a-f]{64}$/.test(info?.sha256)) return;
      recorderBuild = typeof info.version === 'string' && info.version ? info.version : 'SHA-256 ' + info.sha256.slice(0, 12);
      recorder.title = 'SHA-256 ' + info.sha256;
      renderVersions();
    }).catch(() => { /* Older recorder helpers do not report their build. */ });
  }
  usbSite.hidden = !paired;
  lanChoice.hidden = paired || location.protocol === 'file:';
  newLogic.hidden = (paired && !localSelection) || location.protocol === 'file:';
  newBridge.hidden = location.protocol === 'file:';
  document.getElementById('esk-analysis-demo')!.hidden = location.protocol === 'file:';
  for (const [link, view] of [[newLogic, 'logic'], [newBridge, 'bridge']] as const) {
    const url = new URL(localSelection ? location.href : browserSite);
    url.searchParams.set('view', view);
    link.href = url.href;
  }
  address.oninput = () => { discovered = undefined; address.setCustomValidity(''); };
  form.onsubmit = async event => {
    event.preventDefault();
    const url = boardAddress(address.value);
    if (!url) {
      address.setCustomValidity(t('home.invalidAddress'));
      address.reportValidity();
      return;
    }
    if (!localAvailable || event.submitter === directConnect) { location.assign(url); return; }
    if (localConnect.disabled) return;
    localConnect.disabled = directConnect.disabled = true;
    try { await selectLocalBoard(new URL(url), discovered); }
    catch (error) { connection.textContent = error instanceof Error ? error.message : String(error); }
    finally { localConnect.disabled = directConnect.disabled = false; }
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
    bridgeConnect.hidden = paired || !!usbStatus || !navigator.usb;
    bridgeConnect.disabled = refresh.disabled;
    if (!paired && !navigator.usb) result.value = t('diagnostic.usb.unavailable');
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
    boardFirmware = undefined;
    setFirmwareTarget();
    renderVersions();
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
      if (lan) {
        setBridge(undefined, board);
        setNetworkTarget(undefined, board);
      }
      else {
        if (usbStatus?.boot !== board.boot) result.value = '';
        disconnected = false;
        usbStatus = board;
        selectEskUsbDevice(usbDevice);
        change.hidden = false;
        setBridge(usbDevice, board);
        setNetworkTarget(usbDevice, board);
      }
      refresh.dataset.i18n = 'capturePanel.tempRate';
      refresh.textContent = t('capturePanel.tempRate');
      connection.textContent = lan ? 'Ethernet' : 'USB';
      boardFirmware = board.firmware;
      setFirmwareTarget(board.hardwareId, board.firmware);
      renderVersions();
      identity.textContent = t('home.boardIdentity', {id: board.deviceId, boot: board.boot});
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
      setNetworkTarget();
      if (lan) setBridge();
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
    setFirmwareTarget();
    boardFirmware = undefined;
    renderVersions();
    usbDevice = undefined; usbStatus = undefined; selectEskUsbDevice();
    setNetworkTarget();
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
    document.title = atHome ? t('app.title') : atBridge ? 'xBridge' : 'xLogic';
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
        setNetworkTarget();
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
