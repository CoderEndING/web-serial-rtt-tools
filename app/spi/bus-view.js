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
import { $, setStatus, appendLogLine } from '../ui/dom.js';
import { yieldTask, waitMs } from '../core/pace.js';
import * as P from './protocol.js';
import * as D from './frames-dsl.js';
import * as FL from './flash.js';
import { fmtBytes, bytesEqual, parseHexByte, parseHexBytes } from './session.js';

/** HTML 转义（DSL 的错误表要原样显示用户写的那行）*/
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/** 十六进制转储（每行 16 B，带偏移）*/
function hexDump(bytes, max = 256){
  const b = bytes instanceof Uint8Array ? bytes.subarray(0, max) : new Uint8Array(0);
  const lines = [];
  for (let i = 0; i < b.length; i += 16){
    const row = [...b.subarray(i, i + 16)].map(x => x.toString(16).padStart(2, '0')).join(' ');
    lines.push(`${i.toString(16).padStart(4, '0')}  ${row}`);
  }
  return lines.join('\n') || '（空）';
}
/** 吞吐文本：B/ms → KB/s 或 MB/s */
const rate = (bytes, ms) => {
  if (!ms) return '—';
  const bps = bytes / (ms / 1000);
  return bps >= 1048576 ? (bps / 1048576).toFixed(2) + ' MB/s' : (bps / 1024).toFixed(0) + ' KB/s';
};

export class SpiBusView {
  constructor(session){
    this.session = session;
    this.tag = 'bus';
    this.loopAbort = false;
    this.unsub = null;
    this.lastRead = null;      // 最近一次 flash 读回的数据（写校验用）
  }

  // ==================================================================== 初始化

  init(){
    const s = this.session;

    // 下拉：SCLK / CS 策略 / 辅助脚
    for (const c of P.SCLK_CHOICES) $('sp-sclk').appendChild(new Option(c.label, String(c.hz)));
    for (const c of P.CS_POLICY) $('sp-cs').appendChild(new Option(c.label, String(c.v)));
    for (const p of P.PADS){
      const label = p.j3 ? `${p.name}（${p.j3}）` : p.name;
      for (const id of ['sp-pad-dc', 'sp-pad-rst', 'sp-pad-csaux', 'sp-pad-bl']){
        const o = new Option(label, String(p.i));
        o.dataset.pad = String(p.i);
        $(id).appendChild(o);
      }
    }
    this.refreshPads();

    // 通用命令表（10 行，一行一条 XFER）
    this.buildCmdRows(10);

    // flash 卡的下拉与语法速查
    for (const m of FL.READ_MODES) $('sp-fl-mode').appendChild(new Option(m.name, String(m.v)));
    $('sp-fl-mode').value = String(FL.OP.QIOR);
    for (const e of FL.ERASE_MODES) $('sp-fl-erase-mode').appendChild(new Option(e.name, String(e.v)));
    for (const x of D.DSL_SAMPLES) $('sp-dsl-preset').appendChild(new Option(x.name, x.name));
    $('sp-dsl-help').textContent = D.DSL_HELP;
    $('sp-dsl-text').value = D.DSL_SAMPLES[0].text;

    // 连接（两页共用一次会话，所以这里和屏页都能连）
    $('sp-connect').addEventListener('click', () => s.connectHid(true));
    $('sp-reconnect').addEventListener('click', () => s.connectHid(false));
    $('sp-usb').addEventListener('click', () => s.connectUsb(null, { inFlight: +($('sp-inflight').value || 4) }));
    $('sp-mock').addEventListener('change', e => s.setMock(e.target.checked));

    // 配置 / 引脚
    $('sp-get').addEventListener('click', () => this.loadCfg());
    $('sp-set').addEventListener('click', () => this.applyCfg());
    $('sp-pin-apply').addEventListener('click', () => this.applyCfg());
    $('sp-bl-on').addEventListener('click', () => this.sendGpio(P.LINE.BL, 1, '背光开'));
    $('sp-bl-off').addEventListener('click', () => this.sendGpio(P.LINE.BL, 0, '背光关'));
    $('sp-pin-rst-send').addEventListener('click', () => this.sendRstPulse());
    /* 引脚分配图：点一下弹出 J3 40 针的分配（桥的信号 / CDC 串口 / 可当辅助脚的 / 不能用的）*/
    $('sp-pinmap-btn').addEventListener('click', () => this.togglePinMap());
    $('sp-pinmap-close').addEventListener('click', () => { $('sp-pinmap').hidden = true; });

    // 使能 / 收尾
    $('sp-enable').addEventListener('click', () => this.setEnabled(true));
    $('sp-disable').addEventListener('click', () => this.setEnabled(false));
    $('sp-reset').addEventListener('click', () => this.wrap(() => s.reset({ tag: this.tag })));
    $('sp-abort').addEventListener('click', () => this.wrap(() => s.abort({ tag: this.tag })));
    $('sp-status').addEventListener('click', () => s.pollStatus(true));

    // 通用命令表
    $('sp-cmd-send').addEventListener('click', () => this.cmdSendAll());
    $('sp-cmd-clear').addEventListener('click', () => this.cmdClearResults());
    $('sp-cmd-body').addEventListener('keydown', e => {
      // 表里敲回车 = 发送全部（比在几十个格子间找按钮顺手）
      if (e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); this.cmdSendAll(); }
    });

    // 通用命令（文本 / C 表）
    $('sp-dsl-load').addEventListener('click', () => this.dslLoadSample());
    $('sp-dsl-parse').addEventListener('click', () => this.dslRun(false));
    $('sp-dsl-send').addEventListener('click', () => this.dslRun(true));
    $('sp-dsl-file').addEventListener('click', () => $('sp-dsl-file-input').click());
    $('sp-dsl-file-input').addEventListener('change', e => this.dslLoadFile(e.target.files?.[0]));
    for (const [id, kind] of [['sp-dsl-out-c', 'c'], ['sp-dsl-out-json', 'json'], ['sp-dsl-out-text', 'text']])
      $(id).addEventListener('click', () => this.dslExport(kind));
    $('sp-dsl-clear').addEventListener('click', () => { $('sp-dsl-text').value = ''; $('sp-dsl-err').innerHTML = ''; $('sp-dsl-errwrap').style.display = 'none'; setStatus($('sp-dsl-sum'), '已清空', ''); });

