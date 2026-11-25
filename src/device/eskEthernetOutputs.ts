// SPDX-License-Identifier: GPL-3.0-or-later
import { localBoard, localRequest } from './eskLocalBoard.js';
import { pairedOutputChannel, type BoardStatus } from './eskPairedBoard.js';
import type { OutputBus, OutputHandle } from './eskOutputs.js';
import { requireField } from './eskUsbSession.js';

export function ethernetOutputRoute(board: BoardStatus, bus: OutputBus, instance: number) {
  return board.outputRoutes?.find(r => r.serviceId === (bus === 'GPIO' ? 7 : 12) && r.instanceId === instance);
}

interface Reply { id?: number; ready?: boolean; alive?: boolean; renewed?: boolean; closed?: boolean; status?: number; data?: unknown }

function portReply(port: MessagePort, message?: object): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      port.onmessage = null;
      port.onmessageerror = null;
    };
    const timer = setTimeout(() => { finish(); reject(new Error('Board reply timed out. Delivery is uncertain.')); }, 8000);
    port.onmessageerror = () => { finish(); reject(new Error('Unreadable board reply.')); };
    port.onmessage = ({data}) => {
      finish();
      if (!data || data.error) reject(new Error(data?.error ?? 'Invalid output reply.'));
      else resolve(data);
    };
    try {
      if (message) port.postMessage(message);
    } catch (error) { finish(); reject(error); }
  });
}

/** Hold one pad service grant. Commands, heartbeat and release share one ordered stream. */
export async function openEthernetOutputs(board: BoardStatus, bus: OutputBus, instance: number): Promise<OutputHandle> {
  const route = ethernetOutputRoute(board, bus, instance);
  requireField(route, 'The board does not advertise this Ethernet output.');
  const local = !!localBoard();
  const port = local ? undefined : pairedOutputChannel(board, route);
  let token: string | undefined;
  if (port) {
    try { requireField((await portReply(port)).ready === true, 'Output grant was not confirmed.'); }
    catch (error) { port.close(); throw error; }
  } else {
    const open = await localRequest('lan_outputs_open', {deviceId: board.deviceId, boot: board.boot, ...route}, AbortSignal.timeout(8000));
    token = await open.json();
    requireField(typeof token === 'string' && /^[a-f0-9]{32}$/.test(token), 'Invalid output grant.');
  }

  let id = 0, closing = false, ended = false, renewing = false;
  let tail = Promise.resolve();
  let resolveDone!: () => void, rejectDone!: (reason: unknown) => void;
  const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  async function exchange(action: 'run' | 'renew' | 'close', remote: object, fields: object): Promise<Reply> {
    const expected = ++id;
    const reply = port ? await portReply(port, {id: expected, ...remote}) :
      await (await localRequest('lan_outputs_' + action, {token, boot: board.boot, id: expected, ...fields}, AbortSignal.timeout(8000))).json();
    requireField(reply?.id === expected, 'Output reply sequence mismatch. Delivery is uncertain.');
    return reply;
  }
  function finish(error?: unknown) {
    if (ended) return;
    ended = true;
    clearInterval(timer);
    port?.close();
    if (error === undefined) resolveDone(); else rejectDone(error);
  }
  function schedule<T>(work: () => Promise<T>): Promise<T> {
    if (closing || ended) return Promise.reject(new Error('Output lease ended.'));
    const operation = tail.then(() => {
      requireField(!ended, 'Output lease ended.');
      return work();
    });
    tail = operation.then(() => {}, finish);
    return operation;
  }
  async function release() {
    requireField((await exchange('close', {close: true}, {})).closed === true, 'Output release was not confirmed.');
  }
  const timer = setInterval(() => {
    if (closing || ended || renewing) return;
    renewing = true;
    void schedule(async () => {
      const reply = await exchange('renew', {alive: true}, {});
      requireField(port ? reply.alive === true : reply.renewed === true, 'Output lease renewal was not confirmed.');
    }).finally(() => { renewing = false; }).catch(() => {});
  }, 1000);

  return {
    done,
    send(command) {
      return schedule(async () => {
        const response = await exchange('run', {op: command.op, payload: command.payload},
          {command: command.op, payload: Array.from(command.payload)});
        const {status, data} = response;
        requireField(typeof status === 'number' && Number.isInteger(status) && status >= 0 && status <= 0xffffffff,
          'Invalid output status. Delivery is uncertain.');
        if (status !== 0) {
          // A correlated rejection is final. Retire the grant without replaying its command.
          const detail = status === 0x204006 || status === 0x4005 ? 'Output is busy.' :
            bus + ' request rejected (0x' + status.toString(16) + ').';
          try { await release(); } catch { throw new Error(detail + ' Release was not confirmed.'); }
          throw new Error(detail);
        }
        requireField((data instanceof Uint8Array || (Array.isArray(data) && data.every(n => Number.isInteger(n) && n >= 0 && n <= 255))) &&
          data.length === command.reply, 'Invalid output reply length or data. Delivery is uncertain.');
        return Uint8Array.from(data);
      });
    },
    close() {
      if (!closing && !ended) {
        closing = true;
        clearInterval(timer);
        void tail.then(async () => { if (!ended) { await release(); finish(); } }).catch(finish);
      }
      return done;
    }
  };
}
