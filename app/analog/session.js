import { AkaLinkHid } from '../hid/probe.js';
import { runProbeOperation } from '../core/probe-manager.js';
import { waitMs } from '../core/pace.js';
import { withTimeout } from '../rtt/dap-webusb.js';
import { DacClient } from './dac-protocol.js';
import { dacTable } from './model.js';
import { AdcTransport } from './transport.js';
export class AnalogSession {
  constructor(){ this.hid = null; this.caps = null; this.dac = null; this.busy = false; this.usingMock = false; }
  get connected(){ return !!this.hid?.connected; }
  setBusy(value){ this.busy = value; }
  async connect(){
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = runProbeOperation(this, 'analog', async () => {
      if (this.connected) return this.caps;
      const hid = new AkaLinkHid();
      try {
        await hid.request();
        const r = await hid.xfer(0x38, Uint8Array.of(9));
        const caps = streamCaps(decodeReply(r,9));
        const dac = new DacClient((cmd,data)=>hid.xfer(cmd,data));
        await dac.capabilities();
        this.caps = caps; this.hid = hid; this.dac = dac;
        hid.onDisconnect = () => { this._adcAbort?.abort(); this._dacStart?.controller.abort();  this.onDisconnect?.(); };
        return caps;
      } catch (e){ await hid.close(); throw e; }
    }, { reason: 'ADC 页面要使用探针', recovery: true });
    try { return await this._connectPromise; } finally { this._connectPromise = null; }
  }
  async acquire(options, onResult){
    if (this._adcRun) throw Error('ADC 已有采集在进行');
    const controller = new AbortController(); this._adcAbort = controller;
    const run = this._acquire(options, onResult, controller.signal);
    this._adcRun = run;
    try { return await run; }
    finally { this._adcRun = null; this._adcAbort = null; }
  }
  async _acquire({bits,rate,count=0},onBlock,signal){
    if(!this.connected||!this.caps)throw Error('先连接探针');
    if(this.busy)throw Error('ADC 已有采集在进行');
    if(![8,10,12,16].includes(bits)||!Number.isInteger(rate)||rate<1||rate>this.caps.maxRate ||
       !Number.isInteger(count)||count<0||count>0xffffffff)throw Error('ADC 位宽、采样率或长度无效');
    this.setBusy(true);
    this._requestedBits=bits;
    const abort=()=>{this._sendStop().catch(e=>{this._adcStopError=e;});};
    try{
      if(!this.transport)this.transport=await AdcTransport.request(this.hid.device);
      const caps=streamCaps(await this.streamCommand(9));
      if(caps.flags&2)throw Error('SPI/QSPI 尚未退场，不能接管共享缓冲');
      if(caps.flags&1)await this.transport.retireSpiOut();
      if(signal.aborted)return;
      const args=new Uint8Array(9),v=new DataView(args.buffer);args[0]=bits;
      v.setUint32(1,rate,true);v.setUint32(5,count,true);
      this._openUncertain=true;
      let b;
      try{b=await this.streamCommand(10,args);}
      catch(e){if(e.code!=null)this._openUncertain=false;throw e;}
      if(b.length!==4)throw Error('ADC OPEN 应答长度错误');
      this._streamToken=new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(0,true);
      this._openUncertain=false;
      this._adcStopError=null;
      this.transport.start(this._streamToken,{bits,onBlock,onFault:abort});
      signal.addEventListener('abort',abort,{once:true});
      if(signal.aborted)abort();else await this.streamCommand(13);
      await this.transport.pending;
      if(this.transport.error)throw this.transport.error;
      if(this._adcStopError)throw this._adcStopError;
    }finally{
      signal.removeEventListener('abort',abort);
      try{await this._cleanupAdc();this.setBusy(false);}
      catch(e){this._adcCleanupError=e;this.probeManager?.fail('analog',e);throw e;}
    }
  }
  async streamCommand(action,args=new Uint8Array()){
    return decodeReply(await this.hid.xfer(0x38,Uint8Array.of(action,...args)),action);
  }
  async _sendStop(){
    if(this._streamToken==null)return;
    // Coalesce a live STOP, but permit retries after an error/timeout.
    if(this._stopCommand)return this._stopCommand;
    this._stopCommand=this.streamCommand(11);
    try{await this._stopCommand;}finally{this._stopCommand=null;}
  }
  async _cleanupAdc(){
    if(this._openUncertain){
      const b=await this.streamCommand(14);
      if(b.length!==24)throw Error('ADC 状态应答长度错误');
      if(b[20]){
        this._streamToken=new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(0,true);
        this.transport.start(this._streamToken,{bits:this._requestedBits});
      }
      this._openUncertain=false;
    }
    if(this._streamToken==null)return;
    if(this.transport?.lease?.entry?.disconnected){
      if(this.transport.pending)await withTimeout(this.transport.pending,3000,'等待拔出 USB 请求退场');
      this._streamToken=null;return;
    }
    await this._sendStop();await this.transport.drain();
    const deadline=performance.now()+3000;
    for(;;){
      try{await this.streamCommand(12);break;}
      catch(e){if(e.code!==2||performance.now()>=deadline)throw e;await waitMs(5);}
    }
    this._streamToken=null;this._adcCleanupError=null;
  }
  async startDac(options){
    if(!this.connected)throw Error('先连接探针');
    if(this.busy)throw Error('先停止当前 ADC/DAC 任务');
    if(!this.dac)throw Error('当前固件未支持 DAC');
    this.dac.requireChannel(options.channel);
    const table=dacTable(options,this.dac.caps),dac=this.dac;
    this.setBusy(true);
    const controller=new AbortController();
    const promise=dac.startLut({channel:options.channel,bits:dac.caps.bits,rate:options.rate,idleCode:0},table.codes,{signal:controller.signal});
    this._dacStart={controller,promise};
    try {
      const result=await promise;
      return {...result,actualFrequency:table.actualFrequency===null?null:result.actualRate/result.points};
    } catch(e){
      if(!dac.owned)this.setBusy(false);
      else this.probeManager?.fail('analog',e);
      throw e;
    } finally {this._dacStart=null;}
  }
  async stopDac(){
    if(this._dacStart){
      const start=this._dacStart;start.controller.abort();
      await start.promise.catch(()=>{}); // Drain START before STOP: no late start after stop.
    }
    if(!this.dac?.owned)return;
    try {await this.dac.stop();this.setBusy(false);this.probeManager?.confirm('analog');}
    catch(e){this.probeManager?.fail('analog',e);throw e;}
  }
  async dacStatus(channel=this.dac?.channel ?? 0){
    if(!this.dac)throw Error('先连接探针');
    const s=await this.dac.status(channel);
    if(this.dac.owned && s.token!==this.dac.token)throw Error('DAC 状态任务代数不匹配');
    if(!this._dacStart && this.dac.owned && !s.running && !s.cleanup){this.dac.owned=false;this.setBusy(false);this.probeManager?.confirm('analog');}
    return s;
  }
  async stopAdc(){
    this._adcAbort?.abort();
    try{
      await this._sendStop();
      if(this._adcRun)await withTimeout(this._adcRun.catch(e=>{if(this.busy)throw e;}),4000,'等待 ADC 停止');
      if(this._adcCleanupError||this._streamToken!=null||this._openUncertain)await this._cleanupAdc();
      this._adcCleanupError=null;this.setBusy(false);this.probeManager?.confirm('analog');
    }catch(e){this.probeManager?.fail('analog',e);throw e;}
  }
  async stop(){ await this.stopDac(); await this.stopAdc(); }
  async disconnect(){
    this.probeManager?.cancel('analog');
    if (this._connectPromise) await this._connectPromise.catch(() => {});
    try {
      await this.stop(); await this.transport?.close(); this.transport = null;
      await this.hid?.close(); this.hid = null; this.caps = null; this.dac = null;
      this.probeManager?.forget('analog');
    } catch (e){ this.probeManager?.fail('analog', e); throw e; }
  }
}

