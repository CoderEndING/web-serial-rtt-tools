/**
 * 烧录器：把 .elf / .hex / .bin 写进目标芯片，可校验、可复位运行。
 *
 * 两种后端：
 *   · WebUSB · 零安装（主通道，与 RTT 同一个探针）：页面解析固件 → 在目标 RAM 里跑
 *     flashloader 算法（flash/algos.js + runner.js）完成擦写 → 读回校验 → 复位运行。
 *     现覆盖 F0/F1/F4/F7/H7/L0/L4；进度条是真实百分比。
 *   · 本地桥 · OpenOCD（备用）：其余系列/特殊需求用，OpenOCD 的 program 一条龙
 *     （rpc 拿不到流式进度，只显示耗时）。
 *
 * 文件两种来源（浏览器不允许页面直接读任意路径，所以并存）：
 *   · 选择文件/拖拽 —— 网页把内容传给烧录逻辑（WebUSB 与桥都可用）；
 *   · 路径输入框 —— 只有桥后端能读（桥在本机直接读文件）。
 *
 * 与 RTT Viewer 复用同一个探针：同一时刻只能有一个占用，开烧前会把在跑的 RTT 会话断开。
 */
import { $, setStatus } from '../ui/dom.js';
import { toast } from '../ui/toast.js';
import { store } from '../core/store.js';
import { CHIPS, fillChipSelect } from '../core/chips.js';
import { BridgeClient } from '../rtt/bridge.js';
import { WebUsbDapProbe, withTimeout } from '../rtt/dap-webusb.js';
import { ALGOS } from './algos.js';
import { FlashRunner } from './runner.js';
import { parseFirmware } from './image.js';
import { bytes as fBytes } from '../core/format.js';
import { pickCfgs } from '../ui/cfgpicker.js';

export class FlashView {
  constructor(){
    this.bc = null;
    this.probe = null;
    this.file = null;          // { name, size, dataB64 } —— 「选择文件/拖拽」时有效
    this.busy = false;
  }

  init(){
    fillChipSelect($('f-chip'));
    store.bind($('f-backend'), 'flash.backend');
    store.bind($('f-chip'), 'flash.chip');
    store.bind($('f-bridge-url'), 'flash.bridgeUrl');
    store.bind($('f-path'), 'flash.path');
    store.bind($('f-base'), 'flash.base');
    store.bind($('f-verify'), 'flash.verify', 'checked');
    store.bind($('f-reset'), 'flash.reset', 'checked');
    $('f-chip').addEventListener('change', () => this._applyChip());
    this._applyChip();
    // 「选择…」：列出桥所在机器的 OpenOCD cfg 让你挑（浏览器拿不到本地文件路径，列表只能由桥给）
    $('f-cfgs-pick').addEventListener('click', async () => {
      const v = await pickCfgs({
        bridgeUrl: $('f-bridge-url').value,
        current: $('f-cfgs').value,
        title: '选择 OpenOCD cfg（烧录器用）',
      });
      if (v !== null){ $('f-cfgs').value = v; store.set('flash.cfgs', v); }
    });

    // ---------- 固件文件 ----------
    this._fileInput = document.createElement('input');
    this._fileInput.type = 'file';
    this._fileInput.accept = '.elf,.hex,.bin,.axf,.out';
    this._fileInput.style.display = 'none';
    this._fileInput.addEventListener('change', () => {
      const f = this._fileInput.files?.[0];
      this._fileInput.value = '';                     // 允许重复选同一个文件
      this._onFile(f);
    });
    document.body.appendChild(this._fileInput);
    $('f-pick').addEventListener('click', () => this._fileInput.click());
    $('f-path').addEventListener('input', () => { this.file = null; this._fileInfo(); });
    const drop = $('f-log');
    drop.addEventListener('dragover', e => e.preventDefault());
    drop.addEventListener('drop', e => { e.preventDefault(); this._onFile(e.dataTransfer?.files?.[0]); });
    this._fileInfo();

    $('f-flash').addEventListener('click', () => this.flash().catch(e => this._err(e)));
    $('f-logclear').addEventListener('click', () => { $('f-log').textContent = ''; });
    this._status('空闲');
  }

