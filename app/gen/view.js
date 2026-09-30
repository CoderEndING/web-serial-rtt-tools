/**
 * 「工程生成」页。
 *
 * 干什么：把 Keil .uvprojx 工程要用的**调试/下载配套文件**在浏览器里直接生成 ——
 *   Makefile.jlink / jlink_gdb.script / Makefile.pyocd / Makefile.openocd(+rtt_logger.py) / test_sram.bin
 * 内容与用户自己的 Python 工具（uvprojx2cmake.py）默认参数下逐字节一致（见 app/gen/model.js）。
 *
 * 文件怎么落地（浏览器的限制要讲清楚）：
 *   · Edge/Chrome：File System Access API —— 选一次文件夹，直接把多个文件写进去（不打包、不解压）；
 *   · 其它浏览器：打包成一个 ZIP 落「下载」文件夹；
 *   · 预览区还能单独下载当前那一个文件。
 * 注意：网页**不能**悄悄写你的项目目录，一定要你亲手选一次目录（浏览器安全模型）。
 * 注意：仓库的 $() 就是 document.getElementById(id)，**收裸 id，前面不要加 '#'**
 *      （写成 $('#x') 会静默拿到 null —— 这个坑踩过一次）。
 */
import { $, setStatus, setFlag, debounce } from '../ui/dom.js';
import { toast } from '../ui/toast.js';
import { store } from '../core/store.js';
import { zipStore } from './zip.js';
import {
  OUTPUTS, PARAM_DEFAULTS, JLINK_DEVICES, OPENOCD_INTERFACES, OPENOCD_TARGETS,
  parseUvprojx, suggestFromDevice, matchFamily, buildOutputs, appliedFixes,
} from './model.js';
import { bridgeKitFiles as kitFiles, kitBytes, KIT_DIR } from './bridge-kit.js';

const FIELDS = [
  ['g-project', 'gen.project'],
  ['g-device', 'gen.device'],
  ['g-flash-start', 'gen.flashStart'],
  ['g-if', 'gen.jlinkIf'],
  ['g-speed', 'gen.jlinkSpeed'],
  ['g-rtt-addr', 'gen.rttAddress'],
  ['g-rtt-size', 'gen.rttSize'],
  ['g-gdb-port', 'gen.gdbPort'],
  ['g-build-dir', 'gen.buildDir'],
  ['g-generator', 'gen.cmakeGenerator'],
  ['g-build-type', 'gen.buildType'],
  ['g-pyocd-target', 'gen.pyocdTarget'],
  ['g-pyocd-freq', 'gen.pyocdFreq'],
  ['g-openocd-root', 'gen.openocdRoot'],
  ['g-openocd-if', 'gen.openocdInterface'],
  ['g-openocd-target', 'gen.openocdTarget'],
  ['g-openocd-freq', 'gen.openocdFreq'],
  ['g-rtt-port', 'gen.rttPort'],
  ['g-testbin-size', 'gen.testBinSize'],
  // 本地桥安装包
  ['g-bk-on', 'gen.bkOn', 'checked'],
  ['g-bk-port', 'gen.bkPort'],
  ['g-bk-target', 'gen.bkTarget'],
  ['g-bk-cfgs', 'gen.bkCfgs'],
  ['g-bk-speed', 'gen.bkSpeed'],
  ['g-bk-openocd', 'gen.bkOpenocd'],
  ['g-bk-scripts', 'gen.bkScripts'],
  ['g-bk-jdev', 'gen.bkJlinkDevice'],
  ['g-bk-jspeed', 'gen.bkJlinkSpeed'],
  ['g-bk-nodever', 'gen.bkNodeVer'],
  ['g-bk-mirror', 'gen.bkMirror'],
  ['g-bk-autonode', 'gen.bkAutoNode', 'checked'],
  ['g-newline', 'gen.newline'],
  ['g-force', 'gen.force', 'checked'],
  ['g-c-jlink', 'gen.cJlink', 'checked'],
  ['g-c-gdb', 'gen.cGdb', 'checked'],
  ['g-c-pyocd', 'gen.cPyocd', 'checked'],
  ['g-c-openocd', 'gen.cOpenocd', 'checked'],
  ['g-c-testbin', 'gen.cTestBin', 'checked'],
];

export class GenView {
  constructor(){
    this.files = [];
    this.sel = 0;
    this.info = null;          // parseUvprojx 的结果（提示用）
    this.folderName = '';      // 上次写入的文件夹名（提示用）
    this._bound = false;
  }

