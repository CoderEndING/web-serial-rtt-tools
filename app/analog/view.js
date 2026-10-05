import { $ } from '../ui/dom.js';
import { AnalogSession } from './session.js';
import { WAVES, waveform, adcCsv, waveCsv } from './model.js';
export class AnalogView {
  constructor(){ this.session = new AnalogSession(); this.rows = []; this.wave = []; this._raf = null; this.total = 0; }
  init(){
    const bind = (id, fn) => $(id).addEventListener('click', () => { Promise.resolve().then(fn).catch(e => this.status(e.message, true)); });
    bind('an-connect', async () => {
      const c = await this.session.connect(); if (!c) return;
      $('an-channel').textContent = c.gain === 2 ? 'PB10 / ADC0.2 · VREF 分压输入（×2）' : 'PB11 / ADC0.3 · 与 SPI2 互斥';
      $('an-reference').value = c.reference;
      this.status('ADC 已连接；DAC 硬件输出尚未接入');
    });
    bind('an-disconnect', async () => { await this.session.disconnect(); this.status('ADC 已断开'); });
    bind('an-once', () => this.acquire(1)); bind('an-start', () => this.acquire(Number($('an-count').value)));
    bind('an-stop', async () => { await this.session.stop(); this.status('已确认 ADC 停止'); });
    bind('an-adc-export', () => this.download('adc.csv', adcCsv(this.rows)));
    bind('an-wave-export', () => { this.preview(); this.download('waveform-preview.csv', waveCsv(this.wave)); });
    bind('an-preview', () => this.preview());
    $('an-wave').innerHTML = Object.entries(WAVES).map(([key, label]) => `<option value="${key}">${label}</option>`).join('');
    for (const id of ['an-wave', 'an-update', 'an-frequency', 'an-amplitude', 'an-offset', 'an-dac-reference', 'an-duty', 'an-points', 'an-dac-bits']) $(id).addEventListener('change', () => {
      try { this.preview(); } catch (e){ this.wave = []; this.plot('an-dac-canvas', []); $('an-wave-state').textContent = e.message; }
    });
    this.session.onDisconnect = () => this.status('探针已掉线；采集已请求取消', true);
    this.preview();
  }
  status(text, error = false){ $('an-state').textContent = text; $('an-state').style.color = error ? '#f85149' : ''; }
  async acquire(count){
    if (this.session.busy) throw Error('先停止当前采集');
    const options = { bits: Number($('an-bits').value), rate: Number($('an-rate').value), count, reference: Number($('an-reference').value) };
    if (!Number.isFinite(options.reference) || options.reference <= 0 || options.reference > 10) throw Error('参考电压需为 0–10 V 范围内的正数');
    this.range = options.reference * (this.session.caps?.gain || 1);
    this.rows = []; this.total = 0; this.status(count === 1 ? '单次采集…' : 'probe 定时采集中…');
    await this.session.acquire(options, row => {
      this.rows.push(row); this.total++; if (this.rows.length > 10000) this.rows.shift();
      if (this._raf === null) this._raf = requestAnimationFrame(() => { this._raf = null; this.renderAdc(); });
    });
    this.renderAdc(); this.status(`采集结束，共 ${this.total} 条；导出保留最近 ${this.rows.length} 条`);
  }
  renderAdc(){
    const last = this.rows.at(-1);
    if (!last) return;
    $('an-value').textContent = `${last.volts.toFixed(5)} V · code ${last.code}`;
    const first = this.rows[0], span = (last.timeMs - first.timeMs) >>> 0;
    const rate = span ? (this.rows.length - 1) * 1000 / span : 0;
    $('an-stats').textContent = `${this.total} 条 · probe 实测 ${rate.toFixed(2)} Sa/s · 累计跳过 ${last.skipped} · 最近 ${this.rows.length} 条可导出`;
    this.plot('an-adc-canvas', this.rows.slice(-512).map(r => r.volts), this.range || 3.3);
  }
  preview(){
    this.wave = [];
    this.wave = waveform({ shape: $('an-wave').value, rate: Number($('an-update').value), frequency: Number($('an-frequency').value), amplitude: Number($('an-amplitude').value), offset: Number($('an-offset').value), reference: Number($('an-dac-reference').value), bits: Number($('an-dac-bits').value), duty: Number($('an-duty').value), points: Number($('an-points').value) });
    this.plot('an-dac-canvas', this.wave.map(r => r.volts), Number($('an-dac-reference').value));
    $('an-wave-state').textContent = `${this.wave.length} 点预览；幅度为峰值（Vpp = 2 × 幅度）。CSV 是波形数据，当前没有物理 DAC 输出。`;
  }
  plot(id, values, max = 3.3){
    const canvas = $(id), ctx = canvas.getContext('2d'); if (!ctx) return;
    const w = canvas.width, h = canvas.height; ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = '#666'; ctx.lineWidth = 0.5;
    for (let i = 1; i < 4; i++){ ctx.beginPath(); ctx.moveTo(0, i * h / 4); ctx.lineTo(w, i * h / 4); ctx.stroke(); }
    if (!values.length) return;
    ctx.strokeStyle = '#58a6ff'; ctx.lineWidth = 1.5; ctx.beginPath();
    values.forEach((v, i) => { const x = i * w / Math.max(1, values.length - 1), y = h - 8 - v / max * (h - 16); if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y); }); ctx.stroke();
  }
  download(name, content){
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  onShow(){ this.renderAdc(); try { this.preview(); } catch (e){ $('an-wave-state').textContent = e.message; } }
  summary(){ return { connected: this.session.connected, busy: this.session.busy, caps: this.session.caps, samples: this.total, wavePoints: this.wave.length, physicalDac: false }; }
}
