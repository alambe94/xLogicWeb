// SPDX-License-Identifier: GPL-3.0-or-later
import { selectControl, type SelectOptionTuple } from './select.js';
import { hexBytes, i2cCommand, parseHex, spiCommands, spiReceiveBytes } from '../device/eskBridgeFrames.js';
import { readUsbBoardStatus, runUsbBridge } from '../device/eskUsbHome.js';
import type { BoardStatus } from '../device/eskPairedBoard.js';
import { BridgeUart, eskSerial } from '../device/eskSerial.js';
import { canTransaction, type CanAction } from '../device/eskCan.js';
import { requireField } from '../device/eskUsbSession.js';
function hexNumber(text: string): number {
  requireField(/^(?:0x)?[\da-f]+$/i.test(text.trim()), 'Enter a hexadecimal address or identifier.');
  return parseInt(text.trim(), 16);
}
export function initBridgeTools() {
  const root = document.querySelector<HTMLElement>('#bridge-controls')!;
  const byId = <T extends HTMLElement>(id: string) => root.querySelector<T>('#' + id)!;
  const input = (name: string) => byId<HTMLInputElement>('bus-' + name);
  function picker(id: string, label: string, options: readonly SelectOptionTuple[], initial = options[0]![0]) {
    const control = selectControl(id, label, options, initial);
    byId(id).replaceChildren(control.el);
    return control;
  }
  const choices = (...values: string[]): SelectOptionTuple[] => values.map(v => [v, v]);
  const protocol = picker('bridge-protocol', 'Protocol', [['I2C', 'I²C'], ...choices('UART', 'SPI', 'CAN')]);
  const operation = picker('bus-operation', 'Operation', [['read', 'Read'], ['write', 'Write'], ['combined', 'Write then read']]);
  const bits = picker('bus-bits', 'Data bits', choices('8', '7'));
  const parity = picker('bus-parity', 'Parity', choices('none', 'odd', 'even'));
  const stop = picker('bus-stop', 'Stop bits', choices('1', '2'));
  const spiAction = picker('bus-spi-action', 'Operation', [['exchange', 'Transmit and receive'], ['receive', 'Receive']]);
  const mode = picker('bus-mode', 'Mode', choices('0', '1', '2', '3'));
  const canAction = picker('bus-can-action', 'Operation', [['loopback', 'Internal loopback'], ['listen', 'Listen for one frame'], ['send', 'Send frame']]);
  const bitrate = picker('bus-bitrate', 'Bitrate (bit/s)', choices('125000', '250000', '500000', '1000000'), '500000');
  const form = byId<HTMLFormElement>('bridge-form'), run = byId<HTMLButtonElement>('bus-run');
  const port = byId<HTMLButtonElement>('bus-port'), result = byId<HTMLOutputElement>('bridge-result');
  const rx = byId<HTMLOutputElement>('bus-uart-rx');
  let device: USBDevice | undefined, board: BoardStatus | undefined, epoch = 0, busy = false;
  let uart: BridgeUart | undefined;
  let received = new Uint8Array();
  function available(name: string) {
    return !!board?.features.some(f => f.name === name && f.instance === 0 && f.enabled) && (name !== 'UART' || !!eskSerial);
  }
  function render() {
    protocol.disabled = busy || !!uart;
    const name = protocol.value;
    for (const field of form.querySelectorAll<HTMLFieldSetElement>('[data-bus]')) {
      field.hidden = field.dataset.bus !== name;
      field.disabled = field.hidden || busy;
    }
    const receive = spiAction.value === 'receive';
    for (const id of ['spi-tx', 'spi-count', 'spi-fill']) {
      const field = input(id);
      field.disabled = id === 'spi-tx' ? receive : !receive;
      field.closest('label')!.hidden = field.disabled;
    }
    input('write').disabled = operation.value === 'read';
    input('count').disabled = operation.value === 'write';
    input('can-id').disabled = input('can-tx').disabled = canAction.value === 'listen';
    input('baud').disabled = bits.disabled = parity.disabled = stop.disabled = !!uart;
    port.disabled = busy || !available('UART');
    port.textContent = uart ? 'Close UART port' : 'Open UART port';
    run.textContent = ({ I2C: 'Run transaction', SPI: receive ? 'Receive' : 'Transfer', UART: 'Send bytes', CAN: ({listen: 'Listen for one frame', loopback: 'Internal loopback', send: 'Send frame'}[canAction.value] ?? 'Run') })[name] ?? 'Run';
    run.disabled = busy || !available(name) || (name === 'UART' && !uart);
  }
  const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
  async function operate(action: (d: USBDevice, b: BoardStatus, token: number) => Promise<string>) {
    if (busy || !device || !board || !available(protocol.value))
      return;
    const token = epoch;
    busy = true;
    render();
    result.value = 'Working…';
    try {
      const message = await action(device, board, token);
      if (epoch === token)
        result.value = message;
    }
    catch (e) {
      if (epoch === token)
        result.value = errorText(e);
    }
    finally {
      busy = false;
      render();
    }
  }
  async function closeUart() {
    const current = uart;
    uart = undefined;
    if (current)
      await current.close();
  }
  port.onclick = () => void operate(async (_device, _board, token) => {
    if (uart) {
      await closeUart();
      return 'UART closed';
    }
    const opened = await BridgeUart.open({ baudRate: input('baud').valueAsNumber, dataBits: Number(bits.value),
      parity: parity.value as 'none' | 'odd' | 'even', stopBits: Number(stop.value) });
    if (epoch !== token) {
      await opened.close();
      return '';
    }
    uart = opened;
    received = new Uint8Array();
    rx.value = '';
    void opened.receive(bytes => {
      if (uart !== opened)
        return;
      const tail = bytes.subarray(-256), keep = received.subarray(Math.max(0, received.length + tail.length - 256));
      received = new Uint8Array(keep.length + tail.length);
      received.set(keep);
      received.set(tail, keep.length);
      rx.value = hexBytes(received);
    }).catch(e => { if (uart === opened)
      result.value = errorText(e); }).finally(async () => {
      if (uart === opened) {
        try {
          await closeUart();
        }
        catch (e) {
          result.value = errorText(e);
        }
        render();
      }
    });
    return 'UART open';
  });
  form.onsubmit = e => {
    e.preventDefault();
    if (run.disabled) return;
    void operate(async (d, b) => {
      if (protocol.value === 'UART') {
        const bytes = parseHex(input('uart-tx').value);
        requireField(uart && bytes.length && bytes.length <= 1024, 'Enter 1–1,024 UART bytes.');
        await uart.send(bytes);
        return bytes.length + ' bytes submitted to serial port';
      }
      if (protocol.value === 'CAN') {
        const action = canAction.value as CanAction;
        const identity = await readUsbBoardStatus(d);
        requireField(identity.deviceId === b.deviceId && identity.boot === b.boot, 'Board changed. Refresh Home.');
        return canTransaction(d, action, Number(bitrate.value), action === 'listen' ? 0 : hexNumber(input('can-id').value), action === 'listen' ? new Uint8Array() : parseHex(input('can-tx').value));
      }
      if (protocol.value === 'SPI') {
        const tx = spiAction.value === 'receive'
          ? spiReceiveBytes(input('spi-count').valueAsNumber, input('spi-fill').value)
          : parseHex(input('spi-tx').value);
        const commands = spiCommands(Number(mode.value), input('clock').valueAsNumber, tx);
        return 'RX (MISO) · ' + hexBytes(await runUsbBridge(d, b, 'SPI', commands));
      }
      const op = operation.value;
      const tx = op === 'read' ? new Uint8Array() : parseHex(input('write').value);
      requireField(op === 'read' || tx.length, 'Enter I²C write bytes.');
      const command = i2cCommand(hexNumber(input('address').value), tx, op === 'write' ? 0 : input('count').valueAsNumber);
      const reply = await runUsbBridge(d, b, 'I2C', [command]);
      return reply.length ? hexBytes(reply) : tx.length + ' bytes written';
    });
  };
  protocol.addEventListener('change', () => { result.value = ''; render(); });
  spiAction.addEventListener('change', () => { result.value = ''; render(); });
  operation.addEventListener('change', render);
  canAction.addEventListener('change', render);
  window.addEventListener('pagehide', () => { void closeUart().catch(() => { }); });
  render();
  return (next?: USBDevice, status?: BoardStatus) => {
    if (next !== device || status?.boot !== board?.boot) {
      epoch++;
      result.value = rx.value = '';
      void closeUart().catch(() => { });
    }
    device = next;
    board = status;
    render();
  };
}
