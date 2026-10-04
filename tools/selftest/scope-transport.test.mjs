import assert from 'node:assert/strict';
import { VendorEpTransport } from '../../app/scope/transport.js';
const tick = () => new Promise(r => setImmediate(r));
const packet = value => ({ status: 'ok', data: new DataView(Uint8Array.of(value).buffer) });
class USB {
  pending = []; calls = 0; halts = 0;
  transferIn(){ this.calls++; return new Promise((resolve, reject) => this.pending.push({ resolve, reject })); }
  clearHalt(){ this.halts++; return Promise.resolve(); }
  resolve(value){ this.pending.shift().resolve(value); }
  reject(){ this.pending.shift().reject(new Error('disconnected')); }
  drain(){ for (const p of this.pending.splice(0)) p.resolve(packet(0)); }
}
{
  const usb = new USB(), t = new VendorEpTransport(usb, { inFlight: 3 });
  const seen = [];
  await t.start(bytes => {
    assert.equal(usb.pending.length, 3, 'rearm precedes decoding, bounded outstanding reads');
    seen.push(bytes[0]);
  });
  assert.equal(usb.pending.length, 3);
  usb.resolve(packet(1)); await tick();
  usb.resolve(packet(2)); await tick();
  assert.deepEqual(seen, [1, 2]);
  const stop = t.stop(); usb.drain(); await stop;
  assert.deepEqual(seen, [1, 2], 'stale reads are drained without callbacks');
  assert.equal(t.stalledInFlight, 0);
  assert.equal(usb.calls, 5);
  await t.start(b => seen.push(b[0])); usb.resolve(packet(3)); await tick();
  const secondStop = t.stop(); usb.drain(); await secondStop;
  assert.deepEqual(seen, [1, 2, 3]);
}
{
  const usb = new USB(), t = new VendorEpTransport(usb, { inFlight: 1 });
  const errors = [];
  await t.start(() => { throw new Error('decode'); }, e => errors.push(e.message));
  usb.resolve(packet(1)); await tick();
  assert.equal(t.running, false); assert.equal(errors.length, 1);
  assert.equal(usb.pending.length, 1, 'callback error still tracks rearmed request');
  const stop = t.stop(); usb.reject(); await stop;
  assert.equal(t.stalledInFlight, 0);
}
{
  const usb = new USB(), t = new VendorEpTransport(usb, { inFlight: 1 });
  const seen = [], errors = [];
  await t.start(b => seen.push(b[0]), e => errors.push(e.message));
  usb.resolve({ status: 'stall' });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(usb.halts, 1); assert.equal(usb.pending.length, 1);
  usb.resolve(packet(4)); await tick(); assert.deepEqual(seen, [4]);
  usb.reject(); await tick(); assert.equal(t.running, false); assert.equal(errors.length, 1);
  await t.stop();
}
console.log('scope-transport: rearm, ordering, bounded reads, stop/restart, decoder error, stall, disconnect PASS');
