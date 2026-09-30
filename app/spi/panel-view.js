/**
 * 「SPI/QSPI 屏」页（`#panel`）—— 把屏点亮那一页：**面板初始化代码** + **图片/图案刷屏**。
 *
 * 与「SPI/QSPI 桥」页（`#spi`）共用同一个 `SpiSession`（一次连接，两页共用）：
 * 基础配置（SCLK / CS 策略 / 通用辅助脚）归桥页；这里只做屏相关的事，并且能按屏型号**一键套用推荐值**。
 *
 * 三块内容：
 *   1. **面板初始化**：一个大文本框 —— 把 C 数组贴进来（或载入内置示例 / 文件）→ 解析成步骤表 →
 *      重放全部 / 单发 / 从此重放。解析器在 `panel-code.js`（纯函数，Node 自测 71 项）。
 *   2. **图片 / 图案**：内置图案现画现发；BMP 自己解析、PNG/JPEG 交给浏览器解码 →
 *      摆放/对齐 → RGB565 → 492 B 切片 → 开窗 + 像素帧（`image.js`，同样是纯函数）。
 *   3. 复位 / 显示、面板档、按屏套用推荐值。
 *
 * 预览里显示的是**量化后的样子**（走一遍 565 往返 + R/B 交换 + 电平），所以"预览 == 发出去的"。
 */
import { $, setStatus } from '../ui/dom.js';
import * as P from './protocol.js';
import * as C from './panel-code.js';
import * as I from './image.js';
import { BitPopover } from './bit-editor.js';
import { PanelAnim } from './anim.js';
import { fmtBytes } from './session.js';

/** 两块目标屏的推荐值。`short` 是侧栏下拉用的短名（长名字会把 300px 宽的侧栏撑爆 → 字被裁）*/
export const PANEL_PRESETS = {
  axs15352: {
    label: '天马 2P01 / AXS15352（240×296 · 4 线 SPI + DC）',
    short: 'AXS15352（240×296）',
    profile: { profile: 1, defLines: 1, dcActiveHigh: true, csHoldInStep: true, qspiWrOpcode: 0x02, qspiColorOpcode: 0x32, qspiAddrBytes: 3 },
    cfg: { sclkHz: 40000000, csPolicy: 0, padDc: 1 /*PB11*/, padRst: 2 /*PB12*/, padBl: 3 /*PB13*/, padActiveLow: 0x06 },
    geom: 'axs15352',
    note: '档 1：同一 CS 窗口内「命令 → 翻 DC → 参数」',
  },
  st77916: {
    label: 'ST77916（圆屏 360×360 · QSPI 四线）',
    short: 'ST77916（360×360）',
    profile: { profile: 2, defLines: 1, dcActiveHigh: true, csHoldInStep: true, qspiWrOpcode: 0x02, qspiColorOpcode: 0x32, qspiAddrBytes: 3 },
    cfg: { sclkHz: 40000000, csPolicy: 0, padDc: 0, padRst: 2 /*PB12*/, padBl: 3 /*PB13*/, padActiveLow: 0x06 },
    geom: 'st77916',
    note: '档 2：0x02 + 24 bit 地址(=命令字<<16) + 参数；像素用 0x32 + 四线',
  },
};

const GEOMETRY_SRC = { axs15352: 'axs15352', st77916: 'st77916' };

/**
 * 厂家初始化表里**没有**、但缺了就全黑的两条（AXS15352 真屏实测结论，见交接文档 §5）：
 *   `0x36` MADCTL = 0x00（RGB 顺序；0x08 = BGR）—— 与"RGB565 高字节在前"是**正确组合**；
 *   `0x3A` COLMOD = 0x55（RGB565/16bpp）。
 * 它们必须排在厂家序列**之前**。默认勾上"自动补"，但不动用户贴的文本（只在解析结果前面插两行）。
 */
export const REQUIRED_PREFIX = [
  { cmd: 0x36, data: Uint8Array.of(0x00), delayMs: 0, auto: true, name: 'MADCTL（RGB 顺序）' },
  { cmd: 0x3a, data: Uint8Array.of(0x55), delayMs: 0, auto: true, name: 'COLMOD（RGB565）' },
];

export class SpiPanelView {
  constructor(session){
    this.session = session;
    this.tag = 'panel';
    this.rows = [];            // 解析出来的面板步骤
    this.parsed = null;        // 最近一次解析结果（含 errors/warnings）
    this.playAbort = false;
    this.src = null;           // 当前图片/图案：{ w, h, rgba, name }
    this.patternKind = null;
    this.unsub = null;
    /** 解析表里的"字节 → 位"开关板（点字节弹出，改位即改那个字节） */
    this.bitpop = new BitPopover({ onEdit: (row, i, k, v) => this.onByteEdit(row, i, k, v) });
    this._sum = null;          // 摘要的原始文案（改过字节后要在后面补一句"已改 N 行"）
  }

