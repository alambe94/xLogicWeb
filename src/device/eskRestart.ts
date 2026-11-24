// SPDX-License-Identifier: GPL-3.0-or-later
/** xRST v1, on one DEVICE/0 grant bound to the observed boot. Never replay EXECUTE. */
export async function restartBoard(exchange: (payload: Uint8Array) => Promise<Uint8Array>): Promise<void> {
  const command = new Uint8Array(16);
  command.set([0x78, 0x52, 0x53, 0x54, 1, 0, 1, 0]);
  const prepare = await exchange(command);
  if (prepare.length !== 16 || !command.subarray(0, 8).every((value, i) => value === prepare[i]) ||
      !prepare.subarray(8).some(value => value !== 0)) throw new Error('Invalid restart receipt.');
  const execute = prepare.slice();
  execute[6] = 2;
  const confirmed = await exchange(execute);
  if (confirmed.length !== execute.length || !execute.every((value, i) => confirmed[i] === value)) {
    throw new Error('Restart acknowledgement is uncertain. Reconnect to check the board.');
  }
}
