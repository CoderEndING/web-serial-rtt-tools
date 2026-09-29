/**
 * 「SPI/QSPI 桥」页（`#spi`）—— **通用**的那一页：配置、通用帧、链路自检。
 *
 * 与「SPI/QSPI 屏」页（`#panel`）共用同一个 `SpiSession`（一次连接，两页共用）：
 * 这里只管"桥本身能不能用、链路通不通"，屏相关的事（面板档、初始化表、刷图）在那一页。
 *
 * 口径：
 *   · 所有发送都走 `session.sendFrames()`（分配 seq → 打包 → 发 → 等应答）；
 *   · 配置写入一律**回读对账**（状态字的 err 是"最近一次错误"，不能判断本次成功）；
 *   · 回环自检把每个长度原样发出去、原样读回来逐字节比对 —— 真机没接跳线时会 FAIL，那正是它的用处。
 */
import { $, setStatus } from '../ui/dom.js';
import { yieldTask } from '../core/pace.js';
import * as P from './protocol.js';
import { fmtBytes, bytesEqual, parseHexByte, parseHexBytes } from './session.js';

export class SpiBusView {
  constructor(session){
    this.session = session;
    this.tag = 'bus';
    this.loopAbort = false;
    this.unsub = null;
  }

  // ==================================================================== 初始化

  init(){
    const s = this.session;

    // 下拉：SCLK / CS 策略 / 辅助脚
    for (const c of P.SCLK_CHOICES) $('sp-sclk').appendChild(new Option(c.label, String(c.hz)));
    for (const c of P.CS_POLICY) $('sp-cs').appendChild(new Option(c.label, String(c.v)));
    for (const p of P.PADS){
      const label = p.j3 ? `${p.name}（${p.j3}）` : p.name;
      for (const id of ['sp-pad-dc', 'sp-pad-rst', 'sp-pad-csaux', 'sp-pad-bl']) $(id).appendChild(new Option(label, String(p.i)));
    }

    // 连接（两页共用一次会话，所以这里和屏页都能连）
    $('sp-connect').addEventListener('click', () => s.connectHid(true));
    $('sp-reconnect').addEventListener('click', () => s.connectHid(false));
    $('sp-usb').addEventListener('click', () => s.connectUsb(null, { inFlight: +($('sp-inflight').value || 4) }));
    $('sp-mock').addEventListener('change', e => s.setMock(e.target.checked));

    // 配置 / 引脚
    $('sp-get').addEventListener('click', () => this.loadCfg());
    $('sp-set').addEventListener('click', () => this.applyCfg());
    $('sp-pin-apply').addEventListener('click', () => this.applyCfg());

    // 使能 / 收尾
    $('sp-enable').addEventListener('click', () => this.setEnabled(true));
    $('sp-disable').addEventListener('click', () => this.setEnabled(false));
    $('sp-reset').addEventListener('click', () => this.wrap(() => s.reset({ tag: this.tag })));
    $('sp-abort').addEventListener('click', () => this.wrap(() => s.abort({ tag: this.tag })));
    $('sp-status').addEventListener('click', () => s.pollStatus(true));

    // 通用帧
    $('sp-x-send').addEventListener('click', () => this.sendXfer());
    $('sp-f-ping').addEventListener('click', () => this.simpleFrame(P.T.PING, new Uint8Array(0), 'PING'));
    $('sp-f-auxin').addEventListener('click', () => this.sendAuxIn());
    $('sp-f-cs-low').addEventListener('click', () => this.simpleFrame(P.T.CS, P.csPayload(true), 'CS↓'));
    $('sp-f-cs-high').addEventListener('click', () => this.simpleFrame(P.T.CS, P.csPayload(false), 'CS↑'));
    $('sp-f-gpio').addEventListener('click', () => this.sendGpio());
    $('sp-f-delay-send').addEventListener('click', () => this.simpleFrame(P.T.DELAY, P.delayPayload(Math.max(0, +$('sp-f-delay').value || 0)), 'DELAY'));
    $('sp-f-reset-send').addEventListener('click', () => this.simpleFrame(P.T.RESET,
      P.resetPayload(Math.max(0, +$('sp-f-reset-low').value || 0), Math.max(0, +$('sp-f-reset-post').value || 0)), 'RESET 脉冲'));

    // 回环自检
    $('sp-lb-run').addEventListener('click', () => this.loopbackTest());
    $('sp-lb-cancel').addEventListener('click', () => { this.loopAbort = true; });

    $('sp-log-clear').addEventListener('click', () => { $('sp-log').innerHTML = ''; });

    this.unsub = s.subscribe(this);
    s.log('i', '就绪。真机：先「连接探针」再「连接数据端点」；没板子就勾「用假探针」。');
    this.renderState(s.stateInfo());
    this.renderCounters(s.counters, s.lastStatus);
  }