  init(){
    const s = this.session;

    for (const [v, label] of Object.entries(P.PROFILE_SHORT || P.PROFILE_NAME)) $('pn-profile').appendChild(new Option(label, v));
    for (const [k, p] of Object.entries(PANEL_PRESETS)) $('pn-preset').appendChild(new Option(p.short || p.label, k));
    for (const [k, d] of Object.entries(C.PANEL_DATA)) $('pn-code-preset').appendChild(new Option(`${d.label} · ${d.expect.rows} 条`, k));
    for (const [k, g] of Object.entries(I.PANEL_GEOMETRY)) $('pn-geom').appendChild(new Option(`${k}（${g.w}×${g.h}）`, k));

    // 连接（与桥页同一个会话）
    $('pn-connect').addEventListener('click', () => s.connectHid(true));
    $('pn-reconnect').addEventListener('click', () => s.connectHid(false));
    $('pn-usb').addEventListener('click', () => s.connectUsb(null, { inFlight: +($('pn-inflight').value || 4) }));
    $('pn-mock').addEventListener('change', e => s.setMock(e.target.checked));

    // 档位 / 推荐值
    $('pn-prof-get').addEventListener('click', () => this.wrap(() => s.loadProfile({ tag: this.tag })));
    $('pn-prof-set').addEventListener('click', () => this.applyProfile());
    $('pn-preset').addEventListener('change', () => this.fillPresetNote());
    $('pn-preset-apply').addEventListener('click', () => this.applyPreset());

    // 面板初始化代码
    $('pn-code-load').addEventListener('click', () => this.loadPresetCode());
    $('pn-code-file').addEventListener('click', () => $('pn-code-file-input').click());
    $('pn-code-file-input').addEventListener('change', e => this.loadCodeFile(e.target.files[0]));
    $('pn-code-parse').addEventListener('click', () => this.parseCode());
    $('pn-code-prefix').addEventListener('change', () => this.parseCode());
    $('pn-code-play').addEventListener('click', () => this.playRows(0, (this.effectiveRows || this.rows).length - 1));
    $('pn-code-stop').addEventListener('click', () => { this.playAbort = true; });
    $('pn-code-clear').addEventListener('click', () => { $('pn-code-text').value = ''; this.rows = []; this.bitpop.close(); this.renderCodeTable([]); this.setCodeSummary('已清空'); });
    for (const [id, kind] of [['pn-code-c', 'c'], ['pn-code-json', 'json'], ['pn-code-text-out', 'text']]) $(id).addEventListener('click', () => this.exportRows(kind));
    $('pn-code-body').addEventListener('click', e => {
      // ① 点参数字节格子 → 开「位开关板」（命令字节那格只用来敲十六进制，与参考页一致）
      const cell = e.target.closest('input.bx');
      if (cell && !cell.classList.contains('cmd')){
        const i = +cell.dataset.i;
        this.bitpop.open({
          row: (this.effectiveRows || this.rows)[i],
          base: (this.baseRows || [])[i] || null,
          index: i, k: +cell.dataset.b, anchor: cell,
        });
        return;
      }
      // ② 行尾的「单发 / 从此重放 / 改回」
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const i = +btn.dataset.i, act = btn.dataset.act;
      if (act === 'one') this.playRows(i, i);
      else if (act === 'from') this.playRows(i, (this.effectiveRows || this.rows).length - 1);
      else if (act === 'revert') this.revertRow(i);
    });
    /**
     * 改字节：**手打十六进制**与位开关板走同一条路（都落到 `setRowByte`），
     * 所以"脏标记 / 改回 / 导出 / 重放"全都不用特殊照顾（参考页也是这么做的）。
     * `change` 而不是 `input`：输入框里敲到一半（"5"）不该立刻当 0x05 提交。
     */
    $('pn-code-body').addEventListener('change', e => {
      const cell = e.target.closest?.('input.bx');
      if (!cell) return;
      const i = +cell.dataset.i;
      const row = (this.effectiveRows || this.rows)[i];
      if (!row) return;
      const isCmd = cell.classList.contains('cmd');
      const k = isCmd ? 'cmd' : +cell.dataset.b;
      const t = String(cell.value).trim().replace(/^0x/i, '');
      if (!/^[0-9a-f]{1,2}$/i.test(t)){
        this.session.log('e', `第 ${i} 行：'${cell.value}' 不是一个字节（要 00~FF 的十六进制）`, this.tag);
        cell.classList.add('bad');
        setTimeout(() => cell.classList.remove('bad'), 1500);
        cell.value = hx(isCmd ? row.cmd : row.data[k]);      // 还原成模型里的值
        return;
      }
      const v = parseInt(t, 16);
      if (v !== (isCmd ? row.cmd : row.data[k])){
        C.setRowByte(row, k, v);
        this.onByteEdit(row, i, k, v);
      } else {
        cell.value = hx(v);                                   // 只是大小写/前导零不同：规范化显示
      }
    });
    this.bitpop.init();

    // 图片 / 图案
    this.buildPatternChips();
    $('pn-drop').addEventListener('click', () => $('pn-img-file').click());
    $('pn-img-file').addEventListener('change', e => this.pickImage(e.target.files[0]));
    for (const ev of ['dragenter', 'dragover']) $('pn-drop').addEventListener(ev, e => { e.preventDefault(); $('pn-drop').classList.add('hot'); });
    for (const ev of ['dragleave', 'drop']) $('pn-drop').addEventListener(ev, e => { e.preventDefault(); $('pn-drop').classList.remove('hot'); });
    $('pn-drop').addEventListener('drop', e => this.pickImage(e.dataTransfer.files[0]));
    for (const id of ['pn-fit', 'pn-x', 'pn-y', 'pn-geom', 'pn-swap', 'pn-byteorder', 'pn-level']) $(id).addEventListener('change', () => this.renderPreview());
    for (const id of ['pn-x', 'pn-y', 'pn-level']) $(id).addEventListener('input', () => this.renderPreview());
    $('pn-img-send').addEventListener('click', () => this.sendImage());

    /**
     * 动画 / 视频：解码（`<video>`+rVFC 或 `ImageDecoder`）→ 逐帧整屏刷。
     * 播放器在 `anim.js`（纯逻辑 + 一个 `<video>` 元素），这里只接按钮与状态显示。
     * 发送是节拍器：解码更快就丢帧（`stat.dropped`），不会在 USB 队列里堆延迟。
     */
    this.anim = new PanelAnim({
      session: s,
      video: $('pn-anim-video'),
      geometry: () => this.geometry(),
      profile: () => s.profile?.profile ?? 0,
      pixelOpts: () => ({
        swap: $('pn-swap').checked,
        littleEndian: $('pn-byteorder').value === 'le',
        level: Math.max(0, Math.min(255, +$('pn-level').value || 255)),
        fit: $('pn-fit').value,
      }),
      log: (kind, text, tag) => s.log(kind, text, tag || this.tag),
      onFrame: (px, win) => this.drawAnimFrame(px, win),
      onState: st => this.renderAnim(st),
    });
    this.anim.loop = $('pn-anim-loop').checked;
    $('pn-anim-file').addEventListener('click', () => $('pn-anim-input').click());
    $('pn-anim-input').addEventListener('change', e => this.loadAnim(e.target.files[0]));
    $('pn-anim-play').addEventListener('click', () => this.playAnim());
    $('pn-anim-stop').addEventListener('click', () => this.anim.stop());
    $('pn-anim-loop').addEventListener('change', e => {
      this.anim.loop = e.target.checked;
      if (this.anim.video) this.anim.video.loop = e.target.checked;
    });

    // 面板电源 / 显示：4 个独立命令（上电 11h / 开显示 29h / 关显示 28h / 下电 10h）+ RST 脉冲
    $('pn-rst-send').addEventListener('click', () => this.sendResetPulse());
    for (const [id, cmd, delayMs, label] of [
      ['pn-pwr-on', 0x11, 120, '上电 11h（sleep out）'],
      ['pn-disp-on', 0x29, 0, '开显示 29h'],
      ['pn-disp-off', 0x28, 0, '关显示 28h'],
      ['pn-pwr-off', 0x10, 120, '下电 10h（sleep in）'],
    ]) $(id).addEventListener('click', () => this.sendPowerCmd(cmd, delayMs, label));
    $('pn-enable').addEventListener('click', () => this.wrap(() => s.setEnabled(true, this.tag)));
    $('pn-disable').addEventListener('click', () => this.wrap(() => s.setEnabled(false, this.tag)));

    $('pn-log-clear').addEventListener('click', () => { $('pn-log').innerHTML = ''; });

    // 两块大卡片可以折叠（初始化区默认展开占满主区，图片区默认折叠）；
    // 按钮文字按**初始状态**同步一次 —— HTML 里写死"展开/收起"容易和 class 对不上
    for (const b of document.querySelectorAll('#tab-panel .foldbtn')){
      const card = $(b.dataset.fold);
      b.textContent = card.classList.contains('folded') ? '展开' : '收起';
      b.addEventListener('click', () => {
        card.classList.toggle('folded');
        b.textContent = card.classList.contains('folded') ? '展开' : '收起';
      });
    }

    this.unsub = s.subscribe(this);
    this.fillPresetNote();
    this.loadPresetCode();                    // 一进来就有内容（跟参考页"内置图案"一个意思）
    this.setPattern('BAR');                   // 预览区也别空着：垫一张色条（只画不发）
    this.applyGeometry();
    this.renderState(s.stateInfo());
    this.renderCounters(s.counters);
  }

