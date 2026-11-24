// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { boardAddress, saveBoardName, validBoardName } from './eskBoardName.js';

assert.equal(boardAddress('HTTP://Lab-Bench.local:5555/'), 'http://lab-bench.local:5555/');
assert.equal(boardAddress('lab-bench.local'), 'http://lab-bench.local:5555/');
assert.equal(boardAddress('192.0.2.8:8080'), 'http://192.0.2.8:8080/');
for (const s of ['https://a.local', 'a.local@elsewhere', 'a.local:0', 'a.local:65536', 'a.b.local',
  'example.com', 'a.local/path', 'a.local?port=5555', '010.0.0.1', '1.2.3.999', 'a.local#x']) {
  assert.equal(boardAddress(s), undefined);
}
assert.ok(validBoardName('a'.repeat(33)));
for (const invalid of ['a'.repeat(34), 'Foo', 'a.local', '-a', 'a-', 'a_b', 'a\n']) assert.ok(!validBoardName(invalid));

function model({active = 'lab-bench-2', ready = true, configured = 'factory', failure = '', stageBeforeSave = false} = {}) {
  const encoder = new TextEncoder();
  let policy = new Uint8Array(96), revision = 11, attempt = 0, applied = ready, now = 0;
  const events = [];
  policy.set([1, 0, 96, 0, 1, 1, configured.length, 0, 192, 0, 2, 4, 255, 255, 255, 0, 192, 0, 2, 1, 1, 1, 1, 1, 8, 8, 8, 8]);
  policy.set(encoder.encode(configured), 28);
  const previous = policy.slice();
  const port = {
    stageBeforeSave,
    async service(packet) {
      const q = new DataView(packet.buffer), action = packet[2];
      events.push(action === 3 && packet[3] ? 'desired' : action);
      assert.equal(q.getUint16(0,true), 0x014e);
      if (action === 1) {
        assert.equal(q.getUint32(4,true), revision++);
        policy = packet.slice(16);
        assert.deepEqual(policy.slice(0,6), previous.slice(0,6));
        assert.deepEqual(policy.slice(7,28), previous.slice(7,28));
        assert.equal(new TextDecoder().decode(policy.slice(28,28+policy[6])), 'lab-bench');
        assert.ok(policy.slice(28+policy[6]).every(b=>b===0));
        applied = false;
      }
      const desired = action === 3 && packet[3] === 1;
      const r = new DataView(new ArrayBuffer(desired ? 124 : action === 5 ? 16 : 28));
      r.setUint16(0,0x014e,true); r.setUint8(2,action); r.setUint32(4,revision,true);
      if (action === 5) {
        assert.equal(q.getUint32(4,true), revision);
        r.setBigUint64(8, failure === 'receipt' ? 0n : 9n, true);
        return r;
      }
      if (action === 2) { assert.equal(q.getUint32(4,true), revision); attempt++; }
      if (action === 3 && !desired) applied = true;
      r.setUint8(3,(desired ? 16 : 0) | (applied ? 1 : 0) | (action === 2 ? 2 : 0));
      r.setBigUint64(16, BigInt(attempt),true);
      r.setUint32(8,applied ? revision : revision - 1,true);
      if (desired) new Uint8Array(r.buffer).set(policy,28);
      if (failure === 'revision' && desired && attempt) r.setUint32(4,revision+1,true);
      return r;
    },
    async status() {
      events.push('status');
      const r = new DataView(new ArrayBuffer(64));
      new Uint8Array(r.buffer).set([1,1,3,0,5,active.length]);
      r.setUint32(8,450,true); // Ignore observations from before apply.
      if (failure !== 'noAddress') new Uint8Array(r.buffer).set([192,0,2,4],12);
      new Uint8Array(r.buffer).set(encoder.encode(active),24);
      return r;
    }
  };
  return {events, run: () => saveBoardName(port,'lab-bench',()=>now, async ms => { now += ms; })};
}
const renamed = model();
assert.equal(await renamed.run(), 'lab-bench-2');
assert.deepEqual(renamed.events.filter(v=>v!=='status'), ['desired',1,2,3,'desired',5]);
assert.ok(renamed.events.filter(v=>v==='status').length >= 4);
const same = model({configured:'lab-bench', active:'lab-bench'});
const sameLan = model({configured:'lab-bench', stageBeforeSave: true});
await sameLan.run();
assert.deepEqual(sameLan.events.filter(v=>v!=='status'), ['desired',1,2,3,'desired',5]);
await same.run(); assert.deepEqual(same.events.filter(v=>v!=='status'), ['desired','desired',5]);
const staged = model({configured:'lab-bench', ready:false});
await staged.run(); assert.deepEqual(staged.events.filter(v=>v!=='status'), ['desired',2,3,'desired',5]);
for (const config of [{active:'different-board'}, {active:'lab-bench-65536'}, {failure:'revision'}, {failure:'noAddress'}]) {
  const fail = model(config);
  await assert.rejects(fail.run());
  assert.ok(!fail.events.includes(5));
}
const uncertain = model({failure:'receipt'});
await assert.rejects(uncertain.run(), /save was not confirmed/);
assert.equal(uncertain.events.filter(v=>v===5).length, 1);
console.log('ESK board-wide name and URL checks passed');