export function decodeReply(r,action){
  if(!r||r.length<7||r[0]<8||r[0]>r.length+1||r[1]!==0x38||r[2]!==action)throw Error('ADC DMA 固件响应无效');
  const rc=new DataView(r.buffer,r.byteOffset,r.byteLength).getUint32(3,true);
  if(rc){const e=Error(`ADC DMA 控制失败：${rc}`);e.code=rc;throw e;}
  return r.subarray(7,r[0]-1);
}
export function streamCaps(b){
  if(b.length!==20||String.fromCharCode(...b.subarray(0,4))!=='ADB2'||b[4]!==0x8b||b[5]!==2||b[6]!==15||b[7]!==6)
    throw Error('需要 SPI/ADC 共享 DMA 配套固件');
  const v=new DataView(b.buffer,b.byteOffset,b.byteLength),maxRate=v.getUint32(8,true),reference=v.getUint16(18,true)/1000;
  if(v.getUint16(12,true)!==4096||v.getUint16(14,true)!==4096||maxRate<1||maxRate>2000000||reference<=0)throw Error('ADC DMA 能力信息无效');
  if(b[17]!==1)throw Error('当前板卡未支持共享 SPI 端点的 ADC DMA；此版本支持 HPM5301EVKLite PB14');
  return {channel:6,nativeBits:16,gain:1,reference,maxRate,flags:b[16]};
}