  onSession(type, payload){
    if (type === 'log') this.appendLog(payload);
    else if (type === 'state'){ this.renderState(payload); this.refreshButtons(); }
    else if (type === 'busy') this.refreshButtons();
    else if (type === 'cfg' || type === 'profile'){ this.renderSummary(); this.fillProfile(payload); }
    else if (type === 'counters') this.renderCounters(payload.counters);
  }

  // ==================================================================== 渲染

  appendLog(e){
    const el = $('pn-log');
    if (!el) return;
    const d = document.createElement('div');
    d.className = e.kind === 'g' ? 'ok' : e.kind === 'e' ? 'err' : e.kind === 'w' ? 'warn' : 'dim';
    d.textContent = (e.tag === 'bus' ? '[桥] ' : '') + e.text;
    el.appendChild(d);
    while (el.childNodes.length > 500) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
  }

  renderLogFromRing(){
    const el = $('pn-log');
    if (!el) return;
    el.innerHTML = '';
    for (const e of this.session.ring) this.appendLog(e);
  }

  renderState(st){
    setStatus($('pn-state'), st.text, st.kind || '');
    $('pn-info').textContent = st.mock ? '假探针（无需硬件）' : (st.hidLabel || '未连接');
    $('pn-usbinfo').textContent = st.dataReady ? st.transportLabel : '未连接数据端点';
    $('pn-mock').checked = !!st.mock;
  }

  renderCounters(c){
    if (!c) return;
    $('pn-c-ok').textContent = String(c.framesOk ?? 0);
    $('pn-c-err').textContent = String(c.framesErr ?? 0);
    $('pn-c-tx').textContent = fmtBytes(c.bytesTx ?? 0);
    $('pn-c-rx').textContent = fmtBytes(c.bytesRx ?? 0);
    $('pn-sclk-actual').textContent = c.actualSclkHz ? P.sclkLabel(c.actualSclkHz) : '—';
  }

  renderSummary(){
    const s = this.session;
    const c = s.cfg, p = s.profile;
    $('pn-sum-sclk').textContent = c ? P.sclkLabel(c.sclkHz) : '—';
    $('pn-sum-cs').textContent = c ? (P.CS_POLICY.find(x => x.v === c.csPolicy)?.label || c.csPolicy) : '—';
    $('pn-sum-pads').textContent = c
      ? `DC=${P.PAD_NAME[c.padDc]} · RST=${P.PAD_NAME[c.padRst]} · BL=${P.PAD_NAME[c.padBl]}` +
        ((c.padActiveLow & 0x06) ? '（RST/CS 低有效）' : '')
      : '—';
    $('pn-sum-profile').textContent = p ? `${P.PROFILE_NAME[p.profile]} · 线数 ${p.defLines}` : '—';
  }

  fillProfile(p){
    if (!p) return;
    $('pn-profile').value = String(p.profile);
    $('pn-deflines').value = String(p.defLines);
    $('pn-dcactive').checked = !!p.dcActiveHigh;
    $('pn-cshold').checked = !!p.csHoldInStep;
    $('pn-qspiwr').value = '0x' + p.qspiWrOpcode.toString(16).padStart(2, '0');
    $('pn-qspicolor').value = '0x' + p.qspiColorOpcode.toString(16).padStart(2, '0');
    $('pn-qspiaddr').value = String(p.qspiAddrBytes);
  }

  fillPresetNote(){
    $('pn-preset-note').textContent = PANEL_PRESETS[$('pn-preset').value]?.note || '';
  }