  /** session 的事件入口 */
  onSession(type, payload){
    if (type === 'log') this.appendLog(payload);
    else if (type === 'state'){ this.renderState(payload); this.refreshButtons(); }
    else if (type === 'busy') this.refreshButtons();
    else if (type === 'cfg') this.fillCfg(payload);
    else if (type === 'counters') this.renderCounters(payload.counters, payload.lastStatus);
  }

  // ==================================================================== 渲染

  appendLog(e){
    const el = $('sp-log');
    if (!el) return;
    const d = document.createElement('div');
    d.className = e.kind === 'g' ? 'ok' : e.kind === 'e' ? 'err' : e.kind === 'w' ? 'warn' : 'dim';
    d.textContent = (e.tag === 'panel' ? '[屏] ' : '') + e.text;
    el.appendChild(d);
    while (el.childNodes.length > 500) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
  }

  /** 切回本页时按 ring 重建（另一页期间发生的事也在这里补上）*/
  renderLogFromRing(){
    const el = $('sp-log');
    if (!el) return;
    el.innerHTML = '';
    for (const e of this.session.ring) this.appendLog(e);
  }

  renderState(st){
    setStatus($('sp-state'), st.text, st.kind || '');
    $('sp-info').textContent = st.mock ? '假探针（无需硬件）' : (st.hidLabel || '未连接');
    $('sp-usbinfo').textContent = st.dataReady ? st.transportLabel : '未连接数据端点（假探针模式不需要）';
    $('sp-mock').checked = !!st.mock;
  }

  renderCounters(c, lastStatus){
    if (!c) return;
    $('sp-c-ok').textContent = String(c.framesOk ?? 0);
    $('sp-c-err').textContent = String(c.framesErr ?? 0);
    $('sp-c-tx').textContent = fmtBytes(c.bytesTx ?? 0);
    $('sp-c-rx').textContent = fmtBytes(c.bytesRx ?? 0);
    $('sp-c-poll').textContent = String(c.txPoll ?? 0);
    $('sp-c-dma').textContent = String(c.txDma ?? 0);
    $('sp-c-in').textContent = String(c.inDrop ?? 0);
    $('sp-c-ovf').textContent = String(c.outOverrun ?? 0);
    $('sp-sclk-actual').textContent = c.actualSclkHz ? P.sclkLabel(c.actualSclkHz) : '—';
    $('sp-last-us').textContent = c.lastUs ? c.lastUs.toFixed(1) : '—';   // 上一笔事务耗时（调 SCLK 时看这个）
    if (lastStatus){
      $('sp-word').textContent = '0x' + (lastStatus.status >>> 0).toString(16).padStart(8, '0');
      $('sp-word-text').textContent = P.statusText(lastStatus.status);
    }
  }

