/**
 * ADC DMA hardware matrix through the real analog page and the attached akaLinkPro probe.
 *
 *   node tools/selftest/adc-hw-stress.mjs
 *   node tools/selftest/adc-hw-stress.mjs --matrix-rounds=2 --continuous-ms=2000
 *
 * Requires the local app at 127.0.0.1:8899 and an authorized Chrome/Edge CDP browser at :9333.
 * The matrix validates conversion-width/rate switching, exact finite counts, ADS2 sequencing,
 * DMA-ring wrap, sustained USB delivery, and cleanup. Without a calibrated external signal it
 * does not claim ADC linearity, ENOB, or absolute voltage accuracy.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Cdp, sleep } from './cdp-lib.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const arg = (name, fallback) => {
  const item = process.argv.find(value => value.startsWith(`--${name}=`));
  return item ? item.slice(name.length + 3) : fallback;
};
const ints = value => String(value).split(',').map(Number);
const BITS = ints(arg('bits', '8,10,12,16'));
const RATES = ints(arg('rates', '1000,10000,100000,500000,1000000,2000000'));
const CONT_RATES = ints(arg('continuous-rates', '500000,1000000,2000000'));
const MATRIX_ROUNDS = Number(arg('matrix-rounds', '2'));
const FINITE_COUNT = Number(arg('finite-count', '2048'));
const WRAP_COUNT = Number(arg('wrap-count', '8192'));
const CONTINUOUS_MS = Number(arg('continuous-ms', '1500'));
const STATS_STRIDE = 64;
const APP = process.env.APP || 'http://127.0.0.1:8899/index.html';
const CDP = process.env.CDP || 'http://127.0.0.1:9333';
const OUT = arg('out', `tmp/adc-hw-stress-${new Date().toISOString().replaceAll(':', '-')}.json`);
if (!BITS.length || BITS.some(x => ![8,10,12,16].includes(x))) throw Error('--bits 仅支持 8,10,12,16');
if (!RATES.length || RATES.some(x => !Number.isInteger(x) || x < 1 || x > 2_000_000)) throw Error('--rates 超出 1..2000000');
if (!CONT_RATES.length || CONT_RATES.some(x => !Number.isInteger(x) || x < 1 || x > 2_000_000)) throw Error('--continuous-rates 超出 1..2000000');
if (!Number.isInteger(MATRIX_ROUNDS) || MATRIX_ROUNDS < 1 || MATRIX_ROUNDS > 10) throw Error('--matrix-rounds 超出 1..10');
if (!Number.isInteger(FINITE_COUNT) || FINITE_COUNT < 32 || FINITE_COUNT >= 4095) throw Error('--finite-count 必须为 32..4094');
if (!Number.isInteger(WRAP_COUNT) || WRAP_COUNT < 4096 || WRAP_COUNT > 0xffffffff) throw Error('--wrap-count 必须至少 4096');
if (!Number.isInteger(CONTINUOUS_MS) || CONTINUOUS_MS < 250 || CONTINUOUS_MS > 60000) throw Error('--continuous-ms 必须为 250..60000');

let pass = 0, fail = 0, caps = null, topError = null, reportWritten = false;
const rows = [];
const ok = (condition, label, extra = '') => {
  if (condition) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra ? ` · ${extra}` : ''}`); }
};
const cdp = new Cdp(CDP, 180000);

function writeReport(){
  const result={schema:1,createdAt:new Date().toISOString(),probe:'akaLinkPro/HPM5301 ADC DMA',caps,
    config:{bits:BITS,rates:RATES,matrixRounds:MATRIX_ROUNDS,finiteCount:FINITE_COUNT,wrapCount:WRAP_COUNT,
      continuousRates:CONT_RATES,continuousMs:CONTINUOUS_MS},summary:{pass,fail,rows:rows.length,error:topError},rows};
  const full=path.resolve(ROOT,OUT);
  fs.mkdirSync(path.dirname(full),{recursive:true});
  fs.writeFileSync(full,JSON.stringify(result,null,2)+'\n');
  reportWritten=true;
}

async function chooseProbePrompts(){
  while (cdp.prompts.length){
    const prompt = cdp.prompts.shift();
    const device = prompt.devices.find(item => /akaLinkPro|CMSIS-DAP|DAPLink/i.test(item.name || ''));
    if (!device) throw Error('设备选择框没有 akaLinkPro/CMSIS-DAP：' + JSON.stringify(prompt.devices));
    await cdp.sendBrowser('DeviceAccess.selectPrompt', { id: prompt.id, deviceId: device.id });
    console.log(`   已在浏览器设备选择框中选择 ${device.name}`);
  }
}

async function reuseSingleGrantedProbe(){
  // requestDevice always opens a chooser even for previously granted devices. For unattended
  // regression, reuse the sole already-authorized probe returned by getDevices(); if zero or
  // multiple probes are granted, retain the normal chooser and select by the visible device name.
  const state=await cdp.json(`(async()=>{
    const hid=navigator.hid, devices=(await hid.getDevices()).filter(d=>d.vendorId===0x0d28&&d.productId===0x0204);
    if(devices.length!==1)return {reused:false,count:devices.length};
    if(devices[0].opened)await devices[0].close();
    const original=Object.getOwnPropertyDescriptor(hid,'requestDevice');
    window.__adcHwOriginalRequestDevice=original||null;
    const native=Object.getPrototypeOf(hid).requestDevice.bind(hid);
    Object.defineProperty(hid,'requestDevice',{configurable:true,value:async options=>{
      const granted=(await hid.getDevices()).filter(d=>d.vendorId===0x0d28&&d.productId===0x0204);
      return granted.length===1?granted:native(options);
    }});
    return {reused:true,name:devices[0].productName};
  })()`);
  if(state.reused)console.log(`   复用当前来源已授权的单台探针：${state.name}`);
  else console.log(`   已授权探针数 ${state.count}；保留标准设备选择流程`);
}

async function waitTask(timeoutMs){
  const end = Date.now() + timeoutMs;
  while (Date.now() < end){
    await chooseProbePrompts();
    const state = await cdp.json('window.__adcHwTaskState || null').catch(() => null);
    if (state?.done) return state;
    await sleep(75);
  }
  throw Error(`ADC 采集任务超过 ${timeoutMs} ms`);
}

async function beginCapture({bits, rate, count}){
  const state = { bits, rate, count, done:false, ok:false, blocks:0, samples:0,
    min:null, max:null, sum:0, unique:0, rateSet:[], started:0 };
  const setup = `(()=>{
    const view=window.__tools.analog, session=view.session;
    const state=${JSON.stringify(state)};
    const orig=session.acquire;
    const unique=new Set();
    session.acquire=function(options,onBlock){
      return orig.call(this,options,packet=>{
        state.blocks++; state.samples+=packet.codes.length;
        if(!state.rateSet.includes(packet.rate))state.rateSet.push(packet.rate);
        for(let i=0;i<packet.codes.length;i+=${STATS_STRIDE}){
          const value=packet.codes[i];
          if(state.min===null||value<state.min)state.min=value;
          if(state.max===null||value>state.max)state.max=value;
          state.sum+=value; state.statsSamples++; if(unique.size<4096)unique.add(value);
        }
        state.unique=unique.size;
        onBlock?.(packet);
      });
    };
    window.__adcHwTaskState=state;
    document.getElementById('an-bits').value=String(${bits});
    document.getElementById('an-rate').value=String(${rate});
    document.getElementById('an-count').value=String(${count});
    state.started=performance.now();
    const task=view.acquire(${count}).then(()=>{state.ok=true;},e=>{state.error=e?.message||String(e);})
      .finally(()=>{state.done=true;state.elapsedMs=performance.now()-state.started;state.mean=state.statsSamples?state.sum/state.statsSamples:null;session.acquire=orig;});
    window.__adcHwTask=task;
    return true;
  })()`;
  await cdp.eval(setup, true);
  const result = await waitTask(Math.max(30000, count ? count / rate * 1000 + 20000 : CONTINUOUS_MS + 20000));
  return result;
}

async function captureFinite(bits, rate, count, label){
  console.log(`\n${label}: ${bits}-bit @ ${rate} Sa/s, ${count} samples`);
  const result = await beginCapture({bits,rate,count});
  const exactRate = result.rateSet.length === 1 && result.rateSet[0] <= rate && result.rateSet[0] >= rate * 0.99;
  const correctCount = result.samples === count;
  const validCodes = result.min !== null && result.max < 2 ** bits && result.min >= 0;
  const noFault = !result.error;
  ok(result.ok && noFault, `${label}: finite capture completes without ADC/USB fault`, result.error || '');
  ok(correctCount, `${label}: exact finite count ${result.samples}/${count}`);
  ok(exactRate, `${label}: actual rate ${result.rateSet.join('/')} Sa/s within 1% of request`);
  ok(result.blocks >= 2, `${label}: multiple sequenced USB data blocks (${result.blocks})`);
  ok(validCodes, `${label}: sampled ${result.bits}-bit codes stay in range [${result.min}, ${result.max}]`);
  rows.push({...result, kind:'finite', label, requestedRate:rate, actualRate:result.rateSet[0] ?? null,
    statsStride:STATS_STRIDE,throughputSps:result.elapsedMs ? result.samples * 1000 / result.elapsedMs : null});
}

async function captureContinuous(bits, rate){
  console.log(`\n持续 DMA: ${bits}-bit @ ${rate} Sa/s, ${CONTINUOUS_MS} ms`);
  const start = `(()=>{
    const view=window.__tools.analog,session=view.session;
    const state={bits:${bits},rate:${rate},count:0,done:false,ok:false,blocks:0,samples:0,min:null,max:null,sum:0,unique:0,rateSet:[],started:performance.now()};
    const orig=session.acquire,unique=new Set();
    session.acquire=function(options,onBlock){return orig.call(this,options,packet=>{
      state.blocks++;state.samples+=packet.codes.length;if(!state.rateSet.includes(packet.rate))state.rateSet.push(packet.rate);
      for(let i=0;i<packet.codes.length;i+=${STATS_STRIDE}){const value=packet.codes[i];if(state.min===null||value<state.min)state.min=value;if(value>state.max)state.max=value;state.sum+=value;state.statsSamples=(state.statsSamples||0)+1;if(unique.size<4096)unique.add(value);}
      state.unique=unique.size;onBlock?.(packet);
    });};
    window.__adcHwTaskState=state;
    document.getElementById('an-bits').value=String(${bits});
    document.getElementById('an-rate').value=String(${rate});
    document.getElementById('an-count').value='0';
    window.__adcHwTask=view.acquire(0).then(()=>{state.ok=true;},e=>{state.error=e?.message||String(e);})
      .finally(()=>{state.done=true;state.elapsedMs=performance.now()-state.started;state.mean=state.statsSamples?state.sum/state.statsSamples:null;session.acquire=orig;});
    return true;
  })()`;
  await cdp.eval(start, true);
  const until = Date.now() + CONTINUOUS_MS;
  while(Date.now() < until){
    await chooseProbePrompts();
    const current = await cdp.json('window.__adcHwTaskState || null').catch(()=>null);
    if(current?.done)break;
    await sleep(75);
  }
  let current = await cdp.json('window.__adcHwTaskState || null');
  if(!current.done){
    const stop = cdp.json('window.__tools.analog.session.stopAdc()').catch(e=>({stopError:e.message}));
    while(!current.done && Date.now() < until + 15000){
      await chooseProbePrompts(); await sleep(75);
      current = await cdp.json('window.__adcHwTaskState || null').catch(()=>current);
    }
    const stopped = await stop;
    if(stopped?.stopError)current.stopError=stopped.stopError;
  }
  current = await cdp.json('window.__adcHwTaskState || null');
  const actualRate = current.rateSet.length===1 && current.rateSet[0] <= rate && current.rateSet[0] >= rate*0.99;
  const controlledOverflow=current.done && /^ADC 已停止：DMA 缓冲满，未静默覆盖$/.test(current.error||'');
  const sustained=current.done && current.ok && !current.error && !current.stopError;
  const disposition=sustained?'sustained':controlledOverflow?'controlled-overflow':'failed';
  ok((sustained||controlledOverflow)&&!current.stopError,
    `持续 ${bits}-bit @ ${rate}: ${disposition}${controlledOverflow?'（DMA满后有明确保护停机）':'（无硬件故障）'}`, current.error||current.stopError||'');
  ok(actualRate, `持续 ${bits}-bit @ ${rate}: ADS2 时基 ${current.rateSet.join('/')} Sa/s`);
  const enoughSamples=controlledOverflow?current.samples>0&&current.blocks>0:
    current.blocks>=10&&current.samples>=rate*CONTINUOUS_MS/2000;
  ok(enoughSamples,
    `持续 ${bits}-bit @ ${rate}: ${current.blocks} 块 / ${current.samples} 点${controlledOverflow?'（溢出前收到的数据已排空）':''}`);
  ok(current.statsSamples>0 && current.max !== null && current.max < 2 ** bits,
    `持续 ${bits}-bit @ ${rate}: 抽样码值未超位宽 [${current.min}, ${current.max}]`);
  rows.push({...current,kind:'continuous',label:`continuous-${bits}-${rate}`,requestedRate:rate,actualRate:current.rateSet[0]??null,
    disposition,statsStride:STATS_STRIDE,throughputSps:current.elapsedMs?current.samples*1000/current.elapsedMs:null});
}

try{
  await cdp.connect();
  await cdp.send('Page.navigate',{url:`${APP}?adc-hw-stress=${Date.now()}#analog`});
  let loaded=false;
  for(let i=0;i<100;i++){
    loaded=await cdp.eval('return !!window.__tools?.analog?.session').catch(()=>false);
    if(loaded)break; await sleep(100);
  }
  if(!loaded)throw Error('ADC 页面没有加载：检查 8899 静态服务');

  await reuseSingleGrantedProbe();
  const connect=cdp.json('window.__tools.analog.session.connect()',true);
  let connectDone=false,connectValue,connectError;
  connect.then(v=>{connectDone=true;connectValue=v;},e=>{connectDone=true;connectError=e;});
  const connectEnd=Date.now()+30000;
  while(!connectDone&&Date.now()<connectEnd){
    await chooseProbePrompts(); await sleep(75);
  }
  if(!connectDone)throw Error('探针连接超过 30 秒；检查 WebHID 选择框和探针状态');
  if(connectError)throw connectError;
  if(!connectValue?.supported)throw Error('探针没有通告高速 ADC DMA 能力：'+JSON.stringify(connectValue));
  caps=await cdp.json('window.__tools.analog.session.caps');
  console.log(`ADC 已连接：通道 ${caps.channel} · ${caps.maxRate} Sa/s · ${caps.reference} V · DMA 4096 words`);

  const matrix=[];
  for(const bits of BITS)for(const rate of RATES)matrix.push({bits,rate});
  // Deterministic LCG shuffle exposes cross-width/rate cleanup bugs while keeping runs reproducible.
  let seed=0xadc2026;
  for(let round=0;round<MATRIX_ROUNDS;round++){
    const order=[...matrix];
    for(let i=order.length-1;i>0;i--){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const j=seed%(i+1);[order[i],order[j]]=[order[j],order[i]];}
    if(round&1)order.reverse();
    for(const c of order)await captureFinite(c.bits,c.rate,FINITE_COUNT,`有限矩阵 ${round+1}/${MATRIX_ROUNDS}`);
  }
  // Deliberately exceed the 4096-word DMA ring to verify release/rearm across wrap.
  await captureFinite(BITS.includes(16)?16:BITS.at(-1),RATES.includes(100000)?100000:RATES.at(-1),WRAP_COUNT,'DMA 环回');
  for(const bits of BITS)for(const rate of CONT_RATES)await captureContinuous(bits,rate);

  writeReport();
  console.log(`\nADC hardware matrix: ${pass} passed / ${fail} failed; report ${OUT}`);
  if(fail)process.exitCode=1;
}catch(error){
  topError=error?.message||String(error);
  console.error(`\nADC hardware matrix aborted: ${error?.stack||error}`);
  process.exitCode=1;
}finally{
  try{await cdp.json('window.__tools.analog.session.stopAdc()').catch(()=>{});}catch{}
  try{await cdp.json('window.__tools.analog.session.disconnect()').catch(()=>{});}catch{}
  try{await cdp.eval('if(window.__adcHwOriginalRequestDevice)Object.defineProperty(navigator.hid,"requestDevice",window.__adcHwOriginalRequestDevice);else delete navigator.hid.requestDevice;delete window.__adcHwOriginalRequestDevice;',false).catch(()=>{});}catch{}
  if(!reportWritten)try{writeReport();}catch(error){console.error(`ADC report could not be saved: ${error?.message||error}`);}
  cdp.close();
}
