// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { restartBoard } from './eskRestart.js';

let operations = [];
await restartBoard(async frame => {
  operations.push(frame[6]);
  const reply = frame.slice();
  if (frame[6] === 1) reply[8] = 42;
  else assert.equal(frame[8], 42);
  return reply;
});
assert.deepEqual(operations, [1, 2]);

operations = [];
await assert.rejects(restartBoard(async frame => {
  operations.push(frame[6]);
  return frame.slice();
}), /receipt/i);
assert.deepEqual(operations, [1]);

operations = [];
await assert.rejects(restartBoard(async frame => {
  operations.push(frame[6]);
  const reply = frame.slice();
  reply[8] = frame[6] === 1 ? 42 : 43;
  return reply;
}), /uncertain/i);
assert.deepEqual(operations, [1, 2]);
