import assert from 'node:assert/strict';
import { AdcTransport, decodeAdcPacket } from '../../app/analog/transport.js';
function packet(token,seq=null,fault=0){
  const b=new Uint8Array(seq===null?16:42),v=new DataView(b.buffer);
  b.set([65,68,67,49,1,seq===null?2:1,seq===null?0:1,26]);
  v.setUint32(8,token,true);v.setUint32(12,fault,true);
  if(seq!==null){v.setUint32(16,seq,true);v.setUint32(20,9,true);v.setUint32(24,1,true);b[39]=2;b[40]=0x34;b[41]=0x12;}
  return b;
}
assert.equal(decodeAdcPacket(packet(7,1),7).rows[0].data[0],0x34);
for(const bytes of [packet(8,1),packet(7,1).subarray(0,41),new Uint8Array(0)])
  assert.throws(()=>decodeAdcPacket(bytes,7),/数据包/);
const bad=packet(7,1);bad[39]=3;assert.throws(()=>decodeAdcPacket(bad,7),/长度/);
let queued=[],reads=0,active=0,maxActive=0;
const device={vendorId:1,productId:2,async transferIn(ep,n){
  assert.equal(ep,12);assert.equal(n,512);reads++;active++;maxActive=Math.max(maxActive,active);
  await Promise.resolve();active--;assert.ok(queued.length,'no extra read after END');
  return {status:'ok',data:new DataView(queued.shift().buffer)};
}};
const t=new AdcTransport(device);
queued=[packet(7,0xffffffff),packet(7,0),packet(7)];t.start(7);await t.drain();
assert.equal(t.done,true);assert.equal(maxActive,1);assert.equal(reads,3);
assert.deepEqual(t.rows.map(r=>r.seq),[0xffffffff,0]);
queued=[packet(8,1,5),packet(8)];t.start(8);await t.drain();
assert.equal(t.done,true);await assert.rejects(t.read(),/采集故障/);
queued=[packet(9,1),packet(9,3)];t.start(9);await t.pending;
await assert.rejects(t.read(),/序号/);
queued=[packet(10)];t.start(10);await t.drain();assert.equal(t.error,null);
console.log('ADC Bulk: strict packets/tokens, one native reader, END, restart, sequence wrap/gap, producer fault draining PASS');