  // ================= 文件 =================
  async _onFile(f){
    if (!f) return;
    try {
      const buf = await f.arrayBuffer();
      this.file = { name: f.name, size: f.size, dataB64: this._b64(new Uint8Array(buf)) };
      $('f-path').value = '';
      store.set('flash.path', '');
      this._fileInfo();
      toast(`已读入 ${f.name}（${fBytes(f.size)}），点「烧录」写入`, 'ok', 4000);
    } catch (e){
      toast(`读文件失败：${e?.message || e}`, 'err');
    }
  }

  /** Uint8Array → base64（分块，避免 String.fromCharCode 爆栈） */
  _b64(u8){
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode(...u8.subarray(i, i + CH));
    return btoa(s);
  }

  _fileInfo(){
    const p = String($('f-path').value || '').trim();
    const cur = this.file ? this.file.name : p;
    const el = $('f-file-info');
    if (this.file) el.textContent = `已选择：${this.file.name}（${fBytes(this.file.size)}）`;
    else if (p) el.textContent = `将用桥所在电脑上的路径：${p}（仅「本地桥」后端可读路径）`;
    else el.textContent = '支持 .elf / .hex / .bin：点「选择文件…」或拖进右侧日志区；填路径仅「本地桥」后端支持';
    $('f-base-row').hidden = !/\.bin$/i.test(cur);
  }

