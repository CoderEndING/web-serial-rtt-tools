/** Real JS HID packet -> production analog C handler; no board needed. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { buildRequest } from '../../app/hid/probe.js';
import { DacClient, CMD, ACT, RC, DacError, configData, beginData, writeData, startData, stopData } from '../../app/analog/dac-protocol.js';
const root=resolve(fileURLToPath(new URL('../../',import.meta.url)));
const firmware=process.env.PROBE_FIRMWARE_REPO||resolve(root,'../5301evk_akaLinkPro');
const dir=mkdtempSync(join(tmpdir(),'analog-wire-')),exe=join(dir,process.platform==='win32'?'wire.exe':'wire');
execFileSync(process.env.PYTHON||'python3',[join(firmware,'script_test/analog_host_test.py'),'--wire',exe]);
const child=spawn(exe,[],{stdio:['pipe','pipe','inherit']}),pending=[];
createInterface({input:child.stdout}).on('line',line=>pending.shift()?.resolve(line));
const exit=new Promise(resolve=>child.on('exit',code=>{pending.splice(0).forEach(p=>p.reject(Error(`C wire server exit ${code}`)));resolve(code);}));
const xfer=(cmd,data)=>new Promise((resolve,reject)=>{
 pending.push({resolve:line=>resolve(Uint8Array.from(Buffer.from(line,'hex')).subarray(1)),reject});
 child.stdin.write(Buffer.from(Uint8Array.of(1,...buildRequest(cmd,data))).toString('hex')+'\n');
});
try{
 const client=new DacClient(xfer),c=await client.capabilities();assert.deepEqual(c,{version:1,channels:0,bits:0,features:0,maxRate:0,maxPoints:0,fullScale:0,supported:false});
 const requests=[[ACT.CONFIG,configData({channel:0,bits:12,rate:1000})],[ACT.BEGIN,beginData(0,32)],[ACT.WRITE,writeData(0,1,0,Array(25).fill(4095))],[ACT.START,startData(0,1)],[ACT.STOP,stopData(0,1)],[ACT.STATUS,Uint8Array.of(0)],[ACT.GET_CONFIG,Uint8Array.of(0)]];
 for(const [a,b]of requests)await assert.rejects(client.command(a,b),e=>e instanceof DacError&&e.code===RC.UNSUPPORTED);
 await assert.rejects(client.command(ACT.WRITE,Uint8Array.of(0)),e=>e.code===RC.RANGE);
 const adc=await xfer(CMD,Uint8Array.of(0));assert.equal(adc[0],20);assert.equal(String.fromCharCode(...adc.subarray(7,11)),'ANA1');
 console.log('Analog production C/JS ABI: DAC1 zero channels, every reserved action UNSUPPORTED, truncated write RANGE, unchanged ADC CAPS PASS');
}finally{child.stdin.end();assert.equal(await exit,0);rmSync(dir,{recursive:true,force:true});}
