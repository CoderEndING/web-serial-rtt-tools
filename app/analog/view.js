import { $ } from '../ui/dom.js';
import { AnalogSession } from './session.js';
import { WAVES, dacTable, signalLevels, waveCsv } from './model.js';
import { AdcScopeStore, envelope } from './scope-store.js';
import { PinMap } from '../ui/pin-map.js';
export class AnalogView {
  constructor(){ this.session = new AnalogSession(); this.store = new AdcScopeStore(); this.wave = []; this._raf = null; this.total = 0; }
  init(){
    this.pinMap=new PinMap({buttonId:'an-pinmap-btn',feature:'adc',state:()=>({connected:this.session.connected,connectionKey:this.session.hid?.device||this.session.hid,supported:!!this.session.caps})});
    this.pinMap.init();
    const bind = (id, fn) => $(id).addEventListener('click', () => { Promise.resolve().then(fn).catch(e => this.status(e.message, true)); });
    bind('an-connect', async () => {
      const c = await this.session.connect(); if (!c) return;
      $('an-channel').textContent=c.supported?'CH1 · PB14 / ADC0.6 · EVKLite J3[10]（与 QSPI IO2 互斥）':'当前固件未提供 ADC DMA；DAC 可独立使用';
      if(c.supported){$('an-rate').max=c.maxRate;$('an-reference').value=c.reference;}
      this.updateDacControls();
      try{this.preview();}catch(e){$('an-wave-state').textContent=e.message;}
      this.status(c.supported?(this.session.dac.caps.supported?'ADC/DAC 已连接':'ADC 已连接；当前固件未支持 DAC'):'DAC 信号发生器已连接');
    });
    bind('an-disconnect', async () => { await this.session.disconnect(); this.updateDacControls(); this.status('ADC 已断开'); });
    bind('an-once', () => this.acquire(Math.max(32,Math.min(65536,Math.round(Number($('an-rate').value)*10*Number($('an-time').value)))))); bind('an-start', () => this.acquire(Number($('an-count').value)));
    bind('an-stop', async () => { await this.session.stopAdc(); this.status('已确认 ADC 停止'); });
    bind('an-adc-export', () => this.download('adc.csv', this.store.csv(Number($('an-reference').value))));
    bind('an-wave-export', () => { this.preview(); this.download('waveform-preview.csv', waveCsv(this.wave)); });
    bind('an-preview', () => this.preview());
    bind('an-dac-start', async () => {
      this.preview();
      const options=this.waveOptions(); options.channel=Number($('an-dac-channel').value);
      const r=await this.session.startDac(options);
      $('an-dac-state').textContent=`DAC 已启动：${r.actualRate} Sa/s，${r.points} 点${r.actualFrequency===null?'':`，实际 ${r.actualFrequency.toFixed(4)} Hz`}`;
    });
    bind('an-dac-stop', async () => {if(!this.session.dac?.owned&&!this.session._dacStart)throw Error('本会话没有 DAC 输出任务，请先查询输出状态');await this.session.stopDac();$('an-dac-state').textContent='DAC 已确认停止';});
    bind('an-dac-status', async () => {const s=await this.session.dacStatus(Number($('an-dac-channel').value));$('an-dac-state').textContent=`DAC ${s.running?'运行':'停止'} · 已完成 ${s.cycles} 周期 · ${s.actualRate} Sa/s`;});
    $('an-wave').innerHTML = Object.entries(WAVES).map(([key, label]) => `<option value="${key}">${label}</option>`).join('');
    for (const id of ['an-wave', 'an-update', 'an-frequency', 'an-amplitude', 'an-vpp', 'an-min', 'an-max', 'an-dac-offset', 'an-dac-reference', 'an-duty', 'an-phase', 'an-points', 'an-dac-bits']) $(id).addEventListener('change', () => {
      try { this.syncLevels(['an-min','an-max'].includes(id)?'range':id==='an-vpp'?'vpp':'amplitude');this.preview(); }
      catch (e){ this.wave = []; this.plot('an-dac-canvas', []); $('an-generator-summary').textContent='设置无效';$('an-wave-state').textContent = e.message; }
    });
    this.session.onDisconnect = () => {this.updateDacControls();this.status('探针已掉线；采集已请求取消', true);};
    for(const id of ['an-time','an-volts','an-offset','an-trigger','an-level','an-edge','an-freeze'])$(id).addEventListener('change',()=>this.renderAdc());
    this.updateDacControls(); this.preview(); this.renderAdc();
  }
  status(text, error = false){ $('an-state').textContent = text; $('an-state').style.color = error ? '#f85149' : '';this.pinMap?.refresh(); }
  async acquire(count){
    if(this.session.busy)throw Error('先停止当前采集');
    const options={bits:Number($('an-bits').value),rate:Number($('an-rate').value),count};
    const reference=Number($('an-reference').value);
    if(!Number.isFinite(reference)||reference<=0||reference>10)throw Error('参考电压需为 0–10 V 范围内的正数');
    this.store.reset();this.total=0;this.lastFrame=null;$('an-freeze').checked=false;
    this.status(count?'单次/有限记录采集中…':'连续 DMA 采集中…');
    await this.session.acquire(options,block=>{
      this.store.append(block);this.total=this.store.total;
      if(this._raf===null)this._raf=requestAnimationFrame(()=>{this._raf=null;this.renderAdc();});
    });
    this.renderAdc();this.status(`采集停止，共 ${this.total} 点；保留最近 ${this.store.length} 点可导出`);
  }
  renderAdc(){
    if($('an-freeze').checked)return;
    const reference=Number($('an-reference').value),timeDiv=Number($('an-time').value);
    const voltsDiv=Number($('an-volts').value),offset=Number($('an-offset').value),level=Number($('an-level').value);
    if(!Number.isFinite(offset)||!Number.isFinite(level)||!Number.isFinite(reference)||reference<=0||!(timeDiv>0)||!(voltsDiv>0))return;
    const frame=this.store.frame({timeDiv,reference,trigger:$('an-trigger').value,level,edge:$('an-edge').value});
    if(frame)this.lastFrame=frame;
    const last=this.store.length?this.store.code(this.store.total-1):null;
    if(last!==null)$('an-value').textContent=`${(last/(2**this.store.bits-1)*reference).toFixed(5)} V · code ${last}`;
    $('an-stats').textContent=`${this.total} 点 · 硬件时基 ${(this.store.rate/1000).toFixed(3)} kSa/s · 最近 ${this.store.length} 点可导出 · ${frame?.triggered?'已触发':$('an-trigger').value==='normal'?'等待触发':'自动扫描'}${frame?.limited?' · 当前时窗超过记录长度':''}`;
    if(!frame&&this.lastFrame)return; // Normal trigger holds last complete frame.
    const canvas=$('an-adc-canvas'),ctx=canvas.getContext('2d');if(!ctx)return;
    const w=canvas.width,h=canvas.height;ctx.fillStyle='#090f17';ctx.fillRect(0,0,w,h);
    ctx.strokeStyle='#26384a';ctx.lineWidth=1;
    for(let i=0;i<=10;i++){ctx.beginPath();ctx.moveTo(i*w/10,0);ctx.lineTo(i*w/10,h);ctx.stroke();}
    for(let i=0;i<=8;i++){ctx.beginPath();ctx.moveTo(0,i*h/8);ctx.lineTo(w,i*h/8);ctx.stroke();}
    const y=v=>h/2-(v-offset)/voltsDiv*h/8;
    ctx.setLineDash([5,5]);ctx.strokeStyle='#df9c42';ctx.beginPath();ctx.moveTo(0,y(level));ctx.lineTo(w,y(level));ctx.stroke();ctx.setLineDash([]);
    ctx.fillStyle='#d4e2f1';ctx.font='14px monospace';
    ctx.fillText(`CH1 PB14   ${voltsDiv} V/div   ${timeDiv<0.001?(timeDiv*1e6)+' us/div':(timeDiv*1000)+' ms/div'}`,12,20);
    if(!frame)return;
    const span=timeDiv*10*frame.rate;
    const traceWidth=Math.min(w,Math.max(1,Math.ceil(frame.codes.length/span*w)));
    const points=envelope(frame.codes,traceWidth),scale=reference/(2**frame.bits-1);
    ctx.strokeStyle='#ffd15c';ctx.lineWidth=1.2;ctx.beginPath();
    if(frame.codes.length>traceWidth){
      for(const p of points){const x=p.x*frame.codes.length/span*w/points.length;ctx.moveTo(x,y(p.min*scale));ctx.lineTo(x,y(p.max*scale));}
    }else frame.codes.forEach((code,i)=>{const x=i/span*w;if(i)ctx.lineTo(x,y(code*scale));else ctx.moveTo(x,y(code*scale));});
    ctx.stroke();
  }
  preview(){
    this.wave = [];
    this.plot('an-dac-canvas',[]);$('an-generator-summary').textContent='';$('an-wave-state').textContent='';
    this.syncLevels();
    const options=this.waveOptions(),dc=options.shape==='dc',noise=options.shape==='noise';
    for(const id of ['an-amplitude','an-vpp','an-min','an-max'])$(id).disabled=dc;
    for(const id of ['an-frequency','an-phase'])$(id).disabled=dc||noise;
    $('an-duty').disabled=options.shape!=='pulse';$('an-points').disabled=!noise;
    const caps=this.session.dac?.caps?.supported?this.session.dac.caps:
      {maxRate:10000000,maxPoints:65535,bits:options.bits,fullScale:options.reference};
    const table=dacTable(options,caps);this.wave=table.rows;
    this.plot('an-dac-canvas', this.wave.map(r => r.volts),caps.fullScale);
    const amp=dc?0:options.amplitude,low=options.offset-amp,high=options.offset+amp;
    const freq=table.actualFrequency===null?(dc?'直流':'循环噪声表'):`${table.actualFrequency.toPrecision(6)} Hz`;
    $('an-generator-summary').textContent=`${WAVES[options.shape]} · ${freq} · ${2*amp} Vpp · 共模 ${options.offset} V · ${low.toPrecision(6)}–${high.toPrecision(6)} V`;
    $('an-wave-state').textContent=`${this.wave.length} 点${dc?'直流表':noise?'循环伪随机表':'完整一周期表'} · 更新率 ${options.rate} Sa/s · 表时长 ${(1000*this.wave.length/options.rate).toPrecision(6)} ms${table.actualFrequency===null?'':` · 请求 ${options.frequency} Hz，按整数点数量化`}。预览/导出不启动输出；硬件实际更新率以 START 应答为准。`;
    const ctx=$('an-dac-canvas').getContext('2d');
    if(ctx){ctx.fillStyle='#d4e2f1';ctx.font='14px monospace';ctx.fillText(`${caps.fullScale} V full scale`,12,20);ctx.fillText(`0 → ${(1000*this.wave.length/options.rate).toPrecision(6)} ms`,12,250);}
  }
  syncLevels(source='amplitude'){
    const levels=signalLevels({amplitude:Number($('an-amplitude').value),offset:Number($('an-dac-offset').value),
      min:Number($('an-min').value),max:Number($('an-max').value),vpp:Number($('an-vpp').value)},source);
    const dc=$('an-wave').value==='dc';
    for(const [id,value] of Object.entries({'an-amplitude':levels.amplitude,'an-dac-offset':levels.offset,
      'an-min':dc?levels.offset:levels.min,'an-max':dc?levels.offset:levels.max,'an-vpp':dc?0:levels.vpp}))$(id).value=String(Number(value.toPrecision(12)));
  }
  waveOptions(){
    const shape=$('an-wave').value,periodic=!['dc','noise'].includes(shape);
    return {shape,rate:Number($('an-update').value),frequency:periodic?Number($('an-frequency').value):1,amplitude:Number($('an-amplitude').value),offset:Number($('an-dac-offset').value),reference:Number($('an-dac-reference').value),bits:Number($('an-dac-bits').value),duty:shape==='pulse'?Number($('an-duty').value):50,phase:periodic?Number($('an-phase').value):0,points:Number($('an-points').value)};
  }
  updateDacControls(){
    const c=this.session.dac?.caps,enabled=this.session.connected && !!c?.supported;
    for(const id of ['an-dac-start','an-dac-stop','an-dac-status','an-dac-channel'])$(id).disabled=!enabled;
    $('an-dac-channel').innerHTML=enabled?Array.from({length:c.channels},(_,i)=>`<option value="${i}">通道 ${i+1}</option>`).join(''):'<option value="0">等待支持 DAC 的固件</option>';
    $('an-dac-reference').readOnly=enabled;
    for(const option of $('an-dac-bits').options)option.disabled=enabled && Number(option.value)!==c.bits;
    if(enabled){$('an-dac-reference').value=c.fullScale;$('an-dac-bits').value=c.bits;$('an-update').max=c.maxRate;}
    else $('an-update').max=10000000;
    $('an-points').max=enabled?c.maxPoints:65535;
    $('an-dac-state').textContent=enabled?`DAC 接口就绪：${c.channels} 通道、${c.bits} bit、最高 ${c.maxRate} Sa/s`:'DAC 已预留，当前未连接或固件不支持；仍可预览和导出';
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
  summary(){ return { connected: this.session.connected, busy: this.session.busy, caps: this.session.caps, samples: this.total, wavePoints: this.wave.length, dacAvailable:!!this.session.dac?.caps?.supported, dacOwned:!!this.session.dac?.owned }; }
}
