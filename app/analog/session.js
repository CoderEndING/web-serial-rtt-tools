import { AkaLinkHid } from '../hid/probe.js';
import { runProbeOperation } from '../core/probe-manager.js';
import { BUS, runSessionPeriodic, stopSessionPeriodic } from '../core/bus-periodic.js';
import { DacClient } from './dac-protocol.js';
import { adcPlan, adcValue, dacTable } from './model.js';
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
        const r = await hid.xfer(0x38, Uint8Array.of(0));
        if (!r || r.length < 19 || r[0] !== 20 || r[1] !== 0x38 || r[2] !== 0 || new DataView(r.buffer, r.byteOffset, r.byteLength).getUint32(3, true) !== 0 || String.fromCharCode(...r.subarray(7, 11)) !== 'ANA1') throw Error('固件未支持 ADC 页面，请导入配套固件');
        const caps = { channel: r[11], nativeBits: r[12], gain: r[13], dac: !!r[14], reference: (r[15] | r[16] << 8) / 1000, maxRate: r[17] | r[18] << 8 };
        if (caps.channel > 15 || caps.nativeBits !== 16 || ![1, 2].includes(caps.gain) || caps.reference <= 0 || (!caps.maxRate || caps.maxRate > 1000)) throw Error('ADC 固件能力信息无效');
        const dac = new DacClient((cmd,data)=>hid.xfer(cmd,data));
        await dac.capabilities();
        this.caps = caps; this.hid = hid; this.dac = dac;
        hid.onDisconnect = () => { this._adcAbort?.abort(); this._dacStart?.controller.abort(); this._periodic?.controller.abort(); this.onDisconnect?.(); };
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
  async _acquire({ bits, rate, count, reference = this.caps?.reference }, onResult, signal){
    if (!this.connected || !this.caps) throw Error('先连接探针');
    if (this.busy) throw Error('ADC 已有采集在进行');
    const caps = this.caps, plan = adcPlan({ channel: caps.channel, bits, rate, count });
    if (plan.actualRate > caps.maxRate) throw Error('采样率超出固件能力');
    const rows = [];
    this.setBusy(true);
    let opened = false;
    try {
      // Request WebUSB from the acquisition gesture before HID round trips.
      if (!this.transport) this.transport = await AdcTransport.request(this.hid.device);
      const streamCaps = await this.streamCommand(9);
      if (streamCaps.length !== 8 || String.fromCharCode(...streamCaps.subarray(0, 4)) !== 'ADB1' || streamCaps[4] !== 0x8c || streamCaps[5] !== 1 || (streamCaps[6] | streamCaps[7] << 8) !== 512)
        throw Error('固件未支持独立 ADC Bulk 数据端点，请更新固件');
      if (signal.aborted) return rows;
      const b = await this.streamCommand(10);
      if (b.length !== 4) throw Error('ADC Bulk 启动应答错误');
      opened = true;
      this.transport.start(new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0, true));
      // USB reader is armed before BP_RUN; MCU timer still determines cadence.
      await runSessionPeriodic(this, BUS.ADC, [plan], { resultSource: this.transport, shouldStop: () => signal.aborted, onResult: r => {
        if (r.err) throw Error(`ADC 采集失败（${r.err}），请检查引脚占用和固件初始化`);
        const value = { ...r, ...adcValue(r.data, bits, reference, caps.gain) };
        if (count === 1) rows.push(value);
        onResult?.(value);
      } });
    } finally {
      try {
        if (this._periodic?.client.stopError) throw this._periodic.client.stopError;
        if (opened){
          await this.streamCommand(11);
          await this.transport.drain();
          await this.streamCommand(12);
        }
        this.setBusy(false);
      } catch (e){ this._adcCleanupError = e; this.probeManager?.fail('analog', e); throw e; }
    }
    return rows;
  }
  async streamCommand(action){
    const r = await this.hid.xfer(0x38, Uint8Array.of(action));
    if (!r || r.length < 7 || r[0] < 8 || r[0] > r.length + 1 || r[1] !== 0x38 || r[2] !== action)
      throw Error('ADC Bulk 固件响应无效');
    const rc = new DataView(r.buffer, r.byteOffset, r.byteLength).getUint32(3, true);
    if (rc) throw Error(`ADC Bulk 控制失败：${rc}`);
    return r.subarray(7, r[0] - 1);
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
    if (this._adcRun) await this._adcRun.catch(e => { if (this.busy) throw e; });
    await stopSessionPeriodic(this);
    if (this._adcCleanupError){
      await this.streamCommand(11); await this.transport?.drain(); await this.streamCommand(12);
      this._adcCleanupError = null; this.setBusy(false); this.probeManager?.confirm('analog');
    }
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