  fillCfg(c){
    $('sp-sclk').value = String(c.sclkHz);
    if ($('sp-sclk').selectedIndex < 0) $('sp-sclk').value = '0';
    $('sp-mode').value = String(c.mode);
    if ($('sp-mode').selectedIndex < 0) $('sp-mode').value = '0';
    $('sp-cs').value = String(c.csPolicy);
    $('sp-thr').value = String(c.txDmaThreshold);
    $('sp-clear').checked = !!(c.flags & P.CFG_FLAG.CLEAR_ON_ENABLE);
    $('sp-pad-dc').value = String(c.padDc);
    $('sp-pad-rst').value = String(c.padRst);
    $('sp-pad-csaux').value = String(c.padCsAux);
    $('sp-pad-bl').value = String(c.padBl);
    $('sp-al-dc').checked = P.lineActiveLow(c.padActiveLow, P.LINE.DC);
    $('sp-al-rst').checked = P.lineActiveLow(c.padActiveLow, P.LINE.RST);
    $('sp-al-cs').checked = P.lineActiveLow(c.padActiveLow, P.LINE.CS_AUX);
    $('sp-al-bl').checked = P.lineActiveLow(c.padActiveLow, P.LINE.BL);
    $('sp-ring').textContent = `OUT ${c.outRingKb} KB / IN ${c.inRingKb} KB / 单帧上限 ${c.maxFrameBytes} B`;
  }

  refreshButtons(){
    const s = this.session, c = s.connected, d = s.dataReady, busy = s.busy;
    $('sp-get').disabled = !c; $('sp-set').disabled = !c; $('sp-pin-apply').disabled = !c;
    $('sp-enable').disabled = !c; $('sp-disable').disabled = !c;
    $('sp-reset').disabled = !c; $('sp-abort').disabled = !c; $('sp-status').disabled = !c;
    $('sp-x-send').disabled = !d || busy;
    for (const id of ['sp-f-ping', 'sp-f-auxin', 'sp-f-cs-low', 'sp-f-cs-high', 'sp-f-gpio', 'sp-f-delay-send', 'sp-f-reset-send']) $(id).disabled = !d || busy;
    $('sp-lb-run').disabled = !d || busy;
    $('sp-lb-cancel').disabled = !busy;
  }

  // ==================================================================== 配置

  async wrap(fn){
    try { await fn(); } catch (e){ this.session.log('e', e?.message || String(e), this.tag); }
  }

  async loadCfg(){
    await this.wrap(() => this.session.loadCfg({ tag: this.tag }));
  }

  readCfgFromUI(){
    let activeLow = 0;
    if ($('sp-al-dc').checked) activeLow |= 1 << P.LINE.DC;
    if ($('sp-al-rst').checked) activeLow |= 1 << P.LINE.RST;
    if ($('sp-al-cs').checked) activeLow |= 1 << P.LINE.CS_AUX;
    if ($('sp-al-bl').checked) activeLow |= 1 << P.LINE.BL;
    return {
      sclkHz: +$('sp-sclk').value || 0,
      mode: +$('sp-mode').value || 0,
      bits: 8,
      csPolicy: +$('sp-cs').value || 0,
      txDmaThreshold: Math.max(0, Math.min(255, +$('sp-thr').value || 0)),
      padDc: +$('sp-pad-dc').value || 0,
      padRst: +$('sp-pad-rst').value || 0,
      padCsAux: +$('sp-pad-csaux').value || 0,
      padBl: +$('sp-pad-bl').value || 0,
      padActiveLow: activeLow,
      padTe: this.session.cfg?.padTe ?? 0,
      flags: $('sp-clear').checked ? P.CFG_FLAG.CLEAR_ON_ENABLE : 0,
      outRingKb: this.session.cfg?.outRingKb ?? 16,
      inRingKb: this.session.cfg?.inRingKb ?? 8,
    };
  }

  async applyCfg(){
    await this.wrap(() => this.session.applyConfig(this.readCfgFromUI(), this.tag));
  }

  async setEnabled(on){
    await this.wrap(() => this.session.setEnabled(on, this.tag));
  }

  // ==================================================================== 通用帧