    // SPI / NOR Flash
    $('sp-fl-readid').addEventListener('click', () => this.flReadId());
    $('sp-fl-sfdp').addEventListener('click', () => this.flReadSfdp());
    $('sp-fl-sr').addEventListener('click', () => this.flReadStatus());
    $('sp-fl-wiring').addEventListener('click', () => this.flWiring());
    $('sp-fl-read').addEventListener('click', () => this.flReadUI());
    $('sp-fl-bench').addEventListener('click', () => this.flBench());
    $('sp-fl-armed').addEventListener('change', () => this.refreshButtons());
    $('sp-fl-fill').addEventListener('click', () => this.flFillPattern());
    $('sp-fl-erase').addEventListener('click', () => this.flErase());
    $('sp-fl-write').addEventListener('click', () => this.flWrite());
    $('sp-fl-writebench').addEventListener('click', () => this.flWriteBench());

    // 回环自检
    $('sp-lb-run').addEventListener('click', () => this.loopbackTest());
    $('sp-lb-cancel').addEventListener('click', () => { this.loopAbort = true; });

    $('sp-log-clear').addEventListener('click', () => { $('sp-log').innerHTML = ''; });

    // 两张新卡可以折叠（按钮文字按**初始状态**同步一次，别写死"收起"跟 class 对不上）
    for (const b of document.querySelectorAll('#tab-spi .foldbtn')){
      const card = $(b.dataset.fold);
      b.textContent = card.classList.contains('folded') ? '展开' : '收起';
      b.addEventListener('click', () => {
        card.classList.toggle('folded');
        b.textContent = card.classList.contains('folded') ? '展开' : '收起';
      });
    }

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
    else if (type === 'profile') this.refreshPads();
    else if (type === 'counters') this.renderCounters(payload.counters, payload.lastStatus);
  }

  // ==================================================================== 渲染

  appendLog(e){
    appendLogLine($('sp-log'),
      (e.tag === 'panel' ? '[屏] ' : '') + e.text,
      e.kind === 'g' ? 'ok' : e.kind === 'e' ? 'err' : e.kind === 'w' ? 'warn' : 'dim');
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
    $('sp-cmd-send').disabled = !d || busy;
    $('sp-lb-run').disabled = !d || busy;
    $('sp-lb-cancel').disabled = !busy;
    for (const id of ['sp-bl-on', 'sp-bl-off', 'sp-pin-rst-send']) $(id).disabled = !d || busy;
    // 通用命令（文本）/ flash：没数据端点或正忙时不能发
    for (const id of ['sp-dsl-parse', 'sp-dsl-send']) $(id).disabled = !d || busy;
    for (const id of ['sp-fl-readid', 'sp-fl-sfdp', 'sp-fl-sr', 'sp-fl-read', 'sp-fl-bench']) $(id).disabled = !d || busy;
    // 擦写按钮：既要连着，也要勾了「我确认」
    const armed = $('sp-fl-armed').checked;
    for (const id of ['sp-fl-erase', 'sp-fl-write', 'sp-fl-writebench']) $(id).disabled = !d || busy || !armed;
  }

  /**
   * 引脚下拉的可用性跟固件对齐（`sb_pad_ok` / `sb_cfg_validate`）：
   * PY00/PY01 v1 不支持；PB10~PB13 现在（2026-09-30 起）是 **SPI2 的 CS/SCLK/MISO/MOSI**，
   * 永远不能当辅助脚；PA30 是 USB0_PWR 网络（被板上 Q1 常态短到地），也别用；
   * PA31（USB0_ID 网络）现在是自由脚，可以当慢速输出。
   * 灰掉只是**提前告知** —— 真发下去固件也会回 RANGE，那是最后一道闸。
   */
  refreshPads(){
    const quad = this.session.profile?.profile === P.PROFILE_KIND.QSPI;
    const notes = [];
    /* SPI2 固定脚（固件 reserved[]）：PB10/CS(4)、PB11/SCLK(1)、PB12/MISO(2)、PB13/MOSI(3) */
    const SPI2_PADS = [1, 2, 3, 4];
    for (const id of ['sp-pad-dc', 'sp-pad-rst', 'sp-pad-csaux', 'sp-pad-bl']){
      const sel = $(id);
      if (!sel) continue;
      for (const o of sel.options){
        const pad = +o.dataset.pad;
        /* 9/10 = PY00/PY01（v1 不支持）；SPI2_PADS = 桥的信号线；12 = PA30（被 Q1 短到地） */
        const bad = pad === 9 || pad === 10 || pad === 12 || SPI2_PADS.includes(pad);
        o.disabled = bad;
      }
      if (sel.selectedOptions[0]?.disabled){
        const was = sel.selectedOptions[0].textContent;
        sel.value = '0';
        this.session.log('w', `${id.replace('sp-pad-', '').toUpperCase()} 选的「${was}」固件会拒（SPI2 固定脚 / PY / PA30），已改回「不用」`, this.tag);
      }
    }
    notes.push('PB10~PB13 是 SPI2 的 CS/SCLK/MISO/MOSI（已灰）');
    notes.push('PA30 是 USB0_PWR 网络，被板上 Q1 常态短到地，拉不动（已灰）');
    notes.push('PY00/PY01 在 v1 不支持（已灰）');
    $('sp-pad-note').textContent = 'TE 撕裂信号暂不暴露（TBD）。' + notes.join('；') + '。';
  }

  // ------------------------------------------------------------ 引脚分配图

  async togglePinMap(){
    const box = $('sp-pinmap');
    box.hidden = !box.hidden;
    if (box.hidden) return;
    /* 没读到配置就先自动读一次（连着探针 / 假探针都可以读），否则图里标不出辅助脚 */
    const s = this.session;
    if (!s.cfg && (s.connected || s.usingMock)){
      await this.wrap(() => s.loadCfg({ tag: this.tag }));
      this.refreshPads();
    }
    this.renderPinMap();
  }

  /**
   * 画 J3 40 针的引脚分配（2026-09-30 SPI2/UART2 迁移后的接法）。
   * 标记：★ 桥的信号（SPI2） ● CDC 虚拟串口（UART2） ○ 可当辅助脚 ⛔ 不可用 · 电源/地/空脚
   *       << DC/RST/CS_AUX/BL/TE = 当前配置里挂在这根 pad 上的辅助线
   *
   * ⚠️ 配置里的 padDc/padRst/... 是**协议 pad 索引**（见 protocol.js 的 PADS），
   *    不是 J3 脚号 —— 表格每行末尾那个数字才是 pad 索引（0 = 这根脚不在 pad 表里）。
   *    曾经拿 J3 脚号去比过，结果 "DC=PA02(index 5)" 被标到了 J3[5]（PB08）上。
   */
  renderPinMap(){
    const c = this.session.cfg || {};
    /**
     * [线名, 配置里的值, **默认脚位**]
     *
     * 默认脚位取自 `protocol.AUX_DEFAULT`（固定表），**不跟屏型号走** —— 用户 2026-09-30：
     * 接线在配置之前，图上必须"配置值优先、否则默认值"，不能忽有忽无、更不能指到不能用的脚。
     */
    const LINES = [
      ['DC', c.padDc, P.AUX_DEFAULT.DC], ['RST', c.padRst, P.AUX_DEFAULT.RST],
      ['CS_AUX', c.padCsAux, P.AUX_DEFAULT.CS_AUX], ['BL', c.padBl, P.AUX_DEFAULT.BL],
      ['TE', c.padTe, P.AUX_DEFAULT.TE],
    ];
    /**
     * 这根 pad 上挂了什么线：
     *   · `now` = 配置里**真的配了**的（实心显示）
     *   · `dft` = 这条线**还没配**、但按推荐脚位该在这根脚上（虚线 +「（默认）」，供接线的人看）
     * 两条规矩：**配过的线不再显示它的默认位置**（你已经在别处配了它）；
     * 一根脚上**不同时**出实心和虚线（这根脚的接线已经定下来了，别再让人犹豫）。
     */
    const sel = pad => {
      if (!pad) return { now: '', dft: '' };
      const now = LINES.filter(([, v]) => v === pad).map(([n]) => n).join('/');
      const dft = now ? '' : LINES.filter(([, v, d]) => !v && d === pad).map(([n]) => n).join('/');
      return { now, dft };
    };
    const M = { spi: '★', vcom: '●', aux: '○', no: '⛔', pwr: '·', gnd: '·', nc: '·' };
    /* [J3 脚, pad 名/标签, 角色, 备注, 协议 pad 索引（0 = 不在辅助脚表里）] */
    const T = [
      [1, '3V3', 'pwr', '', 0], [2, '5V0', 'pwr', '', 0],
      [3, 'PB09', 'vcom', 'VCOM RX (UART2)', 0], [4, '5V0', 'pwr', '', 0],
      [5, 'PB08', 'vcom', 'VCOM TX (UART2)', 0], [6, 'GND', 'gnd', '', 0],
      [7, 'PA02', 'aux', '', 5], [8, 'PB15', 'spi', 'D3 / IO3', 0],
      [9, 'GND', 'gnd', '', 0], [10, 'PB14', 'spi', 'D2 / IO2', 0],
      [11, 'PA31', 'aux', 'USB0_ID net', 13], [12, 'NC', 'nc', '', 0],
      [13, 'PB11', 'spi', 'SCLK', 1], [14, 'GND', 'gnd', '', 0],
      [15, 'NC', 'nc', '', 0], [16, 'NC', 'nc', '', 0],
      [17, '3V3', 'pwr', '', 0], [18, 'NC', 'nc', '', 0],
      [19, 'PA29', 'aux', '原 SPI1 MOSI（2026-09-30 释放）', 17], [20, 'GND', 'gnd', '', 0],
      [21, 'PA28', 'aux', '原 SPI1 MISO（2026-09-30 释放）', 16], [22, 'NC', 'nc', '', 0],
      [23, 'PA27', 'aux', '原 SPI1 SCLK（2026-09-30 释放）', 15], [24, 'PA26', 'aux', '原 SPI1 CS0（2026-09-30 释放）', 14],
      [25, 'GND', 'gnd', '', 0], [26, 'PB10', 'spi', 'CS', 4],
      [27, 'PB12', 'spi', 'D1 / MISO', 2], [28, 'PB13', 'spi', 'D0 / MOSI', 3],
      [29, 'PY00', 'no', 'PIOC domain', 9], [30, 'GND', 'gnd', '', 0],
      [31, 'PY01', 'no', 'PIOC domain', 10], [32, 'PA09', 'aux', 'USER key', 6],
      [33, 'PA10', 'no', 'board LED（每 50 ms 被 LED 任务写，实测驱动不出持续电平）', 11], [34, 'GND', 'gnd', '', 0],
      [35, 'NC', 'nc', '', 0], [36, 'PA00', 'no', 'log UART0', 7],
      [37, 'PA30', 'no', 'USB0_PWR + Q1', 12], [38, 'PA01', 'no', 'log UART0', 8],
      [39, 'GND', 'gnd', '', 0], [40, 'NC', 'nc', '', 0],
    ];
    const cell = ([pin, name, role, note, pad]) => {
      const { now, dft } = sel(pad);
      const cls = { spi: 'is-spi', vcom: 'is-vcom', aux: 'is-aux', no: 'is-no' }[role] || 'is-plain';
      /* 配置把辅助线挂在"当不了辅助脚"的脚上（SPI2 固定脚 / CDC 串口 / 保留脚 / 实测不可用）
       * ＝ 陈旧或错误的配置：标红 + ⚠，别让人以为接对了 */
      const stale = !!now && role !== 'aux';
      const why = { spi: 'SPI2 的固定信号脚', vcom: 'CDC 虚拟串口脚', no: '实测当不了辅助脚' }[role] || '不可用';
      return `<td class="p-pin">${pin}</td>` +
             `<td class="p-name ${cls}"><span class="p-mark">${M[role] || '·'}</span>${name}` +
             (note ? `<span class="p-note">${note}</span>` : '') +
             (now ? `<span class="p-sel${stale ? ' is-bad' : ''}">&lt;&lt; ${now}${stale ? ` ⚠ 这根是${why}，接上去也不动` : ''}</span>` : '') +
             (dft ? `<span class="p-sel is-dflt">&lt;&lt; ${dft}（默认）</span>` : '') +
             '</td>';
    };
    const rows = [];
    for (let i = 0; i < 20; i++){
      rows.push('<tr>' + cell(T[i * 2]) + cell(T[i * 2 + 1]) + '</tr>');
    }
    $('sp-pinmap-body').innerHTML = rows.join('');
    $('sp-pinmap-legend').textContent =
      '★ 桥的信号（SPI2）　● CDC 虚拟串口（UART2）　○ 可当辅助脚　⛔ 不可用　· 电源/地/空脚　' +
      '<< 实心＝当前配置　<< 虚线（默认）＝还没配，按默认脚位先标给你接线';
    const show = (v, d) => v ? (P.PAD_NAME[v] || ('pad' + v))
                             : d ? (P.PAD_NAME[d] || ('pad' + d)) + '（默认）' : '不用';
    $('sp-pinmap-foot').textContent =
      '辅助脚：DC=' + show(c.padDc, P.AUX_DEFAULT.DC) +
      '　RST=' + show(c.padRst, P.AUX_DEFAULT.RST) +
      '　CS 辅助=' + show(c.padCsAux, P.AUX_DEFAULT.CS_AUX) +
      '　BL=' + show(c.padBl, P.AUX_DEFAULT.BL) +
      '　TE=' + show(c.padTe, P.AUX_DEFAULT.TE) +
      '　｜　接线：CS←J3[26] SCLK←J3[13] D0←J3[28] D1←J3[27] D2←J3[10] D3←J3[8]，' +
      'VCOM ← J3[5](TX,PB08) / J3[3](RX,PB09)';
    $('sp-pinmap-sub').textContent =
      '（<< 实心 = 当前配置；<< 虚线（默认）= 还没配，按默认脚位标出来给你接线）';

    /**
     * 图上**没出现**的线要交代清楚（用户 2026-09-30 问过"图中缺一个DC脚"）：
     *   ① 本来就没默认脚、也没配（如 CS_AUX / TE）—— 说清它是干什么的、要不要接；
     *   ② 有默认脚，但那根脚**已经被别的线配走**了 —— 必须明说，否则照着脚注接就接错了。
     */
    const WHY = {
      CS_AUX: '第二片选，只挂一片屏时不用',
      TE: '面板撕裂信号（输入），不接也能刷图',
    };
    const miss = [];
    for (const [n, v, d] of LINES){
      if (v) continue;                                        // 配了 → 图上实心
      if (d && !LINES.some(([, v2]) => v2 === d)) continue;   // 有默认脚、且没被别的线配走 → 图上虚线
      miss.push(n + '（' + (d ? `默认脚 ${P.PAD_NAME[d] || ('pad' + d)} 已被别的线占用` : (WHY[n] || '本档位用不到')) + '）');
    }
    const missEl = $('sp-pinmap-miss');
    if (missEl) missEl.textContent = miss.length ? '图上没有出现的线：' + miss.join('；') : '';
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

  // ==================================================================== 通用命令表

  /**
   * 建 10 行命令表。每行的输入框用 `data-f` 标记字段（不给几十个元素起 id 了），
   * 读的时候按行遍历 —— 行的顺序就是发送顺序。
   */
  buildCmdRows(n){
    const body = $('sp-cmd-body');
    const cell = f => `<td><input data-f="${f}" class="cell"></td>`;
    body.innerHTML = Array.from({ length: n }, (_, i) => `<tr data-row="${i + 1}">
      <td class="idx">${i + 1}</td>
      ${cell('cmd')}${cell('lines')}${cell('addrLen')}${cell('addr')}${cell('dummy')}${cell('rx')}
      <td><input data-f="tx" class="cell txcell" placeholder="如 AA BB" title="这条命令要发出去的数据（十六进制）。留空 = 只发 cmd / 地址相位"></td>
      <td class="res" data-f="res"></td></tr>`).join('');
    // 线数是 1/2/4 三选一，用下拉比手输靠谱
    for (const tr of body.querySelectorAll('tr')){
      const inp = tr.querySelector('[data-f="lines"]');
      const sel = document.createElement('select');
      sel.dataset.f = 'lines'; sel.className = 'cell';
      for (const v of [1, 2, 4]) sel.appendChild(new Option(String(v), String(v)));
      inp.replaceWith(sel);
    }
    this.cmdClearResults();
  }

  /** 读一行 → XFER 帧；空行（所有字段都空）返回 null */
  readCmdRow(tr){
    const get = f => tr.querySelector(`[data-f="${f}"]`)?.value ?? '';
    const raw = ['cmd', 'addr', 'dummy', 'rx', 'tx'].map(get).join('').trim();
    if (!raw) return null;
    const tx = parseHexBytes(get('tx'));
    const rxLen = Math.max(0, Math.min(504, +get('rx') || 0));
    const t = {
      cmd: parseHexByte(get('cmd'), 0),
      tcfg: 0, addrLen: Math.max(0, Math.min(4, +get('addrLen') || 0)),
      dummy: Math.max(0, Math.min(4, +get('dummy') || 0)),
      addr: Number(get('addr')) >>> 0, tx, rxLen,
      lines: +get('lines') || 1,
    };
    if (tx.length > P.XFER_TX_MAX) throw new Error(`第 ${tr.dataset.row} 行：tx 有 ${tx.length} B，超过单帧上限 ${P.XFER_TX_MAX} B`);
    if (tx.length && rxLen && tx.length !== rxLen) throw new Error(`第 ${tr.dataset.row} 行：全双工要求收发等长（tx=${tx.length} rx=${rxLen}）`);
    return t;
  }

  /** 表格 → items（含跨行 CS_HOLD 与速率路径）*/
  cmdItems(){
    const rows = [...$('sp-cmd-body').querySelectorAll('tr')];
    const holdAll = $('sp-cmd-cshold').checked;
    const path = $('sp-cmd-path').value;
    const out = [];
    for (const tr of rows){
      let t;
      try { t = this.readCmdRow(tr); }
      catch (e){ this.session.log('e', '通用命令表：' + e.message, this.tag); return null; }
      if (!t) continue;
      let tcfg = P.linesToTcfg(t.lines) | P.TC.CMD_EN;   // 表里第一列就是命令字节 → 总是发 cmd 相位
      if (t.addrLen > 0) tcfg |= P.TC.ADDR_EN;
      /**
       * 每行都带 RSP：结果列要能逐行显示 OK / 错误码。读数据本来就必须带（固件规定），
       * 写帧多花一个 8 B 应答，换来"哪一行出错"能直接看见 —— 值。
       */
      let flags = P.F.RSP;
      if (path === 'poll') flags |= P.F.NO_DMA;
      else if (path === 'dma') flags |= P.F.FORCE_DMA;
      out.push({
        type: P.T.XFER, flags,
        payload: P.xferPayload({ cmd: t.cmd, tcfg, addrLen: t.addrLen, dummy: t.dummy, addr: t.addr, tx: t.tx, rxLen: t.rxLen }),
        label: `行 ${tr.dataset.row}`, tr, rxLen: t.rxLen, txLen: t.tx.length,
      });
    }
    if (holdAll && out.length){
      // 整段一个 CS 窗口：前面都保持，末条释放
      out.forEach((x, i) => { x.flags |= (i === out.length - 1) ? P.F.CS_OFF : P.F.CS_HOLD; });
    }
    return out;
  }

  cmdClearResults(){
    for (const td of $('sp-cmd-body').querySelectorAll('td.res')){ td.textContent = ''; td.className = 'res'; }
  }

  async cmdSendAll(){
    const s = this.session;
    if (s.busy) return;
    if (!s.dataReady){ s.log('e', '先「连接数据端点」（或勾「用假探针」）', this.tag); return; }
    const items = this.cmdItems();
    if (!items) return;
    if (!items.length){ s.log('w', '通用命令表是空的（每行第一列填 cmd）', this.tag); return; }
    this.cmdClearResults();
    if (!s.enabled) s.log('w', '桥还没使能 —— 帧会被判 SB_E_DISABLED', this.tag);
    s.setBusy(true); this.refreshButtons();
    const t0 = performance.now();
    try {
      const r = await s.sendFrames(items.map(({ tr, rxLen, txLen, ...it }) => it), { tag: this.tag });
      let i = 0;
      for (const it of items){
        const res = r.rsps[i++];
        const td = it.tr.querySelector('td.res');
        if (!res) { td.textContent = '无应答'; td.className = 'res bad'; continue; }
        if (res.status !== P.ST.OK){ td.textContent = `${res.status}/${P.ST_TEXT[res.status] || '?'}`; td.className = 'res bad'; continue; }
        const d = res.data?.length ? ` · ${[...res.data.subarray(0, 4)].map(x => x.toString(16).padStart(2, '0')).join(' ')}${res.data.length > 4 ? '…' : ''}` : '';
        td.textContent = `OK${d}`;
        td.className = 'res ok';
      }
      const bad = r.rsps.filter(x => x && x.status !== P.ST.OK).length;
      const expected = items.filter(x => x.flags & P.F.RSP).length;
      const missing = Math.max(0, expected - r.rsps.filter(Boolean).length);
      const dt = performance.now() - t0;
      s.log(bad || missing ? 'w' : 'g', `通用命令：发了 ${items.length} 条（${expected} 条带应答）· ${r.packs} 包 · ${dt.toFixed(0)} ms` +
        (bad ? ` · ${bad} 条非 OK` : '') + (missing ? ` · ${missing} 条没等到应答` : ''), this.tag);
    } catch (e){
      s.log('e', '通用命令发送失败：' + (e?.message || e), this.tag);
    } finally {
      s.setBusy(false); this.refreshButtons();
      await s.pollStatus(true);
    }
  }

  async simpleFrame(type, payload, label){
    try { return await this.session.sendFrames([{ type, payload, flags: P.F.RSP, label }], { tag: this.tag }); }
    catch (e){ this.session.log('e', `${label} 失败：` + (e?.message || e), this.tag); return null; }
  }

  /**
   * 辅助脚写。`level` 是**逻辑**电平（1 = 有效）：极性的取反在固件里做
   * （`sb_pad_write(pad, active_low ? !lvl : lvl)`），页面只管语义。
   */
  async sendGpio(line, level, label){
    await this.simpleFrame(P.T.GPIO, P.gpioPayload(line, level), label);
  }

  /** RST 脉冲（拉低 low ms + 等 post ms，固件侧非阻塞、有序）*/
  async sendRstPulse(){
    const low = Math.max(0, +$('sp-pin-rst-low').value || 0);
    const post = Math.max(0, +$('sp-pin-rst-post').value || 0);
    await this.simpleFrame(P.T.RESET, P.resetPayload(low, post), `RST 脉冲 ${low}+${post}ms`);
  }

  // ==================================================================== 手写多帧（DSL）

  dslLoadSample(){
    const name = $('sp-dsl-preset').value;
    const s = D.DSL_SAMPLES.find(x => x.name === name);
    if (s) $('sp-dsl-text').value = s.text;
  }

  /** 读 .c/.h/.txt/.json 进文本框；JSON 若是本站导出的形状就转回可读文本 */
  async dslLoadFile(file){
    if (!file) return;
    const s = this.session;
    try {
      const text = await file.text();
      const asDsl = file.name.toLowerCase().endsWith('.json') ? D.jsonToDsl(text) : null;
      $('sp-dsl-text').value = asDsl ?? text;
      s.log('i', `已读入 ${file.name}（${fmtBytes(text.length)}）` + (asDsl ? ' · 识别为本页导出的 JSON，已转成可读文本' : ''), this.tag);
      this.dslRun(false);
    } catch (e){
      s.log('e', '读文件失败：' + (e?.message || e), this.tag);
    } finally {
      $('sp-dsl-file-input').value = '';   // 同一个文件再选一次也要能触发
    }
  }

  /** 导出当前文本框解析出来的帧（解析不过就不导，免得导出半截东西）*/
  dslExport(kind){
    const s = this.session;
    const r = this.dslParse();
    if (r.errors.length){ s.log('e', `有 ${r.errors.length} 处语法错，先改好再导出`, this.tag); return; }
    if (!r.items.length){ s.log('w', '没有可导出的帧', this.tag); return; }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const out = kind === 'c' ? { name: `spi-frames-${stamp}.c`, text: D.itemsToC(r.items) }
      : kind === 'json' ? { name: `spi-frames-${stamp}.json`, text: D.itemsToJson(r.items) }
      : { name: `spi-frames-${stamp}.txt`, text: D.itemsToDsl(r.items) };
    try {
      const url = URL.createObjectURL(new Blob([out.text], { type: 'text/plain' }));
      const a = document.createElement('a');
      a.href = url; a.download = out.name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      s.log('g', `已导出 ${out.name}（${r.items.length} 条命令）`, this.tag);
    } catch (e){ s.log('e', '导出失败：' + (e?.message || e), this.tag); }
  }

  /** 解析 textarea → {items,errors,...}；把错误/摘要渲染出来。errors 非空时**不发**。*/
  dslParse(){
    const r = D.parseFrames($('sp-dsl-text').value);
    const body = $('sp-dsl-err');
    body.innerHTML = r.errors.map(e => `<tr class="bad"><td>${e.line}</td><td>${esc(e.text)}</td><td>${esc(e.msg)}</td></tr>`).join('');
    $('sp-dsl-errwrap').style.display = r.errors.length ? '' : 'none';
    for (const w of r.warns) this.session.log('w', 'DSL：' + w, this.tag);
    return r;
  }

  async dslRun(send){
    const s = this.session;
    const r = this.dslParse();
    if (r.errors.length){
      setStatus($('sp-dsl-sum'), `${r.errors.length} 处语法错（见下表），没有发送`, 'err');
      s.log('e', `手写多帧：${r.errors.length} 处语法错，第 ${r.errors[0].line} 行起 —— ${r.errors[0].msg}`, this.tag);
      return;
    }
    if (!r.items.length){ setStatus($('sp-dsl-sum'), '没有可发的帧', 'warn'); return; }
    const packs = P.packFrames(r.items.map(i => P.frame(i.type, i.payload, { flags: i.flags }))).length;
    const sum = `${r.items.length} 条帧 · payload ${r.stats.bytes} B · ${packs} 个 USB 包`;
    if (!send){ setStatus($('sp-dsl-sum'), `解析通过：${sum}`, 'ok'); s.log('g', `手写多帧解析通过：${sum}`, this.tag); return; }
    if (s.busy) return;
    if (!s.enabled) s.log('w', '桥还没使能 —— 帧会被判 SB_E_DISABLED', this.tag);
    s.setBusy(true); this.refreshButtons();
    const t0 = performance.now();
    try {
      const res = await s.sendFrames(r.items, { tag: this.tag });
      const expected = r.items.filter(i => i.flags & P.F.RSP).length;
      const got = res.rsps.filter(Boolean).length;
      const bad = res.rsps.filter(x => x && x.status !== P.ST.OK).length;
      const timeouts = Math.max(0, expected - got);
      const dt = performance.now() - t0;
      const text = `发完 ${res.sent}/${res.packs} 包 · ${r.items.length} 条帧（${expected} 条带应答）· ${dt.toFixed(0)} ms` +
        (bad ? ` · ${bad} 条非 OK` : '') + (timeouts ? ` · ${timeouts} 条没等到应答` : '');
      s.log(bad || timeouts ? 'w' : 'g', '手写多帧：' + text, this.tag);
      setStatus($('sp-dsl-sum'), text, bad || timeouts ? 'warn' : 'ok');
    } catch (e){
      s.log('e', '手写多帧发送失败：' + (e?.message || e), this.tag);
      setStatus($('sp-dsl-sum'), '发送失败：' + (e?.message || e), 'err');
    } finally {
      s.setBusy(false); this.refreshButtons();
      await s.pollStatus(true);
    }
  }

  // ==================================================================== SPI / NOR Flash

  flMode(){ return FL.READ_MODES.find(m => m.v === (+$('sp-fl-mode').value || 0)) || FL.READ_MODES[0]; }
  flAddr(){ return Number($('sp-fl-addr').value) >>> 0; }
  flDummy(){ return Math.max(0, Math.min(4, +$('sp-fl-dummy').value || 0)); }

  flOut(text, kind = ''){
    const el = $('sp-fl-out');
    el.className = 'log' + (kind ? ' ' + kind : '');
    el.textContent = text;
  }

  async flReadId(){
    const s = this.session;
    await this.wrap(async () => {
      const r = await s.sendFrames(FL.rdidItems(), { tag: this.tag });
      const d = r.rsps[0]?.data;
      if (!d || d.length < 3) throw new Error('没读到 3 字节 ID（接线 / 使能 / CS 策略先确认）');
      const j = FL.parseJedec(d);
      s.log('g', `Flash JEDEC ID = ${j.hex} → ${j.text}`, this.tag);
      this.flOut(`ID  ${j.hex}\n${j.text}`, 'ok');
    });
  }

  /**
   * 读 SFDP：先按当前 dummy 读 8 B 头，签名不对就**自动试别的 dummy**（0~4）——
   * 协议里 dummy 的单位在这块板子上没实测标定过，与其猜不如让它自己找出来。
   */
  async flReadSfdp(){
    const s = this.session;
    await this.wrap(async () => {
      const tried = [];
      let dummy = this.flDummy(), head = null;
      for (const d of [dummy, 0, 1, 2, 3, 4]){
        if (tried.includes(d)) continue;
        tried.push(d);
        const r = await s.sendFrames(FL.sfdpHeadItems(d), { tag: this.tag, quiet: tried.length > 1 });
        const bytes = r.rsps[0]?.data;
        const p = bytes ? FL.parseSfdp(bytes) : null;
        if (p?.sigOk){ head = p; dummy = d; break; }
        if (tried.length === 1) s.log('w', `SFDP 签名不是 "SFDP"（dummy=${d}）：${bytes ? hexDump(bytes) : '没读到数据'} —— 换 dummy 再试`, this.tag);
      }
      if (!head) throw new Error('dummy 0~4 都试过，SFDP 签名仍不对（接线 / 器件 / 供电先确认）');
      if (dummy !== this.flDummy()){
        $('sp-fl-dummy').value = String(dummy);
        s.log('g', `SFDP 用 dummy=${dummy} 读出签名 —— 已把面板上的 dummy 改成 ${dummy}`, this.tag);
      }
      const rp = await s.sendFrames(FL.sfdpParamItems(head.nph, dummy), { tag: this.tag });
      const sf = FL.parseSfdp(rp.rsps[0]?.data);
      const lines = [`SFDP  ${sf.revName}（major ${sf.major}）· ${sf.nph} 个参数表头`, ''];
      for (const h of sf.headers || []){
        lines.push(`  表 ${h.index}  id=0x${h.id.toString(16).padStart(4, '0')}  ${h.name}  rev ${h.major}.${h.minor}  ${h.lengthDwords} DWORD  指针 0x${h.ptr.toString(16)}`);
      }
      s.log('g', `Flash SFDP：${sf.text}`, this.tag);
      // BFPT 那一张顺便读回来（最多 64 B），原始 DWORD 直接摊开
      const bfpt = (sf.headers || []).find(h => h.idLsb === 0 && h.idMsb === 0);
      if (bfpt){
        const rt = await s.sendFrames(FL.sfdpTableItems(bfpt.ptr, bfpt.lengthDwords, dummy), { tag: this.tag });
        const bytes = rt.rsps[0]?.data;
        if (bytes){
          lines.push('', 'JEDEC BFPT 原始 DWORD（解读按 JESD216，先看原始值）');
          lines.push(...FL.dumpDwords(bytes));
        }
      }
      this.flOut(lines.join('\n'), 'ok');
    });
  }

  async flReadStatus(){
    const s = this.session;
    await this.wrap(async () => {
      const r = await s.sendFrames([...FL.rdsr1Items(), ...FL.rdsr2Items()], { tag: this.tag });
      const sr1 = r.rsps[0]?.data ? FL.parseStatus1(r.rsps[0].data) : null;
      const sr2 = r.rsps[1]?.data ? FL.parseStatus2(r.rsps[1].data) : null;
      if (!sr1) throw new Error('没读到 SR1');
      s.log('g', `Flash SR1 = ${sr1.text}` + (sr2 ? ` · SR2 = ${sr2.text}` : ''), this.tag);
      this.flOut(`SR1  ${sr1.text}\nSR2  ${sr2 ? sr2.text : '（没读到）'}`, sr1.busy ? 'warn' : 'ok');
    });
  }

  flWiring(){
    this.flOut([
      '外接 SPI NOR 接线（探针 J3 排针，2026-09-30 起桥在 SPI2）：',
      '  CS   ← J3[26]  PB10（CS 策略 0 = 固件自动拉/放）',
      '  SCLK ← J3[13]  PB11',
      '  IO0  ← J3[28]  PB13（1 线时的 MOSI）',
      '  IO1  ← J3[27]  PB12（1 线时的 MISO）',
      '  IO2  ← J3[10]  PB14（四线才接）',
      '  IO3  ← J3[8]   PB15（四线才接）',
      '  VCC / GND 按模块电压；WP# 与 HOLD# 上拉到 VCC',
      '',
      '四线读还要器件侧 QE=1（多数片子是 SR2 的 bit1）：先「读状态」看一眼。',
    ].join('\n'));
  }

  /** 读一段：按当前模式/地址/长度拆帧（大块走连续读）*/
  async flRead(len, opts = {}){
    const s = this.session;
    const mode = opts.mode ?? this.flMode();
    const addr = opts.addr ?? this.flAddr();
    const n = len ?? Math.max(1, Math.min(1 << 16, +$('sp-fl-len').value || 256));
    const items = FL.readItems(addr, n, { mode: mode.v });
    const r = await s.sendFrames(items, { tag: this.tag, quiet: !!opts.quiet, onProgress: opts.onProgress });
    const out = new Uint8Array(n);
    let off = 0, bad = 0;
    for (const x of r.rsps){
      if (!x || x.status !== P.ST.OK){ bad++; continue; }
      const take = Math.min(x.data.length, n - off);
      out.set(x.data.subarray(0, take), off); off += take;
    }
    this.lastRead = out.subarray(0, off);
    return { bytes: this.lastRead, off, bad, items: items.length };
  }

  async flReadUI(){
    const s = this.session;
    await this.wrap(async () => {
      const t0 = performance.now();
      const r = await this.flRead();
      const dt = performance.now() - t0;
      if (r.bad) throw new Error(`${r.bad} 条帧不是 OK`);
      const mode = this.flMode();
      s.log('g', `Flash 读 ${r.off} B @0x${this.flAddr().toString(16)} · ${mode.name.split(' · ')[0]} · ${dt.toFixed(1)} ms · ${rate(r.off, dt)}`, this.tag);
      this.flOut(`地址 0x${this.flAddr().toString(16)}  长度 ${r.off} B  ${dt.toFixed(1)} ms  ${rate(r.off, dt)}\n` +
        hexDump(r.bytes.subarray(0, 96)) + (r.bytes.length > 96 ? '\n…' : ''), 'ok');
    });
  }

  /**
   * 连续读测速：读 N KB，报 MB/s 与"理论值占比"。
   * 理论值 = 实际 SCLK ÷ 8 × 线数（四线时数据相位一拍 4 bit）—— 拿它当分母才知道差在哪。
   */
  async flBench(){
    const s = this.session;
    const kb = Math.max(1, Math.min(4096, +$('sp-fl-benchkb').value || 64));
    const n = kb * 1024;
    if (s.busy) return;
    s.setBusy(true); this.refreshButtons();
    const mode = this.flMode();
    const addr = this.flAddr();
    try {
      s.log('i', `读测速：${kb} KB @0x${addr.toString(16)} · ${mode.name}`, this.tag);
      const t0 = performance.now();
      const r = await this.flRead(n, { onProgress: (done, total) => {
        if (done === total || done % 64 === 0) this.flOut(`读测速 ${done}/${total} 包…`);
      } });
      const dt = performance.now() - t0;
      if (r.bad) throw new Error(`${r.bad} 条帧不是 OK（读失败了，先「读 ID / SFDP」确认链路）`);
      const sclk = s.counters?.actualSclkHz || s.cfg?.sclkHz || 0;
      const theo = sclk ? sclk / 8 * (mode.lines >= 4 ? 4 : mode.lines) : 0;   // B/s
      const eff = theo ? (r.off / (dt / 1000)) / theo * 100 : 0;
      const line = `${kb} KB 用时 ${dt.toFixed(1)} ms → ${rate(r.off, dt)}` +
        (theo ? `（实际 SCLK ${P.sclkLabel(sclk)} 理论上限 ${(theo / 1048576).toFixed(2)} MB/s，实测占 ${eff.toFixed(0)}%）` : '');
      s.log(eff && eff < 45 ? 'w' : 'g', '读测速：' + line, this.tag);
      if (eff && eff < 45) s.log('w', '占理论值不到一半：检查 ①CS_HOLD 连续读有没有生效 ②每帧 492 B 有没有被拆小 ③线数/模式是否与器件匹配', this.tag);
      this.flOut(`读测速  ${mode.name}\n${line}`, eff && eff < 45 ? 'warn' : 'ok');
    } catch (e){
      s.log('e', '读测速失败：' + (e?.message || e), this.tag);
      this.flOut('读测速失败：' + (e?.message || e), 'err');
    } finally {
      s.setBusy(false); this.refreshButtons();
      await s.pollStatus(true);
    }
  }

  /** 等器件 BUSY 清掉（短等待走 pace.js，页面不可见时不会被浏览器钳到 1 s）*/
  async flWaitReady(timeoutMs = 4000){
    const t0 = performance.now();
    let last = null;
    while (performance.now() - t0 < timeoutMs){
      const r = await this.session.sendFrames(FL.rdsr1Items(), { tag: this.tag, quiet: true });
      last = r.rsps[0]?.data ? FL.parseStatus1(r.rsps[0].data) : null;
      if (last && !last.busy) return { ok: true, ms: performance.now() - t0, sr: last };
      await waitMs(2);
    }
    return { ok: false, ms: performance.now() - t0, sr: last };
  }

  flFillPattern(){
    const n = Math.max(1, Math.min(4096, +$('sp-fl-len').value || 256));
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) b[i] = i & 0xff;
    $('sp-fl-data').value = [...b].map(x => x.toString(16).padStart(2, '0')).join(' ');
  }

  async flErase(){
    const s = this.session;
    if (!this.flArmed()) return;
    const mode = FL.ERASE_MODES.find(m => m.v === (+$('sp-fl-erase-mode').value || 0)) || FL.ERASE_MODES[0];
    const addr = this.flAddr();
    if (mode.size === 0 && !confirm(`整片擦除会把整颗 flash 清成 0xFF，确定？`)) return;
    if (s.busy) return;
    s.setBusy(true); this.refreshButtons();
    try {
      s.log('i', `擦除：${mode.name} @0x${addr.toString(16)}`, this.tag);
      const t0 = performance.now();
      await s.sendFrames(FL.eraseItems(addr, { opcode: mode.v }), { tag: this.tag });
      const w = await this.flWaitReady(12000);
      const dt = performance.now() - t0;
      if (!w.ok) throw new Error('等 BUSY 超时（器件一直忙？）');
      s.log('g', `擦除完成：${mode.size ? FL.fmtSize(mode.size) : '整片'} @0x${addr.toString(16)} · ${dt.toFixed(0)} ms`, this.tag);
      this.flOut(`擦除完成  ${mode.name}\n地址 0x${addr.toString(16)}（扇区对齐 0x${FL.sectorOf(addr).toString(16)}）  用时 ${dt.toFixed(0)} ms`, 'ok');
    } catch (e){
      s.log('e', '擦除失败：' + (e?.message || e), this.tag);
      this.flOut('擦除失败：' + (e?.message || e), 'err');
    } finally {
      s.setBusy(false); this.refreshButtons();
      await s.pollStatus(true);
    }
  }

  flArmed(){
    if (!$('sp-fl-armed').checked){
      this.session.log('w', '先勾上「我确认要擦写这颗 flash」', this.tag);
      return false;
    }
    return true;
  }

  flWriteData(){
    let bytes = parseHexBytes($('sp-fl-data').value);
    if (!bytes.length){
      const n = 256;
      bytes = new Uint8Array(n);
      for (let i = 0; i < n; i++) bytes[i] = i & 0xff;
      this.session.log('i', '写数据留空 → 用 256 B 递增图案', this.tag);
    }
    if (bytes.length > 4096) throw new Error('一次最多写 4 KB（收到 ' + fmtBytes(bytes.length) + '）');
    return bytes;
  }

  /**
   * 按页写 + 回读校验。页间用有序 DELAY 等 tPP（见 flash.js 的说明），
   * 写完再等一次 BUSY、然后把同一段读回来逐字节比 —— **写完必须验**，不然"成功"是假的。
   */
  async flWrite(){
    const s = this.session;
    if (!this.flArmed() || s.busy) return;
    let data;
    try { data = this.flWriteData(); }
    catch (e){ s.log('e', '写数据有问题：' + e.message, this.tag); return; }
    const addr = this.flAddr();
    const tpp = Math.max(0, Math.min(100, +$('sp-fl-tpp').value || 0));
    s.setBusy(true); this.refreshButtons();
    try {
      const pages = FL.programPages(addr, data).length;
      s.log('i', `编程 ${data.length} B @0x${addr.toString(16)}（${pages} 页，页间等 ${tpp} ms）`, this.tag);
      const t0 = performance.now();
      const r = await s.sendFrames(FL.programItems(addr, data, { pageDelayMs: tpp }), { tag: this.tag, quiet: true });
      const bad = r.rsps.filter(x => x && x.status !== P.ST.OK).length;
      const noRsp = r.rsps.filter(x => !x).length;
      const w = await this.flWaitReady(8000);
      const dt = performance.now() - t0;
      if (bad || noRsp) throw new Error(`${bad} 条非 OK / ${noRsp} 条没应答`);
      const vr = await this.flRead(data.length, { quiet: true });
      const same = bytesEqual(vr.bytes, data);
      s.log(same ? 'g' : 'e', `写 + 校验：${data.length} B · ${dt.toFixed(0)} ms · ${rate(data.length, dt)} · ` +
        (same ? '回读一致 ✔' : `回读**不一致**（前 16 B：${hexDump(vr.bytes.subarray(0, 16))}）`), this.tag);
      if (!same) s.log('w', `不一致的常见原因：页间等 tPP 太短（现在 ${tpp} ms，试着加大）、没先擦除（NOR 只能 1→0）、地址写到了别处`, this.tag);
      this.flOut(`写 + 校验  ${data.length} B @0x${addr.toString(16)}\n${pages} 页 · ${dt.toFixed(0)} ms · ${rate(data.length, dt)}\n回读${same ? '一致 ✔' : '不一致 ✘'}` +
        (same ? '' : `\n写：${hexDump(data.subarray(0, 24))}\n读：${hexDump(vr.bytes.subarray(0, 24))}`), same ? 'ok' : 'err');
    } catch (e){
      s.log('e', '编程失败：' + (e?.message || e), this.tag);
      this.flOut('编程失败：' + (e?.message || e), 'err');
    } finally {
      s.setBusy(false); this.refreshButtons();
      await s.pollStatus(true);
    }
  }

  /** 写测速：先擦掉目标区，再按页写满并回读校验，报 MB/s（擦除时间分开算）*/
  async flWriteBench(){
    const s = this.session;
    if (!this.flArmed() || s.busy) return;
    const kb = Math.max(1, Math.min(64, +$('sp-fl-benchkb').value || 16));
    const n = kb * 1024;
    const addr = this.flAddr();
    const tpp = Math.max(0, Math.min(100, +$('sp-fl-tpp').value || 0));
    if (confirm(`写测速会把 0x${addr.toString(16)} 起的 ${kb} KB 先擦掉再写入（破坏原有数据），继续？`) === false) return;
    s.setBusy(true); this.refreshButtons();
    try {
      const data = new Uint8Array(n);
      for (let i = 0; i < n; i++) data[i] = (i * 31 + 7) & 0xff;
      s.log('i', `写测速：先擦 0x${addr.toString(16)} 起 ${kb} KB`, this.tag);
      const tErase0 = performance.now();
      await s.sendFrames(FL.eraseItems(addr, { opcode: FL.OP.SE }), { tag: this.tag, quiet: true });
      for (let off = 0; off < n; off += FL.SECTOR_SIZE){
        await s.sendFrames(FL.eraseItems(addr + off, { opcode: FL.OP.SE }), { tag: this.tag, quiet: true });
      }
      const w0 = await this.flWaitReady(20000);
      const tErase = performance.now() - tErase0;
      if (!w0.ok) throw new Error('擦除等 BUSY 超时');
      const t0 = performance.now();
      const r = await s.sendFrames(FL.programItems(addr, data, { pageDelayMs: tpp }), { tag: this.tag, quiet: true });
      const bad = r.rsps.filter(x => x && x.status !== P.ST.OK).length;
      await this.flWaitReady(20000);
      const dt = performance.now() - t0;
      if (bad) throw new Error(`${bad} 条非 OK`);
      const vr = await this.flRead(n, { quiet: true });
      const same = bytesEqual(vr.bytes, data);
      const line = `${kb} KB 写入 ${dt.toFixed(0)} ms → ${rate(n, dt)}（擦除另用 ${tErase.toFixed(0)} ms）· 回读${same ? '一致 ✔' : '不一致 ✘'}`;
      s.log(same ? 'g' : 'e', '写测速：' + line, this.tag);
      if (!same) s.log('w', `页间等 tPP=${tpp} ms 可能太短，加大再试`, this.tag);
      this.flOut('写测速  ' + line, same ? 'ok' : 'err');
    } catch (e){
      s.log('e', '写测速失败：' + (e?.message || e), this.tag);
      this.flOut('写测速失败：' + (e?.message || e), 'err');
    } finally {
      s.setBusy(false); this.refreshButtons();
      await s.pollStatus(true);
    }
  }

  // ==================================================================== 回环自检

  /**
   * MOSI↔MISO 跳线回环扫描（J3[28]-J3[27]，SPI2）：
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
      (s.usingMock ? '（假探针：读回 = 发出去的字节）' : '（真机需要 J3[28]↔J3[27] 跳线）'), this.tag);
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