  refreshButtons(){
    const s = this.session, c = s.connected, d = s.dataReady, busy = s.busy;
    $('pn-prof-get').disabled = !c; $('pn-prof-set').disabled = !c;
    $('pn-enable').disabled = !c; $('pn-disable').disabled = !c;
    $('pn-preset-apply').disabled = !c;
    const canSend = d && !busy;
    for (const id of ['pn-code-play', 'pn-img-send', 'pn-rst-send', 'pn-pwr-on', 'pn-disp-on', 'pn-disp-off', 'pn-pwr-off']) $(id).disabled = !canSend;
    $('pn-code-stop').disabled = !busy;
    $('pn-code-parse').disabled = false;
    // 动画：有源 + 端点就绪 + 不忙 才能播；播放中「播放」变灰、「停止」可用
    const anim = this.anim;
    $('pn-anim-play').disabled = !(canSend && anim?.src);
    $('pn-anim-play').textContent = anim?.running ? '播放中…' : '播放到屏';
    $('pn-anim-stop').disabled = !anim?.running;
    $('pn-anim-file').disabled = !!anim?.running;
    for (const b of $('pn-code-body').querySelectorAll('button[data-act]')) b.disabled = !canSend;
  }

  // ==================================================================== 面板初始化

  /** 一进来就把内置示例填好（用户可以直接看"贴进来长什么样"）*/
  loadPresetCode(key){
    const k = key || $('pn-code-preset').value || C.PANEL_KEYS[0];
    const d = C.PANEL_DATA[k];
    if (!d) return;
    $('pn-code-text').value = d.text;
    this.session.log('i', `已载入内置示例：${d.label}（${d.expect.rows} 条）`, this.tag);
    this.parseCode();
  }

  async loadCodeFile(file){
    if (!file) return;
    try {
      const text = await file.text();
      $('pn-code-text').value = text;
      this.session.log('i', `已载入文件：${file.name}（${text.length} 字符）`, this.tag);
      this.parseCode();
    } catch (e){ this.session.log('e', '读文件失败：' + (e?.message || e), this.tag); }
  }

  parseCode(){
    this.bitpop.close();          // 行对象要整批重建：位开关板指着的那一行已经作废
    const text = $('pn-code-text').value;
    const r = C.parsePanelCode(text);
    this.parsed = r;
    this.rows = r.rows;
    const withPrefix = $('pn-code-prefix').checked && r.rows.length > 0;
    this.effectiveRows = withPrefix ? [...REQUIRED_PREFIX.map(x => ({ ...x })), ...r.rows] : r.rows;
    // 原值快照：表格里的"脏标记 / 改回 / 恢复原值 / 哪些位动过"全靠它比对（不是靠一个粘住的 flag ——
    // 改回原值就该自己变干净）。深拷贝 data，别和行共享同一个 Uint8Array。
    this.baseRows = this.effectiveRows.map(r2 => ({ ...r2, data: Uint8Array.from(r2.data) }));
    this.renderCodeTable(this.effectiveRows);
    const bits = [`认出 ${r.stats.rows} 条`, `${r.stats.paramsBytes} 参数字节`, `累计延时 ${r.stats.delayMs} ms`,
                  `格式 ${r.format}`];
    if (withPrefix) bits.push('已自动补 0x36/0x3A 两条前缀');
    if (r.errors.length) bits.push(`⚠ ${r.errors.length} 行没认出来`);
    if (r.warnings.length) bits.push(`⚠ ${r.warnings.length} 条告警`);
    this.setCodeSummary(bits.join(' · '), r.errors.length ? 'err' : (r.warnings.length ? 'warn' : 'ok'));
    if (r.errors.length){
      for (const e of r.errors.slice(0, 5)) this.session.log('e', `第 ${e.line} 行没认出来：${e.why} —— ${e.text}`, this.tag);
    }
    if (r.warnings.length){
      for (const w of r.warnings.slice(0, 5)) this.session.log('w', `第 ${w.line} 行：${w.why}`, this.tag);
    }
    this.session.log('g', `解析完成：${r.stats.rows} 条 / ${r.stats.paramsBytes} 参数字节 / 累计 ${r.stats.delayMs} ms` +
      (withPrefix ? ' · 重放时会先补 MADCTL/COLMOD' : '') +
      (r.errors.length ? `（${r.errors.length} 行未识别，见上）` : ''), this.tag);
  }

  setCodeSummary(text, kind){
    this._sum = { text, kind };
    this.renderSum();
  }

  /** 这一行和"解析出来的原值"是否不同（指纹比对：改回原值就自己变干净）*/
  rowDirty(i){
    const r = (this.effectiveRows || [])[i], b = (this.baseRows || [])[i];
    if (!r || !b) return false;
    return fingerprint(r) !== fingerprint(b);
  }

  dirtyCount(){
    const rows = this.effectiveRows || this.rows;
    let n = 0;
    for (let i = 0; i < rows.length; i++) if (this.rowDirty(i)) n++;
    return n;
  }

  /** 摘要 = 解析结果 + "已改 N 行"（改过字节后一眼知道表格与文本框不再一致）*/
  renderSum(){
    const el = $('pn-code-sum');
    if (!el || !this._sum) return;
    const n = this.dirtyCount();
    el.textContent = this._sum.text + (n ? ` · 已改 ${n} 行（按改后的值重放/导出）` : '');
    el.className = 'hint';
    if (this._sum.kind) el.classList.add(this._sum.kind);
    el.style.color = this._sum.kind === 'err' ? 'var(--err)' : this._sum.kind === 'warn' ? 'var(--warn)' : this._sum.kind === 'ok' ? 'var(--ok)' : '';
  }

