import assert from 'node:assert/strict';
import {AdcTransport,decodeAdcPacket} from '../../app/analog/transport.js';
function packet(token,seq,first,codes=[],fault=0){
 const b=new Uint8Array(32+2*codes.length),v=new DataView(b.buffer);
 b.set([65,68,83,50,2,codes.length?1:2,16,0]);
 for(const [o,n]of [[8,token],[12,seq],[16,first],[20,2000000],[28,fault]])v.setUint32(o,n,true);
 v.setUint16(24,codes.length,true);b[26]=6;b[27]=2;codes.forEach((n,i)=>v.setUint16(32+2*i,n,true));return b;
}
assert.deepEqual([...decodeAdcPacket(packet(1,0,0,[1,65535]),1).codes],[1,65535]);
for(const b of [packet(2,0,0,[1]),packet(1,0,0,[1]).subarray(0,33),new Uint8Array()])assert.throws(()=>decodeAdcPacket(b,1),/数据包|长度/);
let queue=[],reads=0,active=0,maxActive=0;
const t=new AdcTransport({vendorId:1,productId:2,async transferIn(ep,len){
 assert.equal(ep,11);assert.equal(len,4096);active++;maxActive=Math.max(maxActive,active);await Promise.resolve();active--;
 reads++;assert.ok(queue.length,'no extra native read after END');return {status:'ok',data:new DataView(queue.shift().buffer)};
}});
const blocks=[];queue=[packet(1,0,0,[1,2]),packet(1,1,2,[3]),packet(1,2,3)];t.start(1,{bits:16,onBlock:b=>blocks.push(b)});await t.drain();
assert.equal(t.done,true);assert.equal(maxActive,1);assert.equal(reads,3);assert.equal(t.error,null);assert.equal(blocks.length,2);
queue=[packet(2,0,0,[1],5),packet(2,1,1,[],5)];t.start(2,{bits:16});await t.drain();assert.match(t.error.message,/缓冲满/);assert.equal(t.done,true);
queue=[packet(3,0,0,[1]),packet(3,2,1,[2]),packet(3,3,2)];t.start(3,{bits:16});await t.drain();assert.match(t.error.message,/不连续/);assert.equal(t.done,true);
queue=[packet(4,0,0)];t.start(4,{bits:16});await t.drain();assert.equal(t.error,null);
queue=[packet(5,0,0,[1]),packet(5,1,1)];t.start(5,{bits:16,onBlock(){throw Error('view failure');}});await t.drain();assert.match(t.error.message,/view failure/);
console.log('ADC shared Bulk: compact blocks, strict token/size/config, one native reader, fault/malformed block draining, END/restart PASS');