  readXferFromUI(){
    const lines = +$('sp-x-lines').value || 1;
    let tcfg = P.linesToTcfg(lines);
    if ($('sp-x-cmden').checked) tcfg |= P.TC.CMD_EN;
    if ($('sp-x-addren').checked) tcfg |= P.TC.ADDR_EN;
    if ($('sp-x-addrquad').checked) tcfg |= P.TC.ADDR_QUAD;
    if ($('sp-x-dcen').checked) tcfg |= P.TC.DC_EN;
    if ($('sp-x-dclevel').checked) tcfg |= P.TC.DC_LEVEL;
    if ($('sp-x-token').checked) tcfg |= P.TC.TOKEN_EN;
    const tx = parseHexBytes($('sp-x-tx').value);
    const rxLen = Math.max(0, Math.min(P.FRAME_MAX, +$('sp-x-rx').value || 0));
    const t = {
      cmd: parseHexByte($('sp-x-cmd').value, 0),
      tcfg, addrLen: +$('sp-x-addrlen').value || 0, dummy: +$('sp-x-dummy').value || 0,
      addr: Number($('sp-x-addr').value) >>> 0, tx, rxLen,
    };
    if (t.tx.length > P.XFER_TX_MAX) throw new Error(`发送数据 ${t.tx.length} B 超过单帧上限 ${P.XFER_TX_MAX} B（要拆成多帧）`);
    if (t.tx.length && rxLen && t.tx.length !== rxLen) throw new Error('全双工要求收发等长（探测不到就拆成两帧）');
    if (rxLen && !$('sp-x-rsp').checked) throw new Error('读数据必须勾「要应答（RSP）」，否则固件直接判帧格式错');
    return t;
  }

  async sendXfer(){
    try {
      const t = this.readXferFromUI();
      let flags = 0;
      if ($('sp-x-rsp').checked) flags |= P.F.RSP;
      if ($('sp-x-cshold').checked) flags |= P.F.CS_HOLD;
      if ($('sp-x-csoff').checked) flags |= P.F.CS_OFF;
      if ($('sp-x-csaux').checked) flags |= P.F.CS_AUX;
      if ($('sp-x-nodma').checked) flags |= P.F.NO_DMA;
      if ($('sp-x-forcedma').checked) flags |= P.F.FORCE_DMA;
      await this.session.sendFrames([{ type: P.T.XFER, payload: P.xferPayload(t), flags, label: 'XFER' }], { tag: this.tag });
    } catch (e){ this.session.log('e', 'XFER 参数有问题：' + (e?.message || e), this.tag); }
  }

  async simpleFrame(type, payload, label){
    try { await this.session.sendFrames([{ type, payload, flags: P.F.RSP, label }], { tag: this.tag }); }
    catch (e){ this.session.log('e', `${label} 失败：` + (e?.message || e), this.tag); }
  }

  async sendAuxIn(){
    try {
      const r = await this.session.sendFrames([{ type: P.T.AUX_IN, payload: new Uint8Array(0), flags: P.F.RSP, label: 'AUX_IN' }], { tag: this.tag });
      const d = r.rsps[0]?.data;
      if (d) this.session.log('i', `辅助输入位图 = 0x${d[0].toString(16).padStart(2, '0')}` + ((d[0] & P.AUXIN_TE) ? ' · TE 有效' : ' · TE 无效'), this.tag);
    } catch (e){ this.session.log('e', 'AUX_IN 失败：' + (e?.message || e), this.tag); }
  }

  async sendGpio(){
    const line = +$('sp-f-gpio-line').value || 0, level = +$('sp-f-gpio-level').value ? 1 : 0;
    await this.simpleFrame(P.T.GPIO, P.gpioPayload(line, level), 'GPIO');
  }

  // ==================================================================== 回环自检