  /** 表格：命令字节与每个参数字节都是**可编辑的十六进制格子**（照 `tools/bmp_sender.html`）。
   *  点参数字节 → 位开关板；直接敲 → 改值。两者都走 `setRowByte`。 */
  renderCodeTable(rows){
    const body = $('pn-code-body');
    if (!rows.length){
      body.innerHTML = '<tr><td colspan="6" style="color:var(--fg2)">（还没有内容 —— 贴代码后点「解析并预览」）</td></tr>';
      this.bitpop.close();
      return;
    }
    body.innerHTML = rows.map((r, i) => {
      const isAuto = !!r.auto;
      const cls = [isAuto ? 'auto' : '', this.rowDirty(i) ? 'dirty' : ''].filter(Boolean).join(' ');
      const params = r.data.length
        ? [...r.data].map((v, j) =>
            `<input class="bx" data-i="${i}" data-b="${j}" maxlength="2" spellcheck="false" value="${hx(v)}"` +
            ` title="第 ${j} 字节 · 0x${hx(v)} = ${C.bitsText(v)} —— 直接敲十六进制改它；点一下开位开关板">`).join(' ')
        : '<span style="color:var(--fg2)">（无参数）</span>';
      const acts = `<button class="mini" data-act="one" data-i="${i}">单发</button> ` +
        `<button class="mini" data-act="from" data-i="${i}">从此重放</button>` +
        (this.rowDirty(i) ? ` <button class="mini" data-act="revert" data-i="${i}" title="这一行改回解析出来的原值">改回</button>` : '');
      return `<tr${cls ? ` class="${cls}"` : ''}>` +
        `<td>${i}</td><td style="color:var(--fg2)">${isAuto ? '补' : (r.line || '')}</td>` +
        `<td><input class="bx cmd" data-i="${i}" maxlength="2" spellcheck="false" value="${hx(r.cmd)}" title="命令字节（DCS 命令）—— 直接敲十六进制"></td>` +
        `<td class="params">${params}${isAuto ? ` <span style="color:var(--warn)">← ${r.name}</span>` : ''}</td>` +
        `<td>${r.delayMs || ''}</td>` +
        `<td class="acts">${acts}</td></tr>`;
    }).join('');
    this.drawRuler();
    this.bitpop.reattach();       // 整表重建 → 把弹窗的锚点找回来（找不到就自己关掉）
    if (this.bitpop.isOpen) this.bitpop.render();
  }

  /** 表头那行"字节序号标尺"：按当前**最长的那一行**生成（0 1 2 3 …）
   *  ⚠️ 每个 span 的宽度必须和 `.bx` 格子一致（都 25px、都用空格分隔），否则会越往后越偏。 */
  drawRuler(){
    const el = $('pn-code-ruler');
    if (!el) return;
    const maxb = (this.effectiveRows || []).reduce((m, r) => Math.max(m, r.data.length), 0);
    const parts = [];
    for (let i = 0; i < maxb; i++) parts.push(`<span>${i}</span>`);
    el.innerHTML = parts.join(' ');
  }

  /** 只把一行改回原值（表格里手改错了不用整表重解析）*/
  revertRow(i){
    const b = (this.baseRows || [])[i];
    if (!b || !(this.effectiveRows || [])[i]) return;
    this.effectiveRows[i] = { ...b, data: Uint8Array.from(b.data) };
    this.renderCodeTable(this.effectiveRows);
    this.renderSum();
    this.session.log('i', `第 ${i} 行已改回解析出来的原值（0x${hx(b.cmd)}）`, this.tag);
  }

  /** 位开关板改了某个字节（bit-editor.js 的回调）：重绘表格 + 摘要 + 记一条日志 */
  onByteEdit(row, i, k, v){
    this.renderCodeTable(this.effectiveRows || this.rows);
    this.renderSum();
    const what = k === 'cmd' ? '命令' : `参数[${k}]`;
    this.session.log('i', `第 ${i} 行「${what}」改成 0x${hx(v)}（重放/导出按改后的值，文本框不动）`, this.tag);
  }

  exportRows(kind){
    // 导出的就是**表格里现在这份**：含自动补的前缀、含刚用位开关板改过的字节
    const rows = this.effectiveRows || this.rows;
    if (!rows.length){ this.session.log('w', '还没有解析出内容', this.tag); return; }
    const text = kind === 'c' ? C.rowsToC(rows) : kind === 'json' ? C.rowsToJson(rows) : C.rowsToText(rows);
    const name = kind === 'c' ? 'panel_init.c' : kind === 'json' ? 'panel_init.json' : 'panel_init.txt';
    try {
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      const a = document.createElement('a');
      a.href = url; a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      this.session.log('g', `已导出 ${name}（${rows.length} 条）`, this.tag);
    } catch (e){ this.session.log('e', '导出失败：' + (e?.message || e), this.tag); }
  }

  /** 重放 [start, end]（只有最后一条要应答；192 条会被打包器攒批成十几包）*/
  async playRows(start, end){
    const s = this.session;
    const rows = this.effectiveRows || this.rows;
    if (!rows.length){ s.log('w', '先「解析并预览」再来重放', this.tag); return; }
    if (!s.dataReady){ s.log('e', '先「连接数据端点」（或勾「用假探针」）', this.tag); return; }
    if (!s.enabled) s.log('w', '桥还没使能 —— 先点「使能」：未使能时 bulk OUT 端点不武装，写会一直 NAK/超时', this.tag);
    if (s.busy) return;
    const a = Math.max(0, Math.min(start, rows.length - 1));
    const b = Math.max(a, Math.min(end, rows.length - 1));
    const items = C.rowsToItems(rows, { start: a, end: b });
    const totalBytes = rows.slice(a, b + 1).reduce((n, r) => n + r.data.length, 0);

    this.playAbort = false;
    s.setBusy(true);
    this.refreshButtons();
    const t0 = performance.now();
    const label = a === b ? `单发第 ${a} 条` : `重放 ${a}..${b}`;
    $('pn-code-prog').textContent = `${label} 进行中…`;
    s.log('i', `${label}：${items.length} 条 / ${totalBytes} 参数字节`, this.tag);
    try {
      const r = await s.sendFrames(items, {
        tag: this.tag, quiet: true, timeoutMs: 4000,
        onProgress: (sent, total) => {
          $('pn-code-prog').textContent = `${label}：${sent}/${total} 包`;
          if (this.playAbort) throw new Error('用户中止');
        },
        shouldStop: () => this.playAbort,
      });
      const ms = performance.now() - t0;
      const bad = r.rsps.filter(x => x && x.status !== P.ST.OK).length;
      s.log(bad ? 'e' : 'g', `${label} 完成：${r.packs} 包 · ${ms.toFixed(0)} ms` +
        ` · 平均 ${(totalBytes / Math.max(1, ms) * 1000 / 1024).toFixed(1)} KB/s` + (bad ? ` · ${bad} 个非 OK 应答` : ''), this.tag);
      $('pn-code-prog').textContent = `${label} 完成（${r.packs} 包 / ${ms.toFixed(0)} ms）`;
    } catch (e){
      s.log('e', `${label} 失败：` + (e?.message || e), this.tag);
      $('pn-code-prog').textContent = `${label} 失败`;
    } finally {
      s.setBusy(false);
      this.refreshButtons();
      await s.pollStatus(true);
    }
  }