  init(){
    if (this._bound) return;
    this._bound = true;

    // 下拉/数据源
    $('g-device-list').innerHTML = JLINK_DEVICES.map(d => `<option>${d}</option>`).join('');
    $('g-openocd-if').innerHTML = OPENOCD_INTERFACES.map(i => `<option value="${i.cfg}">${i.label}</option>`).join('');
    $('g-openocd-targets').innerHTML = OPENOCD_TARGETS.map(t => `<option>${t}</option>`).join('');

    // 绑定 + 持久化（刷新不丢）
    for (const [id, key, kind] of FIELDS) store.bind($(id), key, kind);

    // 任何改动 → 重新生成（防抖）
    const again = debounce(() => this.refresh(), 90);
    $('tab-gen').addEventListener('input', again);
    $('tab-gen').addEventListener('change', again);

    // 选择 / 拖入 .uvprojx
    $('g-uvpick').addEventListener('click', () => $('g-uvfile').click());
    $('g-uvfile').addEventListener('change', e => {
      const f = e.target.files?.[0];
      if (f) this.loadUvprojx(f);
      e.target.value = '';
    });
    const panel = $('tab-gen');
    panel.addEventListener('dragover', e => { e.preventDefault(); panel.classList.add('dragging'); });
    panel.addEventListener('dragleave', () => panel.classList.remove('dragging'));
    panel.addEventListener('drop', e => {
      e.preventDefault();
      panel.classList.remove('dragging');
      const f = [...(e.dataTransfer?.files || [])].find(x => /\.uvprojx$/i.test(x.name)) || e.dataTransfer?.files?.[0];
      if (f) this.loadUvprojx(f);
    });

    // 保存
    $('g-save').addEventListener('click', () => this.saveToFolder());
    $('g-zip').addEventListener('click', () => this.downloadZip());
    $('g-zip-bridge').addEventListener('click', () => this.downloadBridgeZip());
    $('g-copy').addEventListener('click', () => this.copyCurrent());
    $('g-dl').addEventListener('click', () => this.downloadCurrent());
    // 改了桥那几项就地重算（和别的字段一样：input/change 都挂）
    for (const el of $('tab-gen').querySelectorAll('input,select')){
      if (el.id.startsWith('g-bk-')) el.addEventListener('change', () => this.refresh());
    }

    this.refresh();
  }

  onShow(){ this.refresh(); }

  // ---------------------------------------------------------------- 参数
  params(){
    const c = id => $(id).checked;
    return {
      projectName: $('g-project').value.trim() || PARAM_DEFAULTS.projectName,
      jlinkDevice: $('g-device').value.trim() || PARAM_DEFAULTS.jlinkDevice,
      flashStart: $('g-flash-start').value.trim() || PARAM_DEFAULTS.flashStart,
      jlinkIf: $('g-if').value, jlinkSpeed: $('g-speed').value.trim(),
      rttAddress: $('g-rtt-addr').value.trim() || PARAM_DEFAULTS.rttAddress,
      rttSize: $('g-rtt-size').value.trim(), gdbPort: $('g-gdb-port').value.trim(),
      buildDir: $('g-build-dir').value.trim(), cmakeGenerator: $('g-generator').value,
      buildType: $('g-build-type').value,
      pyocdTarget: $('g-pyocd-target').value.trim(), pyocdFreq: $('g-pyocd-freq').value.trim(),
      openocdRoot: $('g-openocd-root').value.trim(),
      openocdInterface: $('g-openocd-if').value,
      openocdTarget: $('g-openocd-target').value.trim(),
      openocdFreq: $('g-openocd-freq').value.trim(),
      rttPort: $('g-rtt-port').value.trim(),
      testBinSize: $('g-testbin-size').value.trim(),
      newline: $('g-newline').value,
      force: $('g-force').checked,
      // 本地桥安装包（J-Link / OpenOCD 那条路；见 bridge-kit.js）
      bridgeKit: c('g-bk-on'),
      bridgePort: $('g-bk-port').value.trim(),
      bridgeTarget: $('g-bk-target').value,
      bridgeCfgs: $('g-bk-cfgs').value.trim(),
      bridgeSpeed: $('g-bk-speed').value.trim(),
      bridgeOpenocd: $('g-bk-openocd').value.trim(),
      bridgeScripts: $('g-bk-scripts').value.trim(),
      bridgeJlinkDevice: $('g-bk-jdev').value.trim(),
      bridgeJlinkSpeed: $('g-bk-jspeed').value.trim(),
      bridgeNodeVer: $('g-bk-nodever').value.trim(),
      bridgeMirror: $('g-bk-mirror').value === '1',
      bridgeAutoNode: c('g-bk-autonode'),
      checks: { jlink: c('g-c-jlink'), gdb: c('g-c-gdb'), pyocd: c('g-c-pyocd'), openocd: c('g-c-openocd'), testBin: c('g-c-testbin') },
    };
  }

