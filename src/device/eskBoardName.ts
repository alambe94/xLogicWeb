// SPDX-License-Identifier: GPL-3.0-or-later
import { EskControlRejection, requireField } from './eskUsbSession.js';

const decoder = new TextDecoder();
const label = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
export function validBoardName(value: string): boolean {
  return value.length <= 33 && label.test(value);
}

export function boardAddress(value: string): string | undefined {
  const parts = /^(?:http:\/\/)?([a-z0-9.-]+)(?::([0-9]{1,5}))?\/?$/i.exec(value.trim());
  if (!parts) return;
  const host = parts[1].toLowerCase(), port = Number(parts[2] ?? 5555);
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(host) && host.split('.').every(n => String(Number(n)) === n && Number(n) <= 255);
  const local = host.endsWith('.local') && host.slice(0,-6).length <= 63 && label.test(host.slice(0,-6));
  if ((ipv4 || local) && port >= 1 && port <= 65535) return 'http://' + host + ':' + port + '/';
}

export interface NetworkManagement {
  stageBeforeSave?: boolean;
  service(request: Uint8Array): Promise<DataView>;
  status(): Promise<DataView>;
}
function request(action: number, revision = 0, policy?: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(16 + (policy?.length ?? 0));
  bytes.set([0x4e, 1, action, 0]);
  new DataView(bytes.buffer).setUint32(4, revision, true);
  if (policy) bytes.set(policy, 16);
  return bytes;
}
function header(r: DataView, size: number, action: number): void {
  requireField(r.byteLength === size && r.getUint16(0, true) === 0x014e && r.getUint8(2) === action,
    'Invalid network settings reply.');
}
export async function readBoardPolicy(port: NetworkManagement) {
  const query = request(3);
  query[3] = 1;
  const r = await port.service(query);
  header(r, 124, 3);
  const flags = r.getUint8(3), revision = r.getUint32(4, true), n = r.getUint8(34);
  const policy = new Uint8Array(r.buffer, r.byteOffset + 28, 96).slice();
  const name = decoder.decode(policy.subarray(28, 28 + n));
  requireField((flags & ~3) === 16 && revision > 0 && r.getUint16(28,true) === 1 && r.getUint16(30,true) === 96 &&
    [1,2].includes(policy[4]) && policy[5] <= 1 && n <= 63 && policy[7] === 0 &&
    ((!policy[5] && !n) || /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(name)) &&
    !policy.subarray(28 + n).some(b => b) && (policy[4] === 1 || !policy.subarray(8,28).some(b => b)), 'Invalid board name settings.');
  requireField(policy[5] === 1, 'mDNS is disabled on this board.');
  return {revision, name, policy, pending: !!(flags & 2), applied: !!(flags & 1) && r.getUint32(8,true) === revision && !r.getUint32(12,true)};
}
function operation(r: DataView, action: number, revision: number) {
  header(r, 28, action);
  requireField(r.getUint8(3) <= 3 && r.getUint32(4,true) === revision, 'Network settings changed. Refresh and try again.');
  return {pending: !!(r.getUint8(3) & 2), applied: !!(r.getUint8(3) & 1) && r.getUint32(8,true) === revision,
    status: r.getUint32(12,true), attempt: r.getBigUint64(16,true)};
}
function advertised(r: DataView, base: string, elapsedMs: number): string | undefined {
  requireField(r.byteLength === 64 && r.getUint8(0) === 1 && r.getUint8(1) <= 1 && r.getUint8(2) <= 3 &&
    r.getUint8(3) <= 7 && r.getUint8(4) <= 6 && r.getUint16(6,true) === 0, 'Invalid network status reply.');
  const n = r.getUint8(5), age = r.getUint32(8,true);
  if (r.getUint8(1) !== 1 || !r.getUint8(2) || r.getUint8(4) !== 5 || age > 1000 || age + 1 > elapsedMs) return;
  requireField(r.getUint32(12) !== 0, 'The active Ethernet interface has no IPv4 address.');
  const bytes = new Uint8Array(r.buffer, r.byteOffset + 24, 40);
  const name = decoder.decode(bytes.subarray(0, n));
  requireField(n > 0 && n <= 39 && label.test(name) && !bytes.subarray(n).some(b => b), 'Invalid advertised board name.');
  if (name === base) return name;
  if (name.startsWith(base + '-')) {
    const suffix = name.slice(base.length + 1);
    if (/^[1-9]\d{0,4}$/.test(suffix) && Number(suffix) >= 2 && Number(suffix) <= 65535) return name;
  }
}
const sleep = (ms: number) => new Promise<void>(ok => setTimeout(ok, ms));

export async function saveBoardName(port: NetworkManagement, name: string,
  now = () => performance.now(), wait = sleep): Promise<string> {
  requireField(validBoardName(name), 'Use 1–33 lowercase letters, digits or internal hyphens.');
  const current = await readBoardPolicy(port);
  requireField(!current.pending, 'Another network change is pending.');
  let revision = current.revision;
  const policy = current.policy;
  const stage = name !== current.name || port.stageBeforeSave === true;
  if (stage) {
    requireField(revision < 0xffffffff, 'Network settings revision exhausted.');
    policy[6] = name.length;
    policy.fill(0, 28, 92);
    policy.set(new TextEncoder().encode(name), 28);
    const staged = await port.service(request(1, revision, policy));
    operation(staged, 1, ++revision);
  }
  if (stage || !current.applied) {
    let result = operation(await port.service(request(2, revision)), 2, revision);
    const attempt = result.attempt;
    requireField(attempt > 0n, 'Missing apply receipt.');
    const started = now();
    while (result.pending && now() - started < 3000) {
      await wait(30);
      result = operation(await port.service(request(3)), 3, revision);
      requireField(result.attempt === attempt, 'Network apply attempt changed.');
    }
    requireField(!result.pending && result.applied && result.status === 0, 'Network apply was not confirmed. Check Ethernet clients and refresh.');
  }
  const confirmed = await readBoardPolicy(port);
  requireField(!confirmed.pending && confirmed.applied && confirmed.revision === revision &&
    confirmed.policy.every((v,i) => v === policy[i]), 'Network settings changed during apply.');
  const start = now();
  let observed: string | undefined;
  while (!observed && now() - start < 20000) {
    const elapsed = now() - start;
    try { observed = advertised(await port.status(), name, elapsed); }
    catch (error) {
      if (!(error instanceof EskControlRejection && [2,8].includes(error.status))) throw error;
    }
    if (!observed) await wait(100);
  }
  requireField(observed, 'Could not verify the advertised name. Check the Ethernet link before saving.');
  const saved = await port.service(request(5, revision));
  header(saved, 16, 5);
  requireField(saved.getUint8(3) === 0 && saved.getUint32(4,true) === revision && saved.getBigUint64(8,true) > 0n,
    'EEPROM save was not confirmed. Refresh before trying again.');
  return observed;
}