  // ==================================================================== 图片 / 图案

  buildPatternChips(){
    const box = $('pn-patterns');
    box.innerHTML = '';
    for (const [label, kind] of I.PATTERNS){
      const b = document.createElement('button');
      b.className = 'mini';
      b.textContent = label;
      b.dataset.kind = kind;
      b.addEventListener('click', () => this.setPattern(kind));
      box.appendChild(b);
    }
  }

  setPattern(kind){
    const g = this.geometry();
    const p = I.makePattern(kind, g.w, g.h);
    this.patternKind = kind;
    this.src = { ...p, name: `内置图案 ${kind}` };
    for (const b of $('pn-patterns').querySelectorAll('button')) b.classList.toggle('on', b.dataset.kind === kind);
    this.renderPreview();
    this.revealCanvas();
    this.session.log('i', `图案 ${kind}（${p.w}×${p.h}）`, this.tag);
  }

  /** 点图案/选图之后把预览滚进视野。
   *  ⚠️ 不能用 `canvas.scrollIntoView()`：它会把**所有祖先滚动容器**一起滚，
   *     包括左边那栏（用户会看到侧栏莫名其妙跳走）。这里只动图片卡片自己的 scrollTop。 */
  revealCanvas(){
    const card = $('pn-img-card'), canvas = $('pn-canvas');
    if (!card || !canvas) return;
    const cr = card.getBoundingClientRect(), vr = canvas.getBoundingClientRect();
    if (vr.top < cr.top) card.scrollTop += vr.top - cr.top - 8;
    else if (vr.bottom > cr.bottom) card.scrollTop += vr.bottom - cr.bottom + 8;
  }

