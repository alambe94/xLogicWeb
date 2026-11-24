// SPDX-License-Identifier: GPL-3.0-or-later

/** Authenticate the local image and return the signed version for this hardware. */
export async function verifyFirmware(image: ArrayBuffer, sidecar: ArrayBuffer, hardwareId: number,
    keyId: string, publicSpki: ArrayBuffer): Promise<number> {
  const record = new Uint8Array(sidecar), bytes = new Uint8Array(image);
  if (record.length !== 148 || !keyId || !Number.isInteger(hardwareId) ||
      new TextDecoder().decode(record.subarray(0, 8)) !== 'XESKSIG1' ||
      new TextDecoder().decode(bytes.subarray(0, 4)) !== 'MSTR') throw new Error('Invalid firmware record');
  const view = new DataView(sidecar);
  if (view.getUint32(8, true) !== hardwareId || view.getUint32(16, true) !== bytes.length) {
    throw new Error('Incompatible firmware');
  }
  const key = await crypto.subtle.importKey('spki', publicSpki, {name: 'ECDSA', namedCurve: 'P-256'}, false, ['verify']);
  if (!await crypto.subtle.verify({name: 'ECDSA', hash: 'SHA-256'}, key, record.subarray(84), record.subarray(0, 84))) {
    throw new Error('Invalid signature');
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', image));
  const id = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(keyId)));
  if (!digest.every((byte, i) => byte === record[20 + i]) || !id.every((byte, i) => byte === record[52 + i])) {
    throw new Error('Firmware or key ID mismatch');
  }
  return view.getUint32(12, true);
}
