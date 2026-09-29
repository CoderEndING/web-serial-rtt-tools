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
import { ALGOS, F1_DEV, checkFlashRange } from './algos.js';
import { HPM_BOARDS, HPM_COMMON, hpmBoard, hpmCheckRange } from './hpm/chips.js';
import { DapJtagTransport, setOutputModeData, PROBE_OUTPUT_MODE } from './hpm/dap-transport.js';
import { RiscvTransport } from './hpm/riscv-dm.js';
import { HpmFlasher } from './hpm/flash.js';
import { AkaLinkHid } from '../hid/probe.js';
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
    // 零安装模式读不了磁盘路径（浏览器安全限制）——但别直接报错挡住用户：
    // 只给了路径时**自动改用本地桥**，并明确写一行日志说明为什么换了后端。
    if (usePath && $('f-backend').value === 'webusb'){
      $('f-backend').value = 'openocd';
      this._log('只给了磁盘路径：零安装（WebUSB）在后端读不了本地文件 → 自动改用「本地桥 · OpenOCD」。' +
                '想用零安装，请点「选择文件…」把固件选进来。');
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
    // RISC-V（HPM 系列）走另一条路：目标核不是 Cortex-M，烧录算法也不是 ARM 的 flashloader
    if (HPM_BOARDS.some(b => b.id === chip)) return await this._flashHpmRiscv(name);
    const algo = ALGOS[chip];
    if (!algo) throw new Error(`「${chip}」暂未内置零安装烧录算法（现覆盖 F0/F1/F4/F7/H7/L0/L4 与 HPM 系列 RISC-V）：请换「本地桥 · OpenOCD」后端`);

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

    /**
     * 🚨 **擦除粒度必须问芯片，不能照抄算法表。**
     *    `algos.js` 的 `page_size` 在本工程就是"擦除粒度"（runner 按它步进 erase_sector），
     *    而 F1 那份是按**大容量**（256~512KB，2KB/页）填的。中容量（DEV_ID 0x410，例如
     *    128KB 的 F103C8/CB）的页是 **1KB** —— 按 2KB 步进擦只会擦到第 0、8、16… 页，
     *    `0x400~0x7FF` 这些页**根本没擦过**；接着往未擦除区域编程 → F1 报 PGERR →
     *    flashloader 返回码 1（界面显示"擦写失败或地址/参数不对"）。
     *    2026-09 实测现场：独立校验显示 flash 从 **0x08000400** 起全是旧数据（第一页之后全错），
     *    用 OpenOCD 按 1KB 粒度补擦那几页后，同一份固件立刻烧录成功且逐字节一致。
     *    所以这里读 DBGMCU_IDCODE(0xE0042000) 的 DEV_ID 定粒度（与 OpenOCD 的 stm32f1x 同款做法）。
     *    只对认得出的 STM32F1 生效，其它芯片一律按算法表来（不动）。
     */
    let pageSize = algo.page_size;
    this._devId = null;
    try {
      const idb = await this.probe.readMem(0xE0042000, 4);
      const devId = (idb[0] | (idb[1] << 8)) & 0xfff;
      const info = F1_DEV[devId];
      if (info){
        pageSize = info.page;
        this._devId = devId;                // 顺带把容量上限也定下来（比系列最大值准）
        if (info.page !== algo.page_size){
          this._log(`芯片 DEV_ID=0x${devId.toString(16)}（STM32F1 ${info.name}）→ 擦除粒度按 ${info.page}B/页，`
            + `不是算法表里的 ${algo.page_size}B（差这一档会让没擦到的页编程失败）`);
        }
      }
    } catch (e){ /* 读不到就按算法表来 */ }

    // 擦：覆盖固件的那些扇区
    let erased = 0, eraseTotal = 0;
    for (const seg of regions) this._checkRange(seg, algo);
    for (const seg of regions){
      const ps = pageSize;          // 芯片实际粒度（见上面 DEV_ID 判定），不是 algo.page_size
      for (let a = algo.flash_start + Math.floor((seg.addr - algo.flash_start) / ps) * ps;
           a < seg.addr + seg.data.length; a += ps){
        eraseTotal++;
      }
    }
    for (const seg of regions){
      const ps = pageSize;          // 芯片实际粒度（见上面 DEV_ID 判定），不是 algo.page_size
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

  _checkRange(seg, algo){
    const series = $('f-chip').value;
    const r = checkFlashRange(algo, seg, { series, devId: this._devId });
    if (!r.ok){
      const lim = r.limitBytes;
      throw new Error(`固件地址 0x${seg.addr.toString(16)}…0x${(seg.addr + seg.data.length).toString(16)} 超出 `
        + `${series} 的 flash 范围（0x${algo.flash_start.toString(16)} 起 ${fBytes(lim)}`
        + `${this._devId ? `，按芯片 DEV_ID=0x${this._devId.toString(16)} 判的` : ''}）—— 芯片选对了吗？`
        + `（要放宽就选对芯片型号，或改 algos.js 里的 SERIES_MAX_KB）`);
    }
    // 越过算法自带标称区间只是**提示**：pyOCD 那份常按系列最小成员填（F4 = 64KB），
    // 硬拦会拒掉合法固件；真超了芯片自己会在编程时报错。
    if (r.beyondNominal){
      this._log(`提示：固件末端 0x${(seg.addr + seg.data.length).toString(16)} 越过算法表标称的 `
        + `${fBytes(algo.flash_length)}（算法自带区间，常按系列最小成员填）—— 只要芯片真有这么大就能烧，`
        + `小容量型号会在编程时报错`);
    }
  }

  // ---------- 备用：本地桥（OpenOCD 或 J-Link） ----------
  /**
   * HPM 系列（RISC-V/JTAG）的零安装烧录。
   *
   * 与 ARM 那条路的差别（都是"把算法搬进 RAM 再驱动它"，但驱动方式不同）：
   *   · 探针要切到 **SWD+JTAG** output_mode（HID CMD_SET_CONFIG，RAM-only），DAP 口选 JTAG；
   *   · 目标核是 RISC-V：停核/传参/取返回码走 Debug Module（抽象命令 + dpc），不是 DHCSR/DCRSR；
   *   · 算法是 RV32 的（`tools/target-firmware/hpm_flash_algo/`，一份 blob 通吃 HPM 全系），
   *     它自己调芯片 ROM 里的 XPI NOR 驱动去擦写外部 flash。
   *
   * ⚠️ **本轮没能在真机上验证**（探针被占用）：协议层、封包、流程都有离线自测（含模拟 DTM/模拟 flash），
   *    但真实 JTAG 时序、ROM API 行为、output_mode 切换后的枚举都要等 bring-up。界面会明说这一点。
   */
  async _flashHpmRiscv(name){
    const board = hpmBoard($('f-chip').value);
    if (!board) throw new Error(`不认识的 HPM 板子：${$('f-chip').value}`);

    const raw = Uint8Array.from(atob(this.file.dataB64), c => c.charCodeAt(0));
    const base = Number($('f-base').value) || board.flashBase;
    const regions = parseFirmware(name, raw, base);
    for (const seg of regions){
      const chk = hpmCheckRange(board, seg.addr, seg.data.length);
      if (!chk.ok) throw new Error(`固件段 0x${seg.addr.toString(16)} 不合法：${chk.why}`);
    }
    const total = regions.reduce((s, r) => s + r.data.length, 0);
    this._log(`── RISC-V 零安装烧录：${name}（${fBytes(total)}）→ ${board.name} ──`);
    this._log(`   板级参数来自 SDK 的 boards/openocd/boards/${board.id}.cfg：flash 基址 0x${board.flashBase.toString(16)}、` +
      `XPI 0x${board.xpiBase.toString(16)}、option0 0x${(board.option0 ?? 0).toString(16)}` + (board.option1 != null ? `、option1 0x${board.option1.toString(16)}` : ''));
    this._bar(1);

    // ① 探针：HID 切 output_mode，再走 WebUSB 认领 interface 0 并切 JTAG
    this._status('准备探针：切 SWD+JTAG 输出模式…');
    const hid = new AkaLinkHid();
    try {
      await withTimeout(hid.reconnect(), 8000, '连探针 HID');
      /**
       * 🚨 **每次都要发这条**，不能"读回来已经是 1 就跳过" —— 2026-10 真机实测：
       *    `CMD_GET_CONFIG` 明明报 output_mode=1，但 `DAP_Info(0xF0)` 的能力字里 JTAG=0、
       *    `DAP_Connect(2)` 返回 0（DISABLED）；**重发一次 SET_CONFIG(1) 之后立刻就能拿到 JTAG 口**。
       *    原因见固件注释：output_mode=0 时 TDI/TDO 被 VCOM(UART) 占着，探针宁可拒绝 JTAG 也不抢引脚；
       *    那条"存储的模式"和"引脚实际归谁"是两码事，重发一次才把桥拆掉。
       */
      await withTimeout(hid.xfer(0x02 /* CMD_SET_CONFIG */, setOutputModeData(PROBE_OUTPUT_MODE.SWD_JTAG)), 3000, '切输出模式');
      const cfg = await hid.xfer(0x01).catch(() => null);
      this._log(`探针 output_mode = ${cfg ? cfg[3] : '?'}（1 = SWD+JTAG；已强制重设一次，JTAG 才拿得到口）`);
      /**
       * 🚨 还要让探针**自己的 RISC-V 引擎**放掉 TAP（HID 0x33 action 0）。
       *    那个引擎（RISC-V 内存读写/bench）会一直占着 JTAG，不放开的话
       *    `DAP_Connect(2)` 拿不到口 —— 他们的 README 里烧录前也是先跑这一步。
       *    没响应也不当失败：本来就空闲时这条命令可能不回。
       */
      try {
        await withTimeout(hid.riscvStop(), 2000, 'RISC-V 引擎 stop');
        this._log('已请求探针 RISC-V 引擎放掉 TAP（0x33 action 0）');
      } catch (e){
        this._log('（0x33 stop 无响应，可能本来就空闲）');
      }
      /**
       * 🚨 **再把探针侧的 RTT 桥也停掉**（HID 0x31 action 0）。
       *    2026-10 用户现场：**另一个标签页**里的「RTT 转发」会话还在跑，桥一直在轮询目标内存，
       *    烧录这边每一条 DMI 都在跟它抢探针 —— 现象就是"烧录卡住、特别慢"（同一个镜像我这边 25 s，
       *    他那边十几分钟不动）。同一个页面里的 RTT 会话我们会先断开（见上面 `rtt.disconnect()`），
       *    但**跨标签页的会话无能为力**，只能在这里把桥停了。
       *    停不掉也不当失败：没在跑时这条命令可能不回。
       */
      try {
        await withTimeout(hid.stop(), 2500, 'RTT 桥 stop');
        this._log('已请求探针停掉 RTT 桥（HID 0x31 action 0）—— 跨标签页残留的转发会话也会被它停掉');
      } catch (e){
        this._log('（RTT 桥 stop 无响应，可能本来就没在跑）');
      }
    } catch (e){
      this._log('⚠ 切 output_mode 失败（继续试 JTAG）：' + (e?.message || e));
    } finally {
      try { await hid.close(); } catch {}
    }

    this._status('连接数据端点（WebUSB）…');
    const auth = await withTimeout(WebUsbDapProbe.authorized(), 5000, '枚举已授权探针');
    // 🚨 必须 `skipTargetInit`：默认那套 open() 会按 **SWD** 协商时钟（DAP_Connect(SWD)+SWD_Configure+
    //    读 IDCODE），而 HPM 是 RISC-V/JTAG 目标 —— 实测会卡在 USB 传输超时（"探针没响应"）。
    //    这条路自己用 DAP_Connect(JTAG) 开链，见 DapJtagTransport.connectJtag()。
    const openOpts = { skipTargetInit: true };
    const probe = auth.length
      ? await withTimeout(WebUsbDapProbe.open(auth[0], openOpts), 15000, '连接探针（WebUSB）')
      : await withTimeout(WebUsbDapProbe.request(false, openOpts), 60000, '等你在浏览器里选探针');
    this.probe = probe;
    probe.fast = false;

    const jtag = new DapJtagTransport(probe, { irLength: HPM_COMMON.irLength, log: l => this._log('   ' + l) });
    const dm = new RiscvTransport(jtag, { idle: 8, log: l => this._log('   ' + l) });
    this._status('打开 JTAG TAP / 唤醒调试模块…');
    const info = await dm.init();
    this._log(`   IDCODE=0x${info.idcode.toString(16)}（HPM 全系 0x1000563D）· dmstatus=0x${info.dmstatus.toString(16)}`);
    if (info.idcode !== HPM_COMMON.tapIdcode){
      throw new Error(`TAP IDCODE 是 0x${info.idcode.toString(16)}，不是 HPM 的 0x${HPM_COMMON.tapIdcode.toString(16)} —— ` +
        '检查：JTAG 接线（TCK/TMS/TDI/TDO/GND）、板子上电、探针 output_mode 是否切到 SWD+JTAG');
    }
    await dm.activate(0);
    await dm.halt(0, 3000);
    this._log('   目标已 halt，开始加载 flashloader');

    // ② flashloader + 参数探测
    const flasher = new HpmFlasher(dm, {
      board, log: l => this._log('   ' + l),
      onProgress: (frac, done, tot2, verifying) => {
        const pct = Math.round(frac * 100);
        this._bar(verifying ? 60 + pct * 0.4 : 5 + pct * 0.55);
        this._status((verifying ? '校验' : '烧写') + ` ${done} / ${tot2} B（${pct}%）`);
      },
    });
    this._status('加载 flashloader 到 SRAM（0x00000000）…');
    const chipInfo = await flasher.setup();
    this._log(`   flashloader 就绪：容量 ${(chipInfo.totalBytes / 1048576).toFixed(2)} MB · 扇区 ${chipInfo.sectorBytes} B`);

    // ③ 擦 → 写 → 校验
    const verify = $('f-verify').checked;
    let done = 0;
    for (const seg of regions){
      this._status(`擦除 0x${seg.addr.toString(16)} 起 ${fBytes(seg.data.length)}…`);
      await flasher.erase(seg.addr, seg.data.length);
      this._log(`擦除 OK：0x${seg.addr.toString(16)} + ${seg.data.length} B`);
      await flasher.program(seg.addr, seg.data);
      this._log(`烧写 OK：0x${seg.addr.toString(16)} + ${seg.data.length} B`);
      if (verify){
        this._status('校验（读回 flash 逐字节比）…');
        await flasher.verify(seg.addr, seg.data);
        this._log(`校验 OK：0x${seg.addr.toString(16)} + ${seg.data.length} B`);
      }
      done += seg.data.length;
    }
    this._bar(100);
    const doReset = $('f-reset').checked;
    await flasher.finish({ run: doReset });
    if (doReset) this._log('已发系统复位（ndmreset），目标从 flash 启动');
    this._status(`烧录完成：${fBytes(done)} → ${board.name}（RISC-V/JTAG）`, 'ok');
    this._log(`小结：${fBytes(done)} · 校验${verify ? '开' : '关'} · 复位${doReset ? '开' : '关'} · ` +
      `JTAG 批次 ${jtag.summary().batches} 次 / ${jtag.summary().bytes} B · ` +
      `flash ${(chipInfo.totalBytes / 1048576).toFixed(2)} MB / 扇区 ${chipInfo.sectorBytes} B`);
  }

  async _flashBridge(name, pathText){
    const useJlink = $('f-backend').value === 'jlink';
    this._bar(50);   // 桥烧录拿不到流式进度，只能示意
    this._status(useJlink ? '桥烧录中…（J-Link Commander 完成后一次性返回结果）'
                          : '桥烧录中…（OpenOCD 完成后一次性返回结果）');
    this.bc = new BridgeClient($('f-bridge-url').value);
    await this.bc.connect({ version: 1 });
    const cfg = {
      target: $('f-chip').value,
      verify: $('f-verify').checked,
      reset: $('f-reset').checked,
      /**
       * J-Link 这条路由桥自己起 JLink.exe 烧（见 bridge/rtt-bridge.mjs 的 jlinkFlash）：
       * 桥会**先停掉 RTT 会话**再烧 —— J-Link 同一时刻只允许一个持有者，两个进程一起抢
       * 会直接连不上探针（跟 WebUSB 那边"谁占着调试器"是同一类问题）。
       */
      ...(useJlink ? { backend: 'jlink' } : {}),
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
  _status(s, kind){ setStatus($('f-status'), s, kind); }
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
