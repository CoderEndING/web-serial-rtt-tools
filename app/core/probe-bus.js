/**
 * 跨标签页的「探针占用」协调（BroadcastChannel）。
 *
 * 为什么必须有这一层（2026-10 真机复现）：
 *   同一个浏览器里，两个标签页同时抓着同一台探针时 ——
 *     · WebHID（配置/引擎）可以两边都开着，互不报错；
 *     · 但 **WebUSB 的接口只能被一个连接认领**，第二个页签拿到的是
 *       `Unable to claim interface`，而且 `device.reset()` 也救不回来
 *       （实测：占用方在浏览器进程里还活着 → reset 直接回 "Unable to reset the device"）。
 *   探针**物理上只有一套 JTAG/调试引擎**，两个页签同时用本来也是错的：
 *   烧录时另一个页签还在轮询目标内存，轻则每条 DMI 都跟它抢（慢十倍），
 *   重则认领失败直接烧不动。以前只能靠"用户自己去关掉另一个页签"。
 *
 *   现在改成**抢之前先喊一嗓子**：请求方广播 `release`，别的页签收到就把自己的
 *   探针会话收干净（断开 RTT / 停采样 / 关数据端点）并回 `released`。
 *   请求方等一小会儿（有回应就提前结束）再去认领 —— 大部分情况下这一下就够。
 *
 * 设计约束：
 *   · **不能阻塞太久**：没人应答时最多等 `settleMs`（默认 250 ms）；
 *     有同伴但还没回时最多等 `waitMs`（默认 1200 ms）。
 *   · 浏览器没有 BroadcastChannel（老浏览器/无头环境）时**静默降级**成空操作，
 *     绝不让协调层成为新的失败点。
 *   · 只在同源页签之间生效（BroadcastChannel 的天然边界），正合适。
 */

export const PROBE_BUS_CHANNEL = 'web-serial-rtt-tools/probe-bus';
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 探针的 VID（akaLinkPro / DAPLink 都是 0x0d28） */
export const PROBE_VID = 0x0d28;

/**
 * 把本页签手里**所有**指向探针的 WebUSB 连接关掉 —— 包括"引用已经丢了"的那种。
 *
 * 🚨 这一步是跨页签让出探针的关键（2026-10 真机定点实验）：
 *    接口认领挂在 USBDevice 连接上；页面只是丢了 JS 引用、没调 `close()` 时，
 *    浏览器仍然认为接口被占着，别的页签每次 `claimInterface` 都失败（`reset()` 也救不回），
 *    要等垃圾回收才莫名好转 —— 表现就是"有时候能用、有时候认领不上"。
 *    实测：补一次 `close()`（哪怕那个对象 `opened` 已经是 false）→ 接口立刻可被认领。
 *    `navigator.usb.getDevices()` 对同一台设备返回的是**同一个** USBDevice 实例，
 *    所以这里拿到的正是那个僵尸连接，关得掉。
 *
 * @returns {Promise<number>} 实际关掉了几个
 */
export async function closeProbeUsbDevices(vid = PROBE_VID){
  if (typeof navigator === 'undefined' || !navigator.usb?.getDevices) return 0;
  let n = 0;
  try {
    for (const d of await navigator.usb.getDevices()){
      if (d.vendorId !== vid) continue;
      try { await d.close(); n++; } catch { /* 已经关了/设备不在了，都无所谓 */ }
    }
  } catch { /* 枚举不到就当没有 */ }
  return n;
}

export class ProbeBus {
  /**
   * @param {string} name 本页签的名字（日志/排障用；同一页面多个实例也能区分开）
   */
  constructor(name = 'page'){
    this.name = name + '-' + Math.random().toString(36).slice(2, 7);
    this.peers = new Set();
    this.log = null;                 // (s:string)=>void 可选
    /** 收到别人"让出探针"时要做的事（返回 Promise）。没设 = 本页签本来就不占探针 */
    this.onRelease = null;
    this._acked = 0;
    this._channel = null;
    try {
      if (typeof BroadcastChannel === 'function'){
        this._channel = new BroadcastChannel(PROBE_BUS_CHANNEL);
        this._channel.onmessage = e => this._on(e.data);
        this._post({ t: 'hello' });
      }
    } catch (e){
      this._channel = null;          // 老浏览器：降级成空操作
    }
  }

  get supported(){ return !!this._channel; }

  _post(m){
    try { this._channel?.postMessage({ ...m, from: this.name, at: Date.now() }); } catch { /* 关掉了就算了 */ }
  }

  _on(m){
    if (!m || m.from === this.name) return;
    switch (m.t){
      case 'hello':
        this.peers.add(m.from);
        this._post({ t: 'here' });
        break;
      case 'here':
        this.peers.add(m.from);
        break;
      case 'release':
        this._post({ t: 'releasing' });
        this.log?.(`另一个页签要占用探针（${m.why || '未说明'}），本页先让出来`);
        // 无论成功失败都回执：请求方只关心"你还在不在占着"，不关心你的错误
        Promise.resolve()
          .then(() => this.onRelease?.(m.why || ''))
          .catch(() => {})
          .then(() => { this._post({ t: 'released' }); });
        break;
      case 'released':
        this._acked++;
        break;
      default:
        break;
    }
  }

  /**
   * 请别的页签让出探针。
   * @returns {Promise<{supported:boolean, asked:number, acked:number, ms:number}>}
   *   asked = 认识的同源页签数；acked = 实际回执"已让出"的个数
   */
  async requestRelease({ why = '', settleMs = 250, waitMs = 1200 } = {}){
    if (!this._channel) return { supported: false, asked: 0, acked: 0, ms: 0 };
    const t0 = Date.now();
    this._acked = 0;
    this._post({ t: 'release', why });
    // 先等一下 'here' 回执：一个同伴都没有就别干等
    await sleep(settleMs);
    while (Date.now() - t0 < waitMs && this._acked < this.peers.size) await sleep(40);
    return { supported: true, asked: this.peers.size, acked: this._acked, ms: Date.now() - t0 };
  }

  close(){ try { this._channel?.close(); } catch {} this._channel = null; }
}
