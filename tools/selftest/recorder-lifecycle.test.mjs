import assert from 'node:assert/strict';
import { FileRecorder } from '../../app/core/recorder.js';

const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));
let picker, picks = 0;
globalThis.window = { showSaveFilePicker: () => { picks++; return picker(); } };
const rec = new FileRecorder(), opening = gate(), writing = gate(), closing = gate();
let writes = [], closes = 0;
picker = () => opening.promise;
const first = rec.start(), duplicate = rec.start();
assert.equal(picks, 1); assert.equal(rec.starting, true);
opening.resolve({ name: 'old.bin', createWritable: async () => ({
  async write(bytes){ writes.push([...bytes]); await writing.promise; },
  async close(){ closes++; await closing.promise; },
}) });
assert.deepEqual(await Promise.all([first, duplicate]), ['old.bin', 'old.bin']);
rec.push(Uint8Array.of(1, 2, 3));
const stopA = rec.stop(), stopB = rec.stop();
await tick();
await assert.rejects(rec.start(), /正在落盘/); assert.equal(picks, 1);
assert.equal(rec.draining, true); writing.resolve(); await tick();
assert.equal(rec.draining, true); assert.equal(closes, 1);
closing.resolve(); const [a, b] = await Promise.all([stopA, stopB]);
assert.equal(a, b); assert.equal(rec.draining, false); assert.equal(rec._w, null);
assert.deepEqual(writes, [[1, 2, 3]]);
picker = async () => ({ name: 'new.bin', createWritable: async () => ({
  async write(bytes){ writes.push([...bytes]); }, async close(){ closes++; },
}) });
await rec.start(); rec.push(Uint8Array.of(4)); await rec.stop();
assert.deepEqual(writes, [[1, 2, 3], [4]]); assert.equal(closes, 2);

const pending = new FileRecorder(), pickGate = gate(); picker = () => pickGate.promise;
const startPending = pending.start(), stopPending = pending.stop();
pickGate.resolve({ name: 'pending.bin', createWritable: async () => ({ async close(){ closes++; } }) });
await Promise.all([startPending, stopPending]); assert.equal(pending.active, false); assert.equal(pending._w, null);
picker = async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); };
await assert.rejects(pending.start(), /cancelled/); assert.equal(pending.starting, false);
console.log('recorder-lifecycle: single picker/stop, close barrier, clean restart and stop during opening PASS');