  _applyChip(){
    const custom = $('f-chip').value === 'custom';
    $('f-custom-cfgs-row').hidden = !custom;
    $('f-custom-speed-row').hidden = !custom;
  }
  // ================= 烧录 =================
  async flash(){
    if (this.busy) return;
    const pathText = String($('f-path').value || '').trim();
    const usePath = !this.file && !!pathText;
    if (!this.file && !pathText){ toast('先指定固件：点「选择文件…」或填路径', 'warn'); return; }
    if (usePath && $('f-backend').value === 'webusb'){
      throw new Error('零安装模式读不了磁盘路径（浏览器安全限制）：点「选择文件…」选文件，或换「本地桥」后端');
    }

    // 探针互斥：RTT 会话在跑就先（经确认）断开
    const rtt = window.__tools?.rtt;
    if (rtt && (rtt.probe || rtt.bridge)){
      if (!confirm('RTT 会话正占用探针，烧录需要先断开它。继续吗？')) return;
      await rtt.disconnect();
    }

    this.busy = true;
    $('f-flash').disabled = true;
    const t0 = Date.now();
    const timer = setInterval(() => {
      if ($('f-bar').hidden) this._status(`烧录中… 已耗时 ${((Date.now() - t0) / 1000) | 0}s`);
    }, 500);
    try {
      const name = this.file ? this.file.name : pathText;
      if ($('f-backend').value === 'webusb'){
        await this._flashWebusb(name);
      } else {
        await this._flashBridge(name, pathText);
      }
      this._status(`空闲（上次烧录用时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
    } catch (e){
      this._status('空闲');
      setStatus($('f-result'), `❌ ${e?.message || e}`, 'err');
      // 失败也要复位目标：flashloader 可能已写进 RAM（踩掉 RTT 控制块等数据），
      // 不复位的话固件带着被踩的 RAM 继续跑，RTT/串口看上去就"坏了"。
      // 先试 nRESET 脉冲；不行再试 AIRCR 软复位（很多接线根本没把 NRST 连到探针）。
      try { if (this.probe) await this.probe.reset(); }
      catch { try { if (this.probe) await this.probe.sysReset(); } catch {} }
      throw e;
    } finally {
      clearInterval(timer);
      this.busy = false;
      $('f-flash').disabled = false;
      /**
       * 🚨 **烧完必须把探针还回去**（成功失败都要）。
       *    烧录器是另开一个 WebUsbDapProbe 会话的；不释放的话接口一直被占着 ——
       *    现象：烧录失败后 RTT 连不上、再点一次烧录报「占用 USB 接口失败」，
       *    用户只能刷新页面才好（实测就是这么个坑）。
       */
      try { if (this.probe) await this.probe.disconnect(); } catch {}
      this.probe = null;
    }
  }

  // ---------- 主通道：WebUSB 零安装 ----------
  async _flashWebusb(name){
    const chip = $('f-chip').value;
    const algo = ALGOS[chip];
    if (!algo) throw new Error(`「${chip}」暂未内置零安装烧录算法（现覆盖 F0/F1/F4/F7/H7/L0/L4）：请换「本地桥 · OpenOCD」后端`);

    // 解析固件（webusb 只吃页面里选的文件）
    const raw = Uint8Array.from(atob(this.file.dataB64), c => c.charCodeAt(0));
    const base = Number($('f-base').value) || 0;
    const regions = parseFirmware(name, raw, base);
    const total = regions.reduce((s, r) => s + r.data.length, 0);

    // 探针：复用已授权的（不弹框），没有才弹浏览器选择框。
    // 烧录强制 1MHz：flashloader 执行依赖 PPB（调试寄存器）访问，实测本探针固件
    // 在高时钟下 PPB 访问不可靠（读回 0），RTT 那种纯 RAM 访问则 8MHz 没问题。
    //
    // 🚨 每一步都必须带超时：WebUSB 的挂起传输会把浏览器的 USB 服务搞脏，
    //    那时 `navigator.usb.getDevices()` 会**永远不返回**（实测卡 90 秒以上、界面看着像死了，
    //    连 RTT 那边也一起连不上）。宁可 5 秒报错让用户刷新/拔插，也不要无声卡死。
    let auth;
    try {
      auth = await withTimeout(WebUsbDapProbe.authorized(), 5000, '枚举已授权探针');
    } catch (e){
      throw new Error(`${e.message} —— 浏览器 USB 服务可能被上一次中断的会话卡住了：刷新页面（或拔插一次探针）再试`);
    }
    this.probe = auth.length
      ? await withTimeout(WebUsbDapProbe.open(auth[0], { clockKhz: 1000 }), 15000, '连接探针（WebUSB）')
      : await withTimeout(WebUsbDapProbe.request(false, { clockKhz: 1000 }), 60000, '等你在浏览器里选探针');
    // 烧录走**严格档**：flashloader 靠状态位判断算法是否跑完，读错=校验失败；
    // 每页写同一个 RAM 缓冲，写后必须回读把 posted 写逼落地（对照 rtt/view.js 的快速档）
    this.probe.fast = false;

    const verify = $('f-verify').checked;
    const doReset = $('f-reset').checked;
    const runner = new FlashRunner(this.probe);
    this._log(`── 零安装烧录：${this.file.name}（${fBytes(total)}）→ ${chip} ──`);
    this._bar(1);
    /**
     * 🚨 开烧之前**先复位一次目标**。
     *    烧录会先把向量表所在的扇区擦掉，此时若中断进来内核就进 **LOCKUP**；
     *    而 LOCKUP 一旦进入就出不来（DHCSR.C_HALT 清不掉，只能复位）。
     *    上一次被中断的烧录留下的 LOCKUP 会让这一次连"让目标跑起来"都做不到
     *    （报「无法让目标继续运行」）。复位是最便宜、最干净的入场券。
     */
    this._status('复位目标（清掉上一次可能留下的 LOCKUP）…');
    try { await this.probe.sysReset(); } catch (e){ this._log('软复位失败（继续试）：' + (e?.message || e)); }
    this._status('加载 flashloader 到目标 RAM…');
    await runner.load(algo);

    // 擦：覆盖固件的那些扇区
    let erased = 0, eraseTotal = 0;
    for (const seg of regions) this._checkRange(seg, algo);
    for (const seg of regions){
      const ps = algo.page_size;
      for (let a = algo.flash_start + Math.floor((seg.addr - algo.flash_start) / ps) * ps;
           a < seg.addr + seg.data.length; a += ps){
        eraseTotal++;
      }
    }
    for (const seg of regions){
      const ps = algo.page_size;
      for (let a = algo.flash_start + Math.floor((seg.addr - algo.flash_start) / ps) * ps;
           a < seg.addr + seg.data.length; a += ps){
        await runner.eraseSector(a);
        erased++;
        this._bar(1 + (erased / eraseTotal) * 29);
        this._status(`擦除扇区 ${erased}/${eraseTotal}（0x${a.toString(16)}）…`);
      }
    }

    // 写：按缓冲块大小分块，数据进 RAM 缓冲 → 算法搬进 flash
    let written = 0;
    const chunk = runner.chunkSize();
    for (const seg of regions){
      for (let off = 0; off < seg.data.length; off += chunk){
        let page = seg.data.subarray(off, Math.min(off + chunk, seg.data.length));
        /**
         * 尾部补 0xFF 到**编程粒度**的整数倍。
         * 🚨 粒度不是处处都等于 4：F1/F4 这类按字（4B）写就行，但 **H7 是按 32 字节
         *    （256 位 flash word）编程**的 —— 尾块不补齐到 32 字节，算法那一页就写不进去，
         *    现象是"校验失败、某个地址读到 0xFF/旧值"。粒度由 algos.js 的 write_granularity 给。
         */
        const gran = algo.write_granularity || 4;
        if (page.length % gran){
          const pad = new Uint8Array(((page.length + gran - 1) / gran | 0) * gran);
          pad.set(page);
          pad.fill(0xff, page.length);
          page = pad;
        }
        await runner.programPage(seg.addr + off, page);
        written += page.length;
        this._bar(30 + (written / total) * 60);
        this._status(`写入 ${fBytes(written)} / ${fBytes(total)}（0x${(seg.addr + off).toString(16)}）…`);
      }
    }

    // 校验：读回逐字节比对
    if (verify){
      this._status('校验（读回比对）…');
      this._bar(90);
      for (const seg of regions){
        /**
         * 🚨 用「连读一致才认」的稳定读，而不是单次 readMem：
         *    这颗探针的 AP 读是**挂起读**（读回上一笔事务的数据），紧跟算法写 flash 之后
         *    的第一遍读常常整段是旧值 —— 实测就出现过"读到 0x0、期望 0xe7"，而 flash 里
         *    其实写对了（用裸客户端读同一个地址是正确的）。读两次一致才认，读不可靠时不会误报。
         */
        const rb = await this._readStable(seg.addr, seg.data.length);
        for (let i = 0; i < seg.data.length; i++){
          if (rb[i] !== seg.data[i]){
            throw new Error(`校验失败：0x${(seg.addr + i).toString(16)} 处读到 0x${rb[i].toString(16)}，期望 0x${seg.data[i].toString(16)}`);
          }
        }
      }
      this._bar(99);
    }

    if (doReset){
      /**
       * 🚨 这里必须用**系统复位**（AIRCR.SYSRESETREQ），不能只拉 nRESET 引脚：
       *   · 很多接线（本机这块 F103 就是）根本没把 NRST 连到探针，拉引脚等于没复位；
       *   · 更要命的是跑 flashloader 前我们调过 maskInterrupts()，把目标的 SysTick/NVIC
       *     关掉了。不复位的话固件"能跑但不打印"—— 现象是 RTT 连得上、控制块也对，
       *     却一个字节都不来（自测里的「等待超时：ch0 数据」就是这么来的）。
       *   系统复位会把外设/SysTick 全部初始化回正常状态。
       */
      this._status('复位运行…');
      try { await this.probe.sysReset(); }
      catch (e){ this._log('软复位失败，退回 nRESET 脉冲：' + (e?.message || e)); await this.probe.reset(); }
    }
    this._bar(100);
    this._log('── 完成 ──');
    setStatus($('f-result'),
      `✅ ${chip} · ${fBytes(total)}${verify ? ' · 校验通过' : ''}${doReset ? ' · 已复位运行' : ''}`, 'ok');
    toast('烧录成功', 'ok', 5000);
  }

  /**
   * 稳定读：连续两次读到的内容完全一致才认（最多 5 轮）。
   * 专治这颗探针的「挂起读」——紧跟写操作之后的第一遍读拿到的是上一笔事务的数据。
   * ⚠️ 只用于**静态**数据（flash 校验）：RTT 之类的动态内存本来就会变，别用它。
   */
  async _readStable(addr, len){
    let prev = await this.probe.readMem(addr, len);
    for (let i = 0; i < 4; i++){
      const cur = await this.probe.readMem(addr, len);
      if (cur.length === prev.length){
        let same = true;
        for (let j = 0; j < cur.length; j++){ if (cur[j] !== prev[j]){ same = false; break; } }
        if (same) return cur;
      }
      prev = cur;
      await new Promise(r => setTimeout(r, 20));
    }
    this._log('（提示：校验读连续 5 轮都不一致，可能是读不可靠或目标在动）');
    return prev;
  }

  _checkRange(seg, algo){    if (seg.addr < algo.flash_start || seg.addr + seg.data.length > algo.flash_start + algo.flash_length){
      throw new Error(`固件地址 0x${seg.addr.toString(16)}… 超出 ${$('f-chip').value} 的 flash 范围（0x${algo.flash_start.toString(16)} 起 ${fBytes(algo.flash_length)}）—— 芯片选对了吗？`);
    }
  }

  // ---------- 备用：本地桥 · OpenOCD ----------
  async _flashBridge(name, pathText){
    this._bar(50);   // OpenOCD 的 rpc 拿不到流式进度，只能示意
    this._status('桥烧录中…（OpenOCD 完成后一次性返回结果）');
    this.bc = new BridgeClient($('f-bridge-url').value);
    await this.bc.connect({ version: 1 });
    const cfg = {
      target: $('f-chip').value,
      verify: $('f-verify').checked,
      reset: $('f-reset').checked,
    };
    if (cfg.target === 'custom'){
      cfg.cfgs = String($('f-cfgs').value || '').split(/[,\s;]+/).map(s => s.trim()).filter(Boolean);
      cfg.speed = Number($('f-speed').value) || 0;
      if (!cfg.cfgs.length) throw new Error('自定义目标要填 cfg 文件（逗号分隔）');
    }
    if (/\.bin$/i.test(name)) cfg.base = Number($('f-base').value) || 0;
    if (this.file){ cfg.name = this.file.name; cfg.dataB64 = this.file.dataB64; cfg.size = this.file.size; }
    else cfg.path = pathText;

    const r = await this.bc.flash(cfg);
    this._bar(100);
    this._log(`── 桥烧录完成（${r.seconds.toFixed(1)}s）──\n${r.output || ''}`);
    setStatus($('f-result'),
      `✅ ${r.target} · ${fBytes(r.bytes)} · ${r.seconds.toFixed(1)}s${r.verify ? ' · 已校验' : ''}${r.reset ? ' · 已复位运行' : ''}`, 'ok');
    toast('烧录成功', 'ok', 5000);
  }

  // ================= 界面小工具 =================
  _bar(pct){
    const bar = $('f-bar');
    bar.hidden = false;
    bar.value = Math.max(0, Math.min(100, pct));
    if (pct >= 100) setTimeout(() => { bar.hidden = true; }, 1500);
  }
  _status(s){ setStatus($('f-status'), s); }
  _log(s){
    const el = $('f-log');
    el.textContent += (el.textContent ? '\n' : '') + s;
    el.scrollTop = el.scrollHeight;
  }
  _err(e){
    this._log('── 出错 ──\n' + (e?.message || e));
    toast(String(e?.message || e), 'err', 6000);
  }
}
