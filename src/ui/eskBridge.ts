// SPDX-License-Identifier: GPL-3.0-or-later
import { hexBytes, i2cCommand, parseHex, spiCommands } from '../device/eskBridgeFrames.js';
import { readUsbBoardId, readUsbBoardStatus, runUsbBridge } from '../device/eskUsbHome.js';
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
  const select = (name: string) => byId<HTMLSelectElement>('bus-' + name);
  const protocol = byId<HTMLSelectElement>('bridge-protocol'), form = byId<HTMLFormElement>('bridge-form');
  const run = byId<HTMLButtonElement>('bus-run'), preset = byId<HTMLButtonElement>('bridge-read');
  const port = byId<HTMLButtonElement>('bus-port'), result = byId<HTMLOutputElement>('bridge-result');
  const rx = byId<HTMLOutputElement>('bus-uart-rx');
  let device: USBDevice | undefined, board: BoardStatus | undefined, epoch = 0, busy = false;
  let uart: BridgeUart | undefined;
  let received = new Uint8Array();
  function available(name: string) {
    return !!board?.features.some(f => f.name === name && f.instance === 0 && f.enabled) && (name !== 'UART' || !!eskSerial);
  }
  function render() {
    for (const option of protocol.options)
      option.disabled = !available(option.value);
    if (!available(protocol.value))
      protocol.value = Array.from(protocol.options).find(o => !o.disabled)?.value ?? '';
    protocol.disabled = busy || !board || !!uart;
    const name = protocol.value;
    for (const field of form.querySelectorAll<HTMLFieldSetElement>('[data-bus]')) {
      field.hidden = field.dataset.bus !== name;
      field.disabled = field.hidden || busy || !board;
    }
    input('write').disabled = select('operation').value === 'read';
    input('count').disabled = select('operation').value === 'write';
    input('can-id').disabled = input('can-tx').disabled = select('can-action').value === 'listen';
    for (const id of ['baud', 'bits', 'parity', 'stop'])
      input(id).disabled = !!uart;
    port.textContent = uart ? 'Close UART port' : 'Open UART port';
    run.textContent = ({ I2C: 'Run transaction', SPI: 'Transfer', UART: 'Send bytes', CAN: select('can-action').selectedOptions[0].text })[name] ?? 'Run';
    run.disabled = busy || !available(name) || (name === 'UART' && !uart);
    preset.hidden = name !== 'I2C';
    preset.disabled = busy || !available('I2C');
  }
  const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
  async function operate(action: (d: USBDevice, b: BoardStatus, token: number) => Promise<string>) {
    if (busy || !device || !board)
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
    const opened = await BridgeUart.open({ baudRate: input('baud').valueAsNumber, dataBits: Number(select('bits').value),
      parity: select('parity').value as 'none' | 'odd' | 'even', stopBits: Number(select('stop').value) });
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
  preset.onclick = () => void operate(readUsbBoardId);
  form.onsubmit = e => {
    e.preventDefault();
    void operate(async (d, b) => {
      if (protocol.value === 'UART') {
        const bytes = parseHex(input('uart-tx').value);
        requireField(uart && bytes.length && bytes.length <= 1024, 'Enter 1–1,024 UART bytes.');
        await uart.send(bytes);
        return bytes.length + ' bytes submitted to serial port';
      }
      if (protocol.value === 'CAN') {
        const action = select('can-action').value as CanAction;
        const identity = await readUsbBoardStatus(d);
        requireField(identity.deviceId === b.deviceId && identity.boot === b.boot, 'Board changed. Refresh Home.');
        return canTransaction(d, action, Number(select('bitrate').value), action === 'listen' ? 0 : hexNumber(input('can-id').value), action === 'listen' ? new Uint8Array() : parseHex(input('can-tx').value));
      }
      if (protocol.value === 'SPI') {
        const commands = spiCommands(Number(select('mode').value), input('clock').valueAsNumber, parseHex(input('spi-tx').value));
        return hexBytes(await runUsbBridge(d, b, 'SPI', commands));
      }
      const op = select('operation').value;
      const tx = op === 'read' ? new Uint8Array() : parseHex(input('write').value);
      requireField(op === 'read' || tx.length, 'Enter I²C write bytes.');
      const command = i2cCommand(hexNumber(input('address').value), tx, op === 'write' ? 0 : input('count').valueAsNumber);
      const reply = await runUsbBridge(d, b, 'I2C', [command]);
      return reply.length ? hexBytes(reply) : tx.length + ' bytes written';
    });
  };
  protocol.onchange = () => { result.value = ''; render(); };
  select('operation').onchange = select('can-action').onchange = render;
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
    return Array.from(protocol.options).some(o => !o.disabled);
  };
}