  // ---------------------------------------------------------------- 生成 + 预览
  refresh(){
    this.p = this.params();
    /**
     * 产物 = Python 模板那几件 + **本地桥安装包**（桥那几件在 `bridge-kit.js` 里单独生成，
     * 不掺进 `buildOutputs()` —— 那个函数的产物要和 Python 工具逐字节对账，不能动）。
     */
    this.kitFiles = kitFiles({
      on: this.p.bridgeKit,
      port: this.p.bridgePort, token: '',
      target: this.p.bridgeTarget, customCfgs: this.p.bridgeCfgs, speed: this.p.bridgeSpeed,
      openocd: this.p.bridgeOpenocd, scripts: this.p.bridgeScripts,
      jlinkDevice: this.p.bridgeJlinkDevice, jlinkSpeed: this.p.bridgeJlinkSpeed,
      nodeVersion: this.p.bridgeNodeVer, mirror: this.p.bridgeMirror, autoNode: this.p.bridgeAutoNode,
    });
    this.files = [...buildOutputs(this.p), ...this.kitFiles];
    if (this.sel >= this.files.length) this.sel = Math.max(0, this.files.length - 1);
    this.renderFileTabs();
    this.renderPreview();

    const bytes = this.files.reduce((a, f) => a + f.data.length, 0);
    const kb = (bytes / 1024).toFixed(1);
    const nfix = appliedFixes(this.p).length;
    if (!this.files.length){
      setStatus($('g-status'), '一个都没勾：至少勾一个产物', 'err');
    } else {
      setStatus($('g-status'), `${this.files.length} 个文件 · ${kb} KB · ${this.p.newline === 'lf' ? 'LF' : 'CRLF'} · 修正 ${nfix} 项` +
        (this.kitFiles.length ? ` · 含桥包 ${(kitBytes(this.kitFiles) / 1024).toFixed(0)} KB` : ''), 'ok');
    }
    this.renderDetect();
    return this.files;
  }