  async pickImage(file){
    if (!file) return;
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      let src;
      if (buf[0] === 0x42 && buf[1] === 0x4d){                       // BMP 自己解析（浏览器不解 16bpp）
        const d = I.parseBMP(buf);
        src = { w: d.w, h: d.h, rgba: d.rgba, name: file.name };
      } else {
        const bmp = await createImageBitmap(new Blob([buf]));
        const c = document.createElement('canvas');
        c.width = bmp.width; c.height = bmp.height;
        const g = c.getContext('2d');
        g.drawImage(bmp, 0, 0);
        const id = g.getImageData(0, 0, bmp.width, bmp.height);
        src = { w: bmp.width, h: bmp.height, rgba: new Uint8Array(id.data), name: file.name };
        bmp.close?.();
      }
      this.src = src;
      this.patternKind = null;
      for (const b of $('pn-patterns').querySelectorAll('button')) b.classList.remove('on');
      this.renderPreview();
      this.revealCanvas();
      this.session.log('g', `已载入 ${src.name}：${src.w}×${src.h}`, this.tag);
    } catch (e){
      this.session.log('e', '载入图片失败：' + (e?.message || e), this.tag);
    }
  }

  geometry(){
    const k = $('pn-geom').value || 'st77916';
    return I.PANEL_GEOMETRY[k] || I.PANEL_GEOMETRY.st77916;
  }

  applyGeometry(){
    const g = this.geometry();
    $('pn-canvas').width = g.w;
    $('pn-canvas').height = g.h;
    this.renderPreview();
  }

  /** 预览 = **将要发出去的样子**（compose → 565 → 回读，含 R/B 交换与电平）*/
  renderPreview(){
    const g = this.geometry();
    const canvas = $('pn-canvas');
    if (canvas.width !== g.w || canvas.height !== g.h){ canvas.width = g.w; canvas.height = g.h; }
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, g.w, g.h);
    if (!this.src){
      $('pn-img-sum').textContent = '选一张图或点一个内置图案';
      ctx.strokeStyle = '#2e3440';
      ctx.strokeRect(0.5, 0.5, g.w - 1, g.h - 1);
      return;
    }
    const x = Math.max(0, +$('pn-x').value || 0), y = Math.max(0, +$('pn-y').value || 0);
    const win = I.alignWindow(x, y, g.w, g.h, { align: g.align, scrW: g.w, scrH: g.h });
    const comp = I.composeImage(this.src.rgba, this.src.w, this.src.h, win.w, win.h, { mode: $('pn-fit').value });
    const px = I.rgbaTo565(comp.rgba, {
      swap: $('pn-swap').checked,
      littleEndian: $('pn-byteorder').value === 'le',
      level: Math.max(0, Math.min(255, +$('pn-level').value || 255)),
    });
    const shown = I.rgb565ToRgba(px);

    const off = document.createElement('canvas');
    off.width = win.w; off.height = win.h;
    off.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(shown), win.w, win.h), 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, win.x0, win.y0);

    // 橙色虚线 = 探针真正下发的对齐窗口；青色实线 = 请求的落点
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = '#ffb020';
    ctx.strokeRect(win.x0 + 0.5, win.y0 + 0.5, win.w - 1, win.h - 1);
    ctx.setLineDash([]);
    ctx.strokeStyle = '#4ea1ff';
    ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, win.w) - 1, Math.max(1, win.h) - 1);

    const slices = Math.ceil(px.length / I.PIXEL_SLICE);
    const prof = this.session.profile?.profile ?? 0;
    $('pn-img-sum').textContent =
      `${this.src.name} · ${this.src.w}×${this.src.h} → 窗口 ${win.x0}..${win.x1} × ${win.y0}..${win.y1}` +
      `（${win.w}×${win.h}${win.padX ? `，对齐补 ${win.padX} 列` : ''}）\n` +
      `${px.length} 字节 → ${slices} 片（每片 ${I.PIXEL_SLICE} B）` +
      (prof === 1 ? ` + RAMWR 命令 + 2 条开窗（CS 一路保持到末片）= ${slices + 3} 帧`
                  : ` + 2 条开窗 = ${slices + 2} 帧`);
    $('pn-img-info').textContent = `${this.src.name}\n源图 ${this.src.w}×${this.src.h} · 目标 ${win.w}×${win.h}`;
  }

  /** 刷这一张：开窗 2 帧 + 527 片像素（只有末片要应答）*/
  async sendImage(){
    const s = this.session;
    if (!this.src){ s.log('w', '先选一张图或图案', this.tag); return; }
    if (!s.dataReady){ s.log('e', '先「连接数据端点」（或勾「用假探针」）', this.tag); return; }
    if (!s.enabled) s.log('w', '桥还没使能 —— 先点「使能」：未使能时 bulk OUT 端点不武装，写会一直 NAK/超时', this.tag);
    if (s.busy) return;
    if (!s.profile){ s.log('w', '还没读到面板档 —— 先「读取档位」或点「套用推荐值」', this.tag); }
    const g = this.geometry();
    const x = Math.max(0, +$('pn-x').value || 0), y = Math.max(0, +$('pn-y').value || 0);
    const out = I.imageToFrames(this.src.rgba, this.src.w, this.src.h, {
      geometry: g, x, y, fit: $('pn-fit').value,
      profile: s.profile?.profile ?? 0, lines: g.lines,
      swap: $('pn-swap').checked,
      littleEndian: $('pn-byteorder').value === 'le',
      level: Math.max(0, Math.min(255, +$('pn-level').value || 255)),
    });

    s.setBusy(true);
    this.refreshButtons();
    const t0 = performance.now();
    s.log('i', `刷图开始：${g.w}×${g.h} · ${out.slices} 片 / ${out.px} 字节 · 档 ${s.profile?.profile ?? '?'}`, this.tag);
    try {
      const r = await s.sendFrames(out.items, {
        tag: this.tag, quiet: true, timeoutMs: 5000,
        onProgress: (sent, total) => {
          const pct = (sent / total * 100).toFixed(0);
          const dt = (performance.now() - t0) / 1000;
          $('pn-img-sum').textContent = `发送中 ${pct}%（${sent}/${total} 包）· ${dt.toFixed(1)} s · ` +
            `${(out.px / 1024 / Math.max(0.001, dt)).toFixed(0)} KB/s`;
        },
      });
      const ms = performance.now() - t0;
      const bad = r.rsps.filter(v => v && v.status !== P.ST.OK);
      const kbPerSec = out.px / 1024 / Math.max(0.001, ms / 1000);
      this.lastRun = { ms, bytes: out.px, slices: out.slices, frames: out.items.length,
                       sclkHz: s.counters.actualSclkHz, kbPerSec, badRsp: bad.length, when: Date.now() };
      s.log(bad.length ? 'e' : 'g',
        `刷图完成：${out.slices} 片 · ${fmtBytes(out.px)} · ${ms.toFixed(0)} ms · ` +
        `${kbPerSec.toFixed(0)} KB/s` +
        (bad.length ? ` · ${bad.length} 个非 OK 应答（${P.ST_TEXT[bad[0].status] || bad[0].status}）` : ''), this.tag);
      this.renderPreview();
    } catch (e){
      s.log('e', '刷图失败：' + (e?.message || e), this.tag);
    } finally {
      s.setBusy(false);
      this.refreshButtons();
      await s.pollStatus(true);
    }
  }

  // ==================================================================== 动画 / 视频

  /** 选文件 → 建源（视频走 `<video>`+rVFC，GIF/APNG 走 ImageDecoder）*/
  async loadAnim(file){
    if (!file) return;
    try {
      const src = await this.anim.load(file);
      $('pn-anim-video').classList.toggle('on', src.kind === 'video');
      $('pn-anim-info').textContent = `${src.name} · ${src.w}×${src.h}` +
        (src.kind === 'gif' ? ` · ${src.frames} 帧（GIF）` : ` · ${(src.duration || 0).toFixed(1)} s（视频）`) +
        `　→ 开窗后每帧 ${this.geometry().w * this.geometry().h * 2} 字节，整帧刷`;
      this.session.log('g', `动画已就绪：${src.name}（${src.w}×${src.h}）—— 点「播放到屏」开播`, this.tag);
    } catch (e){
      this.session.log('e', '动画源加载失败：' + (e?.message || e), this.tag);
      $('pn-anim-info').textContent = '加载失败：' + (e?.message || e);
    }
    this.refreshButtons();
  }

  async playAnim(){
    try {
      await this.anim.start();
    } catch (e){
      this.session.log('e', '动画播放失败：' + (e?.message || e), this.tag);
    }
    this.refreshButtons();
  }

  /** 每帧的预览：画的是**量化后真正发出去的那份**（与静图预览同一个口径）*/
  drawAnimFrame(px, win){
    const canvas = $('pn-canvas');
    const g = this.geometry();
    if (canvas.width !== g.w || canvas.height !== g.h){ canvas.width = g.w; canvas.height = g.h; }
    if (!this._animOff){ this._animOff = document.createElement('canvas'); }
    const off = this._animOff;
    if (off.width !== win.w || off.height !== win.h){ off.width = win.w; off.height = win.h; }
    const shown = I.rgb565ToRgba(px);
    off.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(shown), win.w, win.h), 0, 0);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, g.w, g.h);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, win.x0, win.y0);
  }

  /** 播放状态行（每帧刷新一次；同时同步按钮可用性）*/
  renderAnim(st){
    if (!st) return;
    const el = $('pn-anim-info');
    if (el){
      if (st.running){
        el.textContent = `发送中：${st.frames} 帧 · 实测 ${st.fps.toFixed(1)} fps · ${st.kbs.toFixed(0)} KB/s` +
          ` · 最后帧 ${st.lastMs.toFixed(0)} ms` + (st.dropped ? ` · 丢帧 ${st.dropped}（解码比发送快，正常）` : '');
      } else if (st.frames){
        el.textContent = `上次：${st.frames} 帧 · ${(st.bytes / 1024).toFixed(0)} KB · ${(st.ms / 1000).toFixed(1)} s · ` +
          `实测 ${st.fps.toFixed(1)} fps · ${st.kbs.toFixed(0)} KB/s` + (st.dropped ? ` · 丢帧 ${st.dropped}` : '');
      }
    }
    this.refreshButtons();
  }

  // ==================================================================== 档位 / 推荐值 / 复位

  async wrap(fn){
    try { await fn(); } catch (e){ this.session.log('e', e?.message || String(e), this.tag); }
  }

  readProfileFromUI(){
    return {
      profile: +$('pn-profile').value || 0,
      defLines: +$('pn-deflines').value || 1,
      dcActiveHigh: $('pn-dcactive').checked,
      csHoldInStep: $('pn-cshold').checked,
      qspiWrOpcode: parseHexByteSafe($('pn-qspiwr').value, 0x02),
      qspiColorOpcode: parseHexByteSafe($('pn-qspicolor').value, 0x32),
      qspiAddrBytes: Math.max(0, Math.min(4, +$('pn-qspiaddr').value || 3)),
    };
  }

  async applyProfile(){
    await this.wrap(() => this.session.applyProfile(this.readProfileFromUI(), this.tag));
  }

  /** 按屏型号一键套用：档位 + SCLK + DC/RST/BL + 预览按该屏的几何 */
  async applyPreset(){
    const key = $('pn-preset').value;
    const preset = PANEL_PRESETS[key];
    if (!preset) return;
    await this.wrap(async () => {
      const s = this.session;
      s.log('i', `套用推荐值：${preset.label}`, this.tag);
      await s.applyProfile(preset.profile, this.tag);
      const cur = s.cfg;
      if (!cur){ s.log('w', '还没读到当前配置（先「连接探针」），只套用了档位', this.tag); }
      else {
        await s.applyConfig({ ...cur, ...preset.cfg }, this.tag);
        await s.pollStatus(true);
      }
      if (preset.geom && GEOMETRY_SRC[preset.geom]){ $('pn-geom').value = preset.geom; this.applyGeometry(); }
      this.fillProfile(s.profile);
    });
  }

  async sendResetPulse(){
    await this.wrap(() => this.session.sendFrames([{
      type: P.T.RESET,
      payload: P.resetPayload(Math.max(0, +$('pn-rst-low').value || 0), Math.max(0, +$('pn-rst-post').value || 0)),
      flags: P.F.RSP, label: 'RESET 脉冲',
    }], { tag: this.tag }));
  }

  /** 面板电源/显示：一条 STEP 命令（11h 上电 / 29h 开显示 / 28h 关显示 / 10h 下电）*/
  async sendPowerCmd(cmd, delayMs, label){
    await this.wrap(() => this.session.sendFrames([{
      type: P.T.STEP,
      payload: P.stepPayload({ cmd, params: new Uint8Array(0), delayMs }),
      flags: P.F.RSP,
      label: label || `STEP 0x${cmd.toString(16)}`,
    }], { tag: this.tag }));
  }

  // ==================================================================== 生命周期

  onShow(){
    this.renderLogFromRing();
    this.renderSummary();
    this.renderPreview();
    this.refreshButtons();
    this.session.pollStatus(true);
  }

  summary(){
    return {
      ...this.session.summary(),
      preset: $('pn-preset')?.value || null,
      geom: $('pn-geom')?.value || null,
      rows: this.rows.length,
      tableRows: (this.effectiveRows || []).length,      // 表格行数（含自动补的前缀）
      editedRows: this.dirtyCount(),                     // 与原值不同的行（表格里手改或位开关板改的）
      bitpopOpen: this.bitpop.isOpen,
      parseErrors: this.parsed?.errors?.length ?? 0,
      source: this.src ? `${this.src.name} ${this.src.w}×${this.src.h}` : null,
      anim: this.anim ? {
        src: this.anim.src ? `${this.anim.src.name} ${this.anim.src.w}×${this.anim.src.h} ${this.anim.src.kind}` : null,
        running: this.anim.running, frames: this.anim.stat.frames, dropped: this.anim.stat.dropped,
        bytes: this.anim.stat.bytes, fps: +this.anim.stat.fps.toFixed(2), kbs: +this.anim.stat.kbs.toFixed(1),
        lastMs: +this.anim.stat.lastMs.toFixed(1),
      } : null,
      lastRun: this.lastRun || null,          // 最近一次刷图的客观数字（脚本/自检直接读，别去解析日志）
      logLines: this.session.ring.length,
    };
  }
}

/** 表格里的字节文本（小写两位十六进制，与老的纯文本渲染一致）*/
const hx = v => (v & 0xff).toString(16).padStart(2, '0');

/** 一行的指纹（命令 + 延时 + 全部参数）：与解析时的原值快照比 → 脏标记 / 「改回」/「恢复原值」
 *  🚨 用指纹而不是一个"改过"的 flag：改成原值再改回来，那一行就该自己变干净。 */
const fingerprint = r => `${r.cmd}|${r.delayMs | 0}|${[...r.data].join(',')}`;

/** "0x2C" / "2c" → 44；空/非法 → fallback（面板档那两个 opcode 用）*/
function parseHexByteSafe(s, fallback = 0){
  const t = String(s ?? '').trim().replace(/^0x/i, '');
  if (!/^[0-9a-f]{1,2}$/i.test(t)) return fallback;
  return parseInt(t, 16) & 0xff;
}
