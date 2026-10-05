import { AkaLinkHid } from '../hid/probe.js';
import { runProbeOperation } from '../core/probe-manager.js';
import { BUS, runSessionPeriodic, stopSessionPeriodic } from '../core/bus-periodic.js';
import { adcPlan, adcValue } from './model.js';
export class AnalogSession {
  constructor(){ this.hid = null; this.caps = null; this.busy = false; this.usingMock = false; }
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
        if (caps.channel > 15 || caps.nativeBits !== 16 || ![1, 2].includes(caps.gain) || caps.reference <= 0 || caps.maxRate !== 1000) throw Error('ADC 固件能力信息无效');
        this.caps = caps; this.hid = hid;
        hid.onDisconnect = () => { this._periodic?.controller.abort(); this.onDisconnect?.(); };
        return caps;
      } catch (e){ await hid.close(); throw e; }
    }, { reason: 'ADC 页面要使用探针', recovery: true });
    try { return await this._connectPromise; } finally { this._connectPromise = null; }
  }
  async acquire({ bits, rate, count, reference = this.caps?.reference }, onResult){
    if (!this.connected || !this.caps) throw Error('先连接探针');
    if (this.busy) throw Error('ADC 已有采集在进行');
    const caps = this.caps, plan = adcPlan({ channel: caps.channel, bits, rate, count });
    if (plan.actualRate > caps.maxRate) throw Error('采样率超出固件能力');
    const rows = [];
    await runSessionPeriodic(this, BUS.ADC, [plan], { onResult: r => {
      if (r.err) throw Error(`ADC 采集失败（${r.err}），请检查引脚占用和固件初始化`);
      const value = { ...r, ...adcValue(r.data, bits, reference, caps.gain) };
      if (count === 1) rows.push(value);
      onResult?.(value);
    } });
    return rows;
  }
  async stop(){ await stopSessionPeriodic(this); }
  async disconnect(){
    this.probeManager?.cancel('analog');
    if (this._connectPromise) await this._connectPromise.catch(() => {});
    try {
      await this.stop(); await this.hid?.close(); this.hid = null; this.caps = null;
      this.probeManager?.forget('analog');
    } catch (e){ this.probeManager?.fail('analog', e); throw e; }
  }
}