  renderFileTabs(){
    const box = $('g-files');
    box.innerHTML = '';
    /**
     * 两行：第一行 = 工程配套文件（uvprojx2cmake.py 那几件），第二行 = **本地桥安装包**的文件。
     * 桥包那 7 个带 `rtt-bridge-kit/` 前缀，跟工程是两回事 —— 混在一行里既挤又认不出谁是谁
     * （用户 2026-10 要求："他们都属于本地桥的，把他们放到第二行"）。
     */
    const row1 = document.createElement('div'); row1.className = 'filerow';
    const row2 = document.createElement('div'); row2.className = 'filerow kit';
    this.files.forEach((f, i) => {
      const b = document.createElement('button');
      // 标签只显示文件名（桥包那 7 个带 rtt-bridge-kit/ 前缀，全写出来会把标签栏撑成三行）；
      // 完整路径放 title，鼠标悬停能看全
      b.textContent = f.name.split('/').pop();
      b.title = f.name;
      b.className = i === this.sel ? 'on' : '';
      b.addEventListener('click', () => { this.sel = i; this.renderFileTabs(); this.renderPreview(); });
      (/^rtt-bridge-kit\//.test(f.name) ? row2 : row1).appendChild(b);
    });
    box.appendChild(row1);
    if (row2.childElementCount) box.appendChild(row2);   // 没勾桥包时不显示空行
  }

  renderPreview(){
    const f = this.files[this.sel];
    const pre = $('g-preview');
    if (!f){
      pre.textContent = '';
      return;
    }
    if (f.bin) pre.textContent = hexPreview(f.data);
    else pre.textContent = f.text;
    pre.scrollTop = 0;
  }

  renderDetect(){
    const el = $('g-detect');
    const info = this.info;
    if (!info){
      el.textContent = '把 .uvprojx 拖进来（或点上面的按钮）：项目名、器件、Flash 起址会自动填好，其余都能手改。';
      el.className = 'hint';
      return;
    }
    const parts = [];
    if (info.device) parts.push(`器件 ${info.device}${info.cpu ? '（' + info.cpu + '）' : ''}`);
    if (info.flashSize) parts.push(`Flash ${info.flashStart}+${info.flashSize}`);
    if (info.ramSize) parts.push(`RAM ${info.ramStart}+${info.ramSize}`);

    // RTT 搜索范围越过 RAM 顶就提醒一句（Python 工具的 0x5000 默认值在 20KB RAM 的 F103 上会越界）
    let warn = '';
    const ramS = parseInt(info.ramStart, 16), ramSz = parseInt(info.ramSize, 16);
    const rtt = parseInt(this.p?.rttAddress || '', 16), rttSz = parseInt(this.p?.rttSize || '', 16);
    if (!isNaN(ramS) && !isNaN(ramSz) && !isNaN(rtt) && !isNaN(rttSz)){
      if (rtt + rttSz > ramS + ramSz){
        warn = ` ⚠ RTT 搜索范围 ${this.p.rttAddress}+${this.p.rttSize} 超出 RAM 顶 0x${(ramS + ramSz).toString(16)}（能用，但扫描会扫到不存在的地址）`;
      }
    }
    el.textContent = parts.join(' · ') + warn;
    el.className = warn ? 'hint err' : 'hint ok';
  }

  // ---------------------------------------------------------------- .uvprojx
  async loadUvprojx(file){
    try {
      const text = await file.text();
      const info = parseUvprojx(text);
      this.info = info;
      const sug = suggestFromDevice(info.device);

      // 项目名：Python 工具取的是 .uvprojx 所在**目录名**；浏览器只有拖文件夹进来才知道目录名
      const rel = file.webkitRelativePath || file._relPath || '';
      const dirName = rel.includes('/') ? rel.split('/').slice(-2, -1)[0] : '';
      const base = file.name.replace(/\.[^.]+$/, '');
      const projectName = dirName || info.targetName || base;

      const filled = [];
      const setVal = (id, v) => { if (v){ $(id).value = v; filled.push(id); } };
      setVal('g-project', projectName);
      setVal('g-device', sug.jlinkDevice);
      setVal('g-flash-start', info.flashStart);
      setVal('g-pyocd-target', sug.pyocdTarget);
      setVal('g-openocd-target', sug.openocdTarget);

      for (const [id, key, kind] of FIELDS){
        const el = $(id);
        store.set(key, kind === 'checked' ? el.checked : el.value);
      }
      this.refresh();
      const notes = [
        info.device ? `器件 ${info.device}` : '没读到器件名',
        info.flashSize ? `Flash ${info.flashStart}+${info.flashSize}` : '',
        info.ramSize ? `RAM ${info.ramStart}+${info.ramSize}` : '',
        dirName ? `项目名取目录名「${projectName}」` : `项目名取「${projectName}」（浏览器看不到上级目录名，可手改）`,
      ].filter(Boolean);
      toast(notes.join(' · '), 'ok', 5200);
    } catch (e){
      toast('读不了这个 .uvprojx：' + (e?.message || e), 'err');
    }
  }

  // ---------------------------------------------------------------- 落地
  /** 文件清单里可能带 `rtt-bridge-kit/xxx` 这种子目录名：目录选择器要一层层建出来 */
  async _handleFor(root, name, create){
    const parts = String(name).split('/');
    let dir = root;
    for (const seg of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(seg, { create });
    return dir.getFileHandle(parts[parts.length - 1], { create });
  }

  async saveToFolder(){
    if (!this.files.length) return toast('先勾一个产物', 'warn');
    if (!window.showDirectoryPicker){
      toast('这个浏览器不支持「写入文件夹」，改用 ZIP 下载', 'warn');
      return this.downloadZip();
    }
    let dir;
    try {
      dir = await window.showDirectoryPicker({ id: 'gen-output', mode: 'readwrite', startIn: 'documents' });
    } catch (e){
      if (e?.name === 'AbortError') return;          // 用户取消，不算错误
      toast('打不开那个文件夹：' + (e?.message || e), 'err');
      return;
    }

    // 先看有没有同名文件（和 Python 工具的"存在就不覆盖"一个意思）
    const exists = [];
    for (const f of this.files){
      try { await this._handleFor(dir, f.name, false); exists.push(f.name); } catch {}
    }
    if (exists.length && !$('g-force').checked){
      if (!confirm(`${dir.name} 里已存在：\n  ${exists.join('\n  ')}\n\n覆盖它们吗？`)) return;
    }

    try {
      for (const f of this.files){
        const fh = await this._handleFor(dir, f.name, true);
        const w = await fh.createWritable();
        await w.write(f.data);
        await w.close();
      }
      this.folderName = dir.name;
      setStatus($('g-status'), `已写入 ${this.files.length} 个文件 → ${dir.name}`, 'ok');
      toast(`已写入「${dir.name}」：${this.files.map(f => f.name).join('、')}`, 'ok', 5200);
    } catch (e){
      setStatus($('g-status'), '写入失败：' + (e?.message || e), 'err');
      toast('写入失败：' + (e?.message || e), 'err');
    }
  }

  downloadZip(){
    if (!this.files.length) return toast('先勾一个产物', 'warn');
    const zip = zipStore(this.files.map(f => ({ name: f.name, data: f.data })));
    const name = `${sanitize(this.p.projectName)}-gen.zip`;
    saveBlob(new Blob([zip], { type: 'application/zip' }), name);
    toast(`已打包 ${this.files.length} 个文件（${(zip.length / 1024).toFixed(1)} KB），在「下载」文件夹里`, 'ok', 5200);
  }

  /** 只打包「本地桥」那 7 个文件（zip 里带 `rtt-bridge-kit/` 这一层）—— 给人直接发这一包 */
  downloadBridgeZip(){
    if (!this.kitFiles?.length) return toast('先在「本地桥」那一栏把开关勾上', 'warn');
    const zip = zipStore(this.kitFiles.map(f => ({ name: f.name, data: f.data })));
    saveBlob(new Blob([zip], { type: 'application/zip' }), `${KIT_DIR}.zip`);
    toast(`已打包桥包 ${this.kitFiles.length} 个文件（${(zip.length / 1024).toFixed(1)} KB）：解压后双击 start-bridge.bat`, 'ok', 6000);
  }

  downloadCurrent(){
    const f = this.files[this.sel];
    if (!f) return;
    saveBlob(new Blob([f.data], { type: f.bin ? 'application/octet-stream' : 'text/plain' }), f.name);
    toast('已下载 ' + f.name, 'ok');
  }

  async copyCurrent(){
    const f = this.files[this.sel];
    if (!f) return;
    if (f.bin) return toast('二进制文件不支持复制，用「下载当前文件」', 'warn');
    try {
      await navigator.clipboard.writeText(f.text);
      toast('已复制 ' + f.name + '（' + f.data.length + ' 字节）', 'ok');
    } catch (e){
      toast('复制失败：' + (e?.message || e), 'err');
    }
  }

  /** 自检用（tools/selftest 与无头验证都读它） */
  summary(){
    return {
      files: this.files.map(f => ({ name: f.name, bytes: f.data.length })),
      total: this.files.reduce((a, f) => a + f.data.length, 0),
      project: this.p?.projectName,
      newline: this.p?.newline,
      detect: this.info,
      folder: this.folderName,
      // 本地桥安装包：开了就有 7 个文件（tools/selftest/bridge-kit.test.mjs 管内容，这里只管"在不在"）
      bridgeKit: {
        on: !!this.p?.bridgeKit,
        files: (this.kitFiles || []).map(f => f.name),
        bytes: (this.kitFiles || []).reduce((a, f) => a + f.data.length, 0),
      },
      supported: { directoryPicker: !!window.showDirectoryPicker },
    };
  }
}

// ---------------------------------------------------------------- 小工具
function saveBlob(blob, name){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const sanitize = s => String(s || 'project').replace(/[^\w.\-]+/g, '_');

function hexPreview(bytes, max = 256){
  const lines = [];
  for (let i = 0; i < Math.min(bytes.length, max); i += 16){
    const row = [...bytes.slice(i, i + 16)];
    const hex = row.map(b => b.toString(16).padStart(2, '0')).join(' ');
    const asc = row.map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('');
    lines.push(i.toString(16).padStart(8, '0') + '  ' + hex.padEnd(47) + '  ' + asc);
  }
  if (bytes.length > max) lines.push('…');
  lines.push(`（二进制：每字节 i % 256 的递增图案，共 ${bytes.length} 字节 —— 给 make openocd-sram 灌进 RAM 再回读比对用）`);
  return lines.join('\n');
}
