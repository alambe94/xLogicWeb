// SPDX-License-Identifier: GPL-3.0-or-later
import { localBoard, localRequest } from './eskLocalBoard.js';
import { pairedUartChannel, type BoardStatus } from './eskPairedBoard.js';
import type { Settings } from './eskSerial.js';
import { requireField } from './eskUsbSession.js';

/** One serial owner and one operation in flight. Both transports expire an abandoned port. */
export async function openEthernetUart(board: BoardStatus, line: Settings) {
  const limits = board.uartLimits;
  requireField(limits && Number.isInteger(line.baudRate) && line.baudRate >= 9600 && line.baudRate <= 115200 &&
    [7,8].includes(line.dataBits) && [1,2].includes(line.stopBits) && ['none','odd','even'].includes(line.parity), 'Unsupported Ethernet UART settings.');
  const settings = {baud:line.baudRate,dataBits:line.dataBits,stopBits:line.stopBits,parity:['none','odd','even'].indexOf(line.parity)};
  let token: string | undefined, port: MessagePort | undefined;
  let id = 1, closed = false, failure: unknown, tail: Promise<unknown> = Promise.resolve();
  const reply = (post?: () => void) => new Promise<{id?:number; ready?:boolean; closed?:boolean; status?:number; data?:unknown}>((resolve,reject) => {
    const timer = setTimeout(() => reject(new Error('UART reply timed out. Delivery is uncertain.')), 8000);
    port!.onmessage = ({data}) => { clearTimeout(timer); if (!data || data.error) reject(new Error(data?.error ?? 'Invalid UART reply')); else resolve(data); };
    port!.onmessageerror = () => { clearTimeout(timer); reject(new Error('Unreadable UART response')); };
    try { post?.(); } catch (e) { clearTimeout(timer); reject(e); }
  });
  if (localBoard()) {
    token = await (await localRequest('lan_uart_open',{boot:board.boot,settings},AbortSignal.timeout(8000))).json();
    requireField(typeof token === 'string' && /^[a-f0-9]{32}$/.test(token), 'Invalid UART grant.');
  } else {
    port = pairedUartChannel(board,settings);
    try { requireField((await reply()).ready, 'Board did not grant UART access.'); }
    catch (e) { port.close(); throw e; }
  }
  const run = async (command: 2 | 3, data?: Uint8Array): Promise<{data: Uint8Array; status: number}> => {
    requireField(!closed, 'UART closed.');
    const operation = tail.then(async () => {
      if (failure) throw failure;
      const seq = ++id, fields = data ? {data} : {count:limits.read};
      const result = port ? await reply(() => port!.postMessage({id:seq,command,...fields})) :
        await (await localRequest(data ? 'lan_uart_write' : 'lan_uart_read',
          {boot:board.boot,token,id:seq,...(data ? {data:Array.from(data)} : fields)},AbortSignal.timeout(8000))).json();
      const payload = result?.data;
      requireField(result?.id === seq && Number.isInteger(result.status) && result.status >= 0 && result.status <= 0xffffffff &&
        (payload instanceof Uint8Array || (Array.isArray(payload) && payload.every(b => Number.isInteger(b) && b >= 0 && b <= 255))) &&
        payload.length <= (data ? 0 : limits.read), 'Invalid UART service response.');
      return {data: Uint8Array.from(payload), status: result.status};
    });
    tail = operation.catch(error => { failure = error; });
    return operation;
  };
  return {
    async send(bytes: Uint8Array) {
      for (let offset = 0; offset < bytes.length; offset += limits.write) {
        const result = await run(2,bytes.subarray(offset,offset+limits.write));
        if (result.status) throw new Error('UART write failed after ' + offset + ' confirmed bytes (status ' + result.status + ').');
      }
    },
    async receive(show: (bytes: Uint8Array) => void) {
      while (!closed) {
        const result = await run(3);
        if (result.data.length) show(result.data);
        if (result.status) throw new Error('UART receive error (status ' + result.status + ').');
        if (result.data.length < limits.read) await new Promise(resolve => setTimeout(resolve, 20));
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await tail;
      const seq = ++id;
      try {
        const done = port ? await reply(() => port!.postMessage({id:seq,close:true})) :
          await (await localRequest('lan_uart_close',{boot:board.boot,token,id:seq},AbortSignal.timeout(8000))).json();
        requireField(done?.closed === true, 'UART release was not confirmed.');
      } finally { port?.close(); }
    }
  };
}
