// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { verifyFirmware } from './eskSignedFirmware.ts';

const keys = await crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, true, ['sign', 'verify']);
const spki = await crypto.subtle.exportKey('spki', keys.publicKey);
const image = new TextEncoder().encode('MSTRsynthetic').buffer;
const id = 'viewer-test', board = 0x534b3634, version = 0x2700;
const record = new Uint8Array(148), view = new DataView(record.buffer);
record.set(new TextEncoder().encode('XESKSIG1'));
view.setUint32(8, board, true);
view.setUint32(12, version, true);
view.setUint32(16, image.byteLength, true);
record.set(new Uint8Array(await crypto.subtle.digest('SHA-256', image)), 20);
record.set(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id))), 52);
record.set(new Uint8Array(await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, keys.privateKey, record.slice(0, 84))), 84);
assert.equal(await verifyFirmware(image, record.buffer, board, id, spki), version);
await assert.rejects(verifyFirmware(image, record.buffer, board + 1, id, spki));
await assert.rejects(verifyFirmware(image, record.buffer, board, 'other', spki));
for (const n of [12, 16, 20, 52, 147]) {
  const bad = record.slice();
  bad[n] ^= 1;
  await assert.rejects(verifyFirmware(image, bad.buffer, board, id, spki));
}
new Uint8Array(image)[4] ^= 1;
await assert.rejects(verifyFirmware(image, record.buffer, board, id, spki));
console.log('PASS signed firmware file, target, version, key and payload checks');