  /**
   * MOSI↔MISO 跳线回环扫描（J3[19]-J3[21]）：
   * 每个长度都跑 tx_len == rx_len 的全双工读回并逐字节比对；
   * `FORCE_DMA` 那一档用来对照（P1 固件两条路径都计入 tx_poll，见方案 §2.3 第 7 条）。
   */
  async loopbackTest(){
    const s = this.session;
    if (s.busy) return;
    if (!s.dataReady){ s.log('e', '先「连接数据端点」（或勾「用假探针」）', this.tag); return; }
    if (!s.enabled) s.log('w', '桥还没使能 —— 先点「使能」，否则帧会被判 SB_E_DISABLED', this.tag);

    const lens = String($('sp-lb-lens').value || '').split(/[,\s]+/).map(x => +x).filter(n => n > 0 && n <= P.XFER_TX_MAX);
    const lines = +$('sp-lb-lines').value || 1;
    const modes = $('sp-lb-dma').checked ? [['轮询', 0], ['强制DMA', P.F.FORCE_DMA]] : [['轮询', 0]];
    if (!lens.length){ s.log('e', '长度列表是空的', this.tag); return; }

    s.setBusy(true); this.loopAbort = false; this.refreshButtons();
    const t0 = performance.now();
    const rows = [];
    s.log('i', `回环自检开始：${lines} 线 · ${lens.length} 个长度 × ${modes.length} 种路径` +
      (s.usingMock ? '（假探针：读回 = 发出去的字节）' : '（真机需要 J3[19]↔J3[21] 跳线）'), this.tag);
    try {
      for (const len of lens){
        for (const [name, force] of modes){
          if (this.loopAbort) break;
          const tx = new Uint8Array(len);
          for (let i = 0; i < len; i++) tx[i] = (i * 7 + len) & 0xff;
          let status = -1, back = null, err = '';
          try {
            const r = await s.sendFrames([{
              type: P.T.XFER,
              payload: P.xferPayload({ tcfg: P.linesToTcfg(lines), tx, rxLen: len }),
              flags: P.F.RSP | force,
              label: `loop len=${len}`,
            }], { quiet: true, tag: this.tag });
            const res = r.rsps[0];
            if (res){ status = res.status; back = res.data; } else err = '无应答（超时）';
          } catch (e){ err = e?.message || String(e); }
          const good = status === 0 && back && back.length === len && bytesEqual(back, tx);
          rows.push({ len, mode: name, status, ok: good, err });
          s.log(good ? 'g' : 'e', `  len=${String(len).padStart(3)} ${name.padEnd(6)} ` +
            (good ? 'PASS' : `FAIL${err ? ' · ' + err : ` · status=${status}/${P.ST_TEXT[status] || '?'}`}`), this.tag);
          this.renderLoopRows(rows);
          await yieldTask();
        }
        if (this.loopAbort) break;
      }
    } finally {
      s.setBusy(false); this.refreshButtons();
    }
    const pass = rows.filter(r => r.ok).length;
    s.log(pass === rows.length ? 'g' : 'e',
      `回环自检完成：${pass}/${rows.length} PASS · ${(performance.now() - t0).toFixed(0)} ms` +
      (pass === rows.length ? '' : '（检查跳线 / 使能状态 / SCLK 档位）'), this.tag);
    this.renderLoopRows(rows);
    await s.pollStatus(true);
  }

  renderLoopRows(rows){
    $('sp-lb-body').innerHTML = rows.map(r => `<tr class="${r.ok ? 'ok' : 'bad'}"><td>${r.len}</td><td>${r.mode}</td>` +
      `<td>${r.ok ? 'PASS' : 'FAIL'}</td><td>${r.err || (r.status === 0 ? 'OK' : `${r.status}/${P.ST_TEXT[r.status] || '?'}`)}</td></tr>`).join('');
    const pass = rows.filter(r => r.ok).length;
    setStatus($('sp-lb-sum'), rows.length ? `${pass}/${rows.length} PASS` : '未跑', rows.length ? (pass === rows.length ? 'ok' : 'err') : '');
  }

  // ==================================================================== 生命周期

  onShow(){
    this.renderLogFromRing();
    this.refreshButtons();
    this.session.pollStatus(true);
  }

  summary(){ return this.session.summary(); }
}
