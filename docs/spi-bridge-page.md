# USB → SPI/QSPI 桥页（`#spi` + `#panel`）方案

> 页面：`index.html` 新增第 8、9 个标签页 —— **`#spi`「SPI/QSPI 桥」** 与 **`#panel`「SPI/QSPI 屏」**（工作目录本仓库）
> 对端固件：`E:\Share\github\akaLinkPro` 分支 `feature/usb-spi-bridge`（HEAD `aedb705`，P1 已完成）
> 协议真源：`firmware/application_5301/src/spi_bridge/spi_bridge_proto.h`（+ `spi_bridge.c` 实现）
> 硬件方案：`E:\Share\github\akaLinkPro\docs\usb-spi-bridge-plan.md`
> 状态：**P1 已落地**（2026-09-29，未上板）；页面在用户建议下拆成"桥 / 屏"两页，见 §0 第 10 条与 §11.2。

---

## 0. 已拍板（2026-09-29 用户决策）

| # | 事项 | 结论 |
|---|---|---|
| 1 | v1 范围 | **控制台 + 面板初始化表 + 图片刷屏**，分 4 阶段实施（§11） |
| 2 | 上板条件 | **暂时不能上板** → 先把「假探针 + 离线自测」做完整；真机验收脚本提前写好，等板子 |
| 3 | 图片输入 | **BMP + PNG/JPEG**（BMP 自己解析，PNG/JPEG 走浏览器 `createImageBitmap`） |
| 4 | 面板表素材 | **内置两套现成表**（AXS15352 / ST77916）+ JSON / C 片段导入导出 |

**细项（2026-09-29 第二轮拍板）**

| # | 事项 | 结论 |
|---|---|---|
| 5 | 标签页名字 | **`SPI/QSPI 屏`**（`data-tab="spi"`） |
| 6 | SCLK 档位 | **10 / 20 / 40 / 60 / 75 MHz**（5301EVKLite 最高 75 MHz；页面同时显示固件回读的**实际生效**值） |
| 7 | TE 撕裂信号 | **先不做**（读电平 + 等 TE 同步刷屏一律 TBD）；`pad_te` 字段保留在协议层，页面暂不暴露配置 |
| 8 | 帧脚本/面板表持久化 | **先不做**（localStorage 存档留 TBD）；P1 只做单发帧 |
| 9 | README / 截图 | **等 P4 一起改**（P1~P3 期间只在本文档与本页里体现） |
| 10 | 页面拆分（2026-09-29 第二轮反馈："目前这个 web 有点繁重"） | **拆成两页**：`#spi`「SPI/QSPI 桥」= 通用链路（配置 / 通用帧 / 回环自检 / 统计）；`#panel`「SPI/QSPI 屏」= 调屏（面板档 / 初始化步 / 初始化表 / 刷图）。两页**共用同一个 `SpiSession`**（一次连接，跟"串口助手/终端共用一个串口会话"同理） |
| 11 | 屏页内容（2026-09-29 第三轮反馈："有各种内置图案+可以选择图片的功能，还有一个大大的初始化面板，我可以把初始化代码贴进去"） | ① **面板初始化 = 一个大文本框**：贴 C 数组（主格式，也认纯文本行与 JSON）→ 解析成步骤表 → 重放 / 单发 / 从此重放；内置两套示例（**存的是原始 C 文本**，跟"你自己贴"走同一条解析路径）。② **图片 / 图案**：18 种内置图案 + 拖入 BMP/PNG/JPEG → 预览（量化后的样子）→ 开窗 + 527 片下发。③ 像素字节序给 **R/B 交换**开关，默认 RGB565 高字节在前 |

---

## 1. 结论摘要（先看这个）

| 议题 | 结论 | 依据 |
|---|---|---|
| 页面形态 | 本仓库第 8 个标签页 `#spi`，模块化（`app/spi/*`），不是单文件页 | 与 `#scope`/`#flash` 同构；单文件页（参考页那套）在本仓库没有先例 |
| 控制面 | 复用 `app/hid/probe.js` 的 `AkaLinkHid`，新增 `CMD 0x35` 的组包/解析 | §2.2 |
| 数据面 | 新写 `app/spi/transport.js`：WebUSB 认领 **vendor 接口（class 0xFF + EP11 双向）**，OUT `0x0B` 发帧、IN `0x8B` 收应答 | §2.2 §5 |
| 打包粒度 | **一帧不跨 512 B 包**；小帧按包攒批（一次 `transferOut` ≤ 511 B 的短包）、大帧一帧一包；两个方向各 4~8 条在飞 | §2.3 §5.2 |
| 面板表 | 网页是**唯一真源**（探针无状态）：行 `{cmd, data[], delay_ms}` → 一条 `STEP` 帧；表可编辑/导入/导出 | §7 |
| 图片通路 | 拖图 → canvas → RGB565（高字节在前）→ 按 **492 B** 切片 → `XFER`（每片自带 opcode+地址，末片带 RSP） | §8 |
| 离线自测 | **假探针**（同一对象既当 HID 又当 bulk 执行器，含回环与故障注入）→ 无硬件跑通整条链路 | §6 §9 |
| 真机验收 | 最后阶段：`make spi-hw`（回环跳线长度扫描 + 4 线回环 + 可选实屏） | §9.3 |
| 不碰的东西 | 不改固件（只回馈两处注释订正）；不做 TE 同步刷屏、背光 PWM、多设备并发 | §12 |

**吞吐量级**（固件方案 §6.3 的推算，网页侧待实测）：单线 20 MHz ≈ 2.5 MB/s；四线 40 MHz ≈ 20 MB/s。
259 KB 的 ST77916 整屏 ≈ 527 帧 × 492 B，理论上十几毫秒，**USB 侧与主循环侧谁先撞墙要上板才知道**。

---

## 2. 已核实的事实（不是推测）

### 2.1 端点与接口（描述符侧）

| 项 | 值 | 出处 |
|---|---|---|
| 新接口 | vendor specific（class `0xFF`），`bNumEndpoints = 2` | `usb_composite.c` 的 `SPI_BRIDGE_DESC()` |
| OUT | `SPI_OUT_EP = 0x0B`（**EP11 OUT**），bulk，512 B | `usb_composite.h:35` |
| IN | `SPI_IN_EP = 0x8B`（**EP11 IN**），bulk，512 B | `usb_composite.h:34` |
| 接口号 | `SPI_INTF_NUM = HID_INTF_NUM + CONFIG_CHERRYDAP_USE_CUSTOM_HID`（EVKLite 构建下 = 4），**网页不硬编码，按特征找** | `usb_composite.c:66-71` |
| 构建门控 | **只在 HPM5301EVKLite 构建里有**：`BOARD_HAS_SPI_BRIDGE`（EVKLite = 1，akaLinkPro = 0） | `boards/*/board.h` |
| 同设备的其它 0xFF 接口 | WebUSB 平台接口（class `0xFF`、**0 个端点**）→ 不能用"class 0xFF"单独认接口 | `usb_composite.c:341` |

> ⚠️ **两处必须按实测代码走、不能照 proto.h 注释的字面**（见 §10.1）：
> 1. `cs_policy` 的真实语义是 `0/2 = PA26 作 GPIO CS（软件拉/放）`、`1 = 辅助脚作 GPIO CS`、`3 = 硬件 CS0`（`spi_bridge.c:483-499`）；proto.h 的注释写成"0=硬件 CS0 自动；1=辅助 CS 自动；2=手动"，与实现不符。
> 2. STATUS 的计数器顺序：`res[36] = 实际 SCLK`、`res[40] = frames_err`（`spi_bridge.c:1469-1481`），与 `sb_stats_t` 结构体顺序（`frames_err` 排第二）不符。

### 2.2 HID 控制面 `0x35`（响应形状按实现核对过）

请求 `req[2] = 0x35`、`req[3] = action`、`req[4..] = 参数`；响应 `res[1] = Data Length`、`res[2] = 0x35`、`res[3] = action` 回显。

| action | 名称 | 请求 | 响应（`res` 偏移） |
|---|---|---|---|
| 0 | `STATUS` | — | `[4..7]` 状态字 + 9 × u32：`frames_ok(8) bytes_tx(12) bytes_rx(16) tx_poll(20) tx_dma(24) out_ovf(28) in_drop(32) actual_sclk(36) frames_err(40)`，`res[1]=44` |
| 1 | `ENABLE` | `[4]` 0/1 | `[4..7]` 状态字，`res[1]=8` |
| 2 | `RESET` | — | 清环/清计数器，`[4..7]` 状态字 |
| 3 | `SET_CFG` | `[4..35]` = 32 B 配置块 | `[4..7]` 状态字（非法 → 错误码 `SB_E_RANGE`） |
| 4 | `GET_CFG` | — | `[4..35]` = 32 B 配置块，`res[1]=36` |
| 5 | `PIN_CFG` | `[4]=line [5]=pad 索引 [6]=有效电平` | `[4..7]` 状态字（quad 用了 PA30/31 会被拒） |
| 6 | `ABORT` | — | `[4..7]` 状态字 |
| 7 | `SET_PROFILE` | `[4..19]` = 16 B 面板档块 | `[4..7]` 状态字（非法值被夹取） |
| 8 | `GET_PROFILE` | — | `[4..19]` = 16 B 面板档块，`res[1]=20` |

配置块（32 B）：`sclk_hz(u32) mode bits cs_policy tx_dma_threshold pad_dc pad_rst pad_cs_aux pad_bl pad_active_low pad_te flags reserved0 out_ring_kb(u16) in_ring_kb(u16) max_frame_bytes(u16) reserved[10]`。
默认值（`spi_bridge.c:1365-1382`）：`sclk_hz=0`（→ 板级 20 MHz）、`threshold=100`、DC=PB11、RST=PB12、CS_AUX=PB10、BL=PB13、TE=PB10、`pad_active_low=0x06`（RST + CS 低有效）。

面板档（16 B）：`profile def_lines dc_active_high cs_hold_in_step qspi_wr_opcode qspi_color_opcode qspi_addr_bytes flags reserved[8]`；`profile`：`0=raw 1=spi_dcx 2=qspi`。

pad 索引表（0~13）：无 / PB11 / PB12 / PB13 / PB10 / PA02 / PA09 / PA00 / PA01 / PY00 / PY01 / PA10 / PA30 / PA31。

错误码：`0 OK, 1 DISABLED, 2 BAD_MAGIC, 3 BAD_FRAME, 4 RANGE, 5 TIMEOUT, 6 IN_FULL, 7 DMA, 8 BUSY, 9 GPIO`。

### 2.3 数据面语义（固件实现逐行看过）

1. **一帧不跨 USB 包**（主机侧纪律）：固件按"一次 OUT 回调 = 一个包"为单位解析，包内可含多帧。
2. **尾部残渣**：包尾不足 8 B（或放不下一整帧）时**静默丢弃、不计错**（`spi_bridge.c:1085-1089`）；但若剩余 ≥ 8 B 且 magic 不对 → `frames_err++`（`SB_E_BAD_MAGIC`）。→ **打包器绝不能产生 ≥ 8 B 的填充**，收尾只能靠"短包"或恰好放满。
3. **轮询预算**：`SB_POLL_MAX_FRAMES = 8`、`SB_POLL_MAX_BYTES = 2048`（`spi_bridge.c:92-93`）→ 每轮主循环最多吃 8 帧 / 2 KB，剩下的下一轮。
4. **环**：OUT 32 槽 × 512 B = 16 KB，IN 16 槽；**未使能时不 arm OUT 端点**（主机写会 NAK，天然背压）。
5. **RSP**：只有带 `SB_F_RSP` 的帧才产生 IN 应答；不带 RSP 的帧出错时发 `EVT`（`0x82`）。**读数据（`rx_len ≠ 0`）必须带 RSP**，否则 `SB_E_BAD_FRAME`。
6. **全双工要求收发等长**：`wlen != 0 && rlen != 0 && wlen != rlen` → `SB_E_RANGE`（`spi_bridge.c:527-530`）。回环自检必须 tx_len == rx_len。
7. **P1 全部走轮询**：`tx_dma_cnt` 恒为 0（`spi_bridge.c:585-588`），DMA 是固件 P2 的事 → 页面上"阈值/DMA"在 P1 固件下只是占位，**必须如实标注**，不能让用户以为在跑 DMA。
8. **延时非阻塞**：`DELAY` / `STEP.delay_ms` / `RESET` 都只登记"下一个允许执行的时刻"，期间主循环照常（DAP/RTT/Scope 不受影响）。
9. `dummy` 字段 1..4 → 驱动写 `dummy_cnt = dummy - 1`；`0` = 不发 dummy。

### 2.4 素材：两块屏的初始化表（可脚本提取，不需要手抄）

| 屏 | 文件 | 规模 |
|---|---|---|
| 天马 2P01 / AXS15352（240×296，4 线 SPI + DC） | `E:\esp-idf-wsh\projects\spi_lcd_axs15352\main\axs15352_init_cmds.h` | 30 条（带参数 28 条、带延时 1 条），`{cmd, data[], nbytes, delay_ms}` |
| ST77916（圆屏 360×360，QSPI） | `E:\esp-idf-wsh\projects\qspi_lcd_st77916\main\st77916_init_cmds_ch32.h` | 192 条 / 215 参数字节 / 累计 120 ms |

两份都是 `{cmd, (uint8_t[]){...}, len, delay_ms}` 的 C 数组，**用 Node 脚本正则提取 + 自测对账**（条数/总字节/逐行哈希），跟「工程生成」页 `templates.js` 的逐字节移植同一套纪律。
另有 `E:\esp-idf-wsh\资料\panel_init\dumps\st77916.json`（含接口/时序元数据）可作交叉校对。

### 2.5 仓库里可直接复用的东西

| 用途 | 现成模块 | 复用方式 |
|---|---|---|
| HID 0x35 客户端 | `app/hid/probe.js`（`AkaLinkHid.xfer`） | 直接用；新增 `spi(action, data)` 便捷方法 |
| WebUSB bulk 传输 | `app/scope/transport.js` | **同形新写**（它只做 IN；这里要 IN+OUT），但把"接口发现 / 认领失败退避 / 无取消接口的收尾纪律"照抄 |
| 短等待纪律 | `app/core/pace.js`（`yieldTask` / `waitMs`） | 页面里**不许用 `setTimeout` 做 ≤128 ms 的轮询等待**（页面不可见时会被钳到 1 s） |
| 跨页签协调 | `app/core/probe-bus.js` + `main.js` 的 `probeBus.onRelease` | 新页面接入：别人要占用探针时让位；本页也要能"要求别人让位" |
| 页面骨架/小工具 | `app/ui/dom.js`（`$`/`seg`/`setStatus`）、`app/ui/toast.js` | 直接用 |
| 页面自测骨架 | `tools/selftest/scope-page.test.mjs`（CDP + 真页面对象） | 照抄结构 |
| 参考交互设计 | `E:\esp-idf-s31\projects\spi_lcd_bmp\tools\bmp_sender.html` | **只借鉴交互**，见 §3 |

---

## 3. 与参考页 `bmp_sender.html` 的关系

**借鉴（好东西直接学）**

- 面板初始化表的**表格编辑器**：每行 `# / 命令 / 长度 / 延时 / 数据（每格一字节）`，行尾 `+` / `−` 加减字节，`单发` / `从此重放`。
- **位编辑器**：点某个字节弹出 8 个 bit，点一下翻转（省掉手算字段值），与本行原值不同的位标黄。
- **常驻操作条**：发送/中止 + 进度/速率/耗时 吸顶，"这一下会发什么"摘要写在第二行。
- 内置图案（纯色/色条/棋盘/渐变）+ **灰阶（电平）** 这种"不用准备素材就能试屏"的小工具。
- 屏幕预览画布上标出"图片实际落点（实线）/ 板子真正下发的对齐窗口（虚线）"。
- 导出 C 片段 / JSON 导入导出、快捷键 `Ctrl+Enter`。

**不一样（这次必须换掉的地方）**

| 维度 | 参考页（ESP32 工程） | 本页（探针 SPI 桥） |
|---|---|---|
| 链路 | Web Serial（COM 口）+ 自定义 `BMPX` 帧 | **WebHID 控制面 `0x35` + WebUSB bulk 帧流**（两条管道，顺序性只由 bulk 保证） |
| 表在哪 | **板子里内置**原表 → 可"读回原表"、按行指纹对账改动 | **探针无状态**：网页是唯一真源；没有"读回"，只有本地编辑 + 导入导出 |
| 帧上限 | 单帧 32 KB（板子侧缓冲） | **一帧 ≤ 504 B，且不跨 512 B 包** → 必须自己做打包器（§5.2） |
| 面板处理 | 板子按固定表 + `SET_POS`/`IMG_*` 语义 | 探针只认 `STEP`/`XFER`，**DC 翻转、QSPI opcode+24 bit 地址全由"面板档"在固件里展开**，网页只需选档 + 下行 |
| 屏 | 一块（AXS15352 240×296） | 两块（AXS15352 4 线 SPI+DC / ST77916 QSPI 360×360），档位 1 与档位 2 |
| 图片 | 只 BMP（16/24bpp） | BMP + **PNG/JPEG**（浏览器解码） |
| 无硬件时 | 无（必须插板子） | **假探针**：整条链路 + 故障注入都能离线跑（§6） |

---

## 4. 页面结构（两页 + 一层共享会话）

```
index.html  ──  <button class="tab" data-tab="spi">SPI/QSPI 桥</button>
                <button class="tab" data-tab="panel">SPI/QSPI 屏</button>
                <section class="panel" id="tab-spi"> …   ← 通用链路（配置/通用帧/回环/统计）
                <section class="panel" id="tab-panel"> … ← 调屏（面板档/初始化步/表/刷图）
app/main.js ──  const spiSession = new SpiSession();          ← **一次连接，两页共用**
                new SpiBusView(spiSession) / new SpiPanelView(spiSession)
                注册 init()/onShow()/summary()，接入 probeBus.onRelease
```

```
app/spi/
  protocol.js   协议唯一真源的 JS 镜像（帧/HID/档/错误码/pad 表）+ 打包器 + 应答切包/配对  ← 纯函数，Node 可测
  transport.js  数据面：WebUsbSpiTransport（claim vendor 接口，EP11 in/out，读写各 N 条在飞）
                + MockSpiTransport（把帧交给假探针执行）
  mock.js       假探针：HID 0x35 语义 + bulk 帧执行（XFER 回环 / STEP 展开 / 计数器…）+ 故障注入
  session.js    **共享会话**：连接、协议收发、配置/档位/状态读写、统计、日志 ring、订阅广播（不碰 DOM）
  bus-view.js   桥页视图：配置 / 辅助脚 / 使能与状态 / 通用帧 / 回环自检 / 日志 / 统计
  panel-view.js 屏页视图：面板档 / 按屏套用推荐值 / 快捷面板步 / 复位与显示 / 只读摘要 / 日志
  panels.js     内置面板表（脚本从 C 头文件提取的产物）+ 表模型（行增删改、JSON/C 片段导入导出）  ← P2
  image.js      图片 → RGB565：BMP 解析 + createImageBitmap 通路 + 缩放/裁剪/对齐 + 切片         ← P3
```

**为什么要那一层 `session.js`**：拆页之后"连接探针 / 连接数据端点 / 用假探针"只该做一次。
会话层持有硬件状态并广播（`subscribe()` → `onSession(type, payload)`），两个视图各自渲染自己的表单 ——
这跟「串口助手 / 终端」共用同一个串口会话是同一个模式。**会话层不碰 DOM**，否则两页会互相覆盖输入框。

**`#spi` 桥页的 UI**（左侧栏 = 设置，右侧主区 = 操作，底部 = 统计）
- 左栏：① 探针连接（`连接探针` / `重连` / `连接数据端点` / ☑ `用假探针` / 在飞读条数）② 桥配置（SCLK 档位 **10/20/40/60/75 MHz** + "板级默认(0)"、模式 0~3、CS 策略、DMA 阈值、`ENABLE 时清环`）③ 辅助脚 DC/RST/CS_AUX/BL + 有效电平位图（**TE 暂不暴露**）④ 使能 / 复位 / 中止 / 读状态 + 状态字 + 计数器 + 实际 SCLK
- 主区：① 通用帧控制台（`XFER` 表单 + `CS`/`GPIO`/`DELAY`/`PING`/`AUX_IN` 单发）② 回环自检（长度扫描 × 线数 × 轮询/强制 DMA 对照，结果进表格）③ 帧流水日志 ④ 统计条

**`#panel` 屏页的 UI**
- 左栏：① 探针（**与桥页共用会话**，两页都能连）② 屏型号与推荐值（AXS15352 / ST77916 → 一键套用档位 + SCLK + DC/RST/BL）③ 面板档（profile 七件套）④ 当前生效（只读摘要：SCLK / CS 策略 / 辅助脚 / 档位）+ 使能/失能
- 主区：① 快捷面板步（一条 `STEP`：cmd + 参数 + 延时）② 复位 / 显示（`RESET` 帧、`11h+29h`）③④ P2/P3 的占位卡片（面板初始化表、图片刷屏）⑤ 日志 ⑥ 统计条
- 基础配置（SCLK / 模式 / CS 策略 / 通用辅助脚 / 回环自检）**不在这里**，留在桥页 —— 免得同一件事两个地方都能改

---

## 5. 协议层设计（`app/spi/protocol.js`）

### 5.1 纯函数清单（Node 自测直接打）

```js
frame(type, payload, {flags, seq})            // → Uint8Array（8 B 头 + payload），>504 抛错
xferPayload({cmd, tcfg, addrLen, dummy, tx, rxLen, addr})   // 12 B 头 + tx
stepPayload({cmd, params, delayMs})           // u8 cmd, u8 nparams, u16 delay_ms, params[]
resetPayload({lowMs, postMs}) / delayPayload(us) / gpioPayload(line, level) / csPayload(assert)
packFrames(frames[], maxPacket = 512)         // → 一次 transferOut 的若干"包"（见 5.2）
parseRsp(u8)                                  // → {type, status, seq, data} | null
cfgEncode/Decode, profileEncode/Decode        // 32 B / 16 B 结构块
STATUS / ERR / PAD / PROFILE 常量与中文名
statusWord(u32) → {enabled, active, cs, inFlow, outFull, lastErr}
```

### 5.2 打包器（`packFrames`）—— 一帧不跨 512 包

规则（固件 `sb_process_packets` 的实际语义）：

- 累加帧，**若加入下一帧会超过 512 B → 当前组到此为止**，作为一次 `transferOut`（总长 ≤ 511 B，USB 侧是短包，固件解析到包尾正好干净结束）。
- **绝不填充**：剩余 ≥ 8 B 的填充会被当成帧头 → `frames_err++`。
- 收益：AXS15352 的 30 条 ≈ 0.8 KB、ST77916 的 192 条 ≈ 3~5 KB → **十几次 USB 往返**就下完（不分包的话是 200+ 次）。
- 图片帧（492 B payload + 8 B 头 = 500 B）→ 一帧一包，没有攒批空间；提速靠**多条 `transferOut` 在飞**（默认 4，可调）。

### 5.3 在飞与收尾纪律（`transport.js`）

1. **OUT**：维护 N 条在飞（默认 4）；写失败/超时即标脏设备；固件 OUT 环满时会 NAK → 表现为写挂起，**必须有超时**。
2. **IN**：保持 4 条 `transferIn(4096)` 在飞；按 8 B 头切包解析，按 `seq` 与在飞请求配对；`EVT(0x82)` 进错误日志。
3. **收尾**：WebUSB **没有取消接口** → `stop()` 必须先停发、再等在飞读写自己回来（照抄 `app/scope/transport.js` 的做法），否则残留的读会偷走下一场的应答。
4. **认领失败**：`Unable to claim interface` → 端口复位重试一次 → 仍失败给出"检查别的页签/OpenOCD/J-Link"的清单（照抄 scope 的文案思路）。
5. **SPI 桥接口找不到** → 明确报"这块固件没有 SPI 桥（EVKLite 构建才有）"，并列出设备实际暴露的端点（照抄 scope 的诊断输出）。

### 5.4 错误与统计

- 每个带 RSP 的请求有超时（默认 1 s，可调）；超时记为"丢应答"，**不静默**。
- 页面统计四类：协议层（`frames_ok/err`、`in_drop`、`out_ovf`，来自 HID `STATUS`）、传输层（在飞、写失败、超时）、应用层（本次任务已发字节/帧/耗时/速率）、告警（最近错误码 + 中文解释）。

---

## 6. 假探针（`app/spi/mock.js`）—— 没有硬件也能跑通整条链路

一个对象同时扮演两个角色（与 `#scope` 页 `MockScopeProbe` 同一思路）：

- **HID 侧**：`xfer(cmd, data)` 实现 `0x35` 的 9 个 action（配置读写/使能/状态/计数器/profile/pin），并模拟"实际 SCLK = 分频后的值"（照 `sb_pick_sclk` 的整除规则算，让页面能试显示）。
- **bulk 侧**：接收"包"，按固件同样的规则解析（含 8 B 头校验、尾部残渣丢弃、magic 错 → `frames_err++`），执行帧：
  - `XFER`：**回环模型**（tx 原样作为 rx 返回），可注入"位错/丢字节"；
  - `STEP`：按当前档位展开（档 1 = 命令 + 翻 DC + 参数；档 2 = `wr_opcode` + 24 bit 地址 + 参数）→ 产出**线上字节流**供自测逐字节对账（这是离线验证"档位展开对不对"的关键手段）；
  - `CS/GPIO/DELAY/RESET/AUX_IN`：改内部引脚状态 + 时间戳；`DELAY` 记录非阻塞调度。
- **故障注入**（自测错误路径用）：`in_full`、`bad_magic`、`timeout`、`drop_rsp`、`disabled`。
- **在飞/包序**：记录每个"包"的字节与帧边界 → 自测可断言"没有任何一帧跨包""没有 ≥8 B 的填充"。

页面开关：☑ `用假探针`（并把 HID 与 bulk 指向**同一个** mock 实例 —— 这是 `#scope` 页踩过的坑：两个实例会造出"配置发给 A、数据从 B 出来"的假象）。

---

## 7. 面板档与面板初始化表

- 表行的模型：`{ cmd: u8, data: u8[], delayMs: u16 }`（**灵活长度**，加/减字节不动协议）。
- 每行 → 一条 `STEP` 帧：`u8 cmd, u8 nparams, u16 delay_ms, params[]`。
- 档位语义（固件 `spi_bridge.c:744-801`）：
  - `raw(0)`：一次 `XFER`，cmd + params 同线数（`def_lines`）；
  - `spi_dcx(1)`：同一 CS 窗口内 `DC=命令 → 发 8 bit cmd → 翻 DC=数据 → 发 params`（AXS15352）；
  - `qspi(2)`：`cmd = qspi_wr_opcode(0x02)` → 24 bit 地址 = `面板命令字 << 16` → 1 线 params（ST77916）。
- 两套内置表 + 对应档位参数（页面"一键套用"）：
  | 屏 | profile | 关键参数 | 表规模 |
  |---|---|---|---|
  | AXS15352 / 天马 2P01 | `spi_dcx` | `dc_active_high=1`、`cs_hold_in_step=1`、SCLK 20~40 MHz、DC=PB11 / RST=PB12 / BL=PB13 | 30 条 |
  | ST77916 | `qspi` | `wr=0x02`、`color=0x32`、`addr_bytes=3`、SCLK 40 MHz | 192 条 |
- 导出：JSON（人看/再导入）、C 片段（贴回 `*_init_cmds.h`）、**帧序列十六进制**（可直接粘进 `script_test/spi_bridge_test.py` 做对照）。
- 与参考页的差别：没有"读回原表"和"行指纹对账"（探针无状态），改为"当前表 = 编辑区"，但保留"撤销全部修改 / 从内置表恢复"。

---

## 8. 图片通路（`app/spi/image.js`）

```
拖入 BMP/PNG/JPEG
  → 解码：BMP 自己解析（16/24bpp，BI_RGB / BI_BITFIELDS）；其余走 createImageBitmap
  → 画进离屏 canvas（目标尺寸 = 屏尺寸；缩放/裁剪/居中/边缘钳位）
  → getImageData → RGBA
  → RGB565（R5 G6 B5）→ **高字节在前**（探针字节透明，字节序由主机负责）
  → 开窗（按档位拼 CASET/RASET 那几条帧）+ 按 492 B 切片
  → 每片：XFER{cmd=color_opcode, addr_len=3, addr=RAMWR<<16, lines=4, tx=片}  （QSPI 档）
         或 XFER{dc_en, dc_level=1, tx=片}                                  （SPI+DC 档）
  → 只有最后一片带 RSP（避免 IN 流量拖慢灌数据）
```

细节纪律：

- **切片 492 B 上限**（`504 - 12`）；每片自带 opcode+地址（CS 每片一收一放），与参考页"每 chunk 都重发命令"同理。
- **x 4 像素对齐**（AXS15352 需要）：预览里画"实际落点（实线）/ 对齐窗口（虚线）"，多补的像素用边缘钳位填（参考页验证过的做法）。
- 灰阶/电平、内置图案、`整屏填充`、`Ctrl+Enter` 发送照参考页保留。
- 颜色顺序（RGB vs BGR）做成可选项：屏的 MADCTL 不同 → 给一个 `R/B 交换` 勾选，避免"颜色对不上只能改固件"。

---

## 9. 自测与验收（三档，前两档现在就能跑）

### 9.1 Node 纯函数（进 `make test`）

`tools/selftest/spi-proto.test.mjs`（**已落地，79 项全绿**）：

- 帧编解码往返；`>504` 拒绝；`packFrames` **断言没有任何一帧跨 512 包、没有 ≥ 8 B 填充**；
- HID 0x35 组包/解析：`GET_CFG`/`GET_PROFILE`/`STATUS` 的**字节偏移逐个钉死**（对着固件 `spi_bridge.c` 的行号写在测试注释里）；
- 面板表：内置两套表的条数/字节数/逐行哈希对账（对着 C 头文件）；
- 档位展开：档 1 / 档 2 的**线上字节流金样例**（如 `STEP{0xCE,[5A A5]}` → `DC0 CE DC1 5A A5`；`STEP{0xF0,[28]}` → `02 00 00 F0 28`）；
- 图片：小图（4×2 棋盘）→ RGB565 的**逐字节金样例**（含高低字节序、对齐补边）。

### 9.2 页面端到端（CDP 真页面 + 假探针，`make test-spi-page`）

`tools/selftest/spi-bus-page.test.mjs`（桥页，**41 项全绿**）与 `tools/selftest/spi-panel-page.test.mjs`（屏页，**33 项全绿**），骨架照 `scope-page.test.mjs`：

开假探针 → 连接 → 写配置并回读核对 → 选档 → `ENABLE` → 重放内置面板表（断言假探针收到的**帧数与字节流**）→ 刷一张 96×96 图（断言切片数/末片带 RSP/无 frames_err）→ `STATUS` 计数与页面显示一致 → 注入 `in_full`/`bad_magic` 看错误路径是否如实显示 → `ABORT`/`RESET` 收尾。

### 9.3 真机（**已跑通**，2026-09-29 —— 屏点亮）

`tools/selftest/spi-hw.mjs`（`make spi-hw`）——CDP 驱动真页面 + 真探针，设备选择框自动应答：

```bash
make spi-hw                                # 默认 AXS15352 / 40 MHz
make spi-hw ARGS="--sclk=20,40,60,75"      # 逐档 SCLK 对比吞吐
make spi-hw ARGS="--panel=st77916"         # 换 ST77916（档 2，QSPI）
make spi-hw ARGS=--loop                    # 先跑回环自检（要 J3[19]↔J3[21] 跳线）
```

实测（天马 2P01 / AXS15352：面板初始化 32 帧 + 整屏 292 帧，**全部零错误，屏上出 8 条彩条**）：

| SCLK | 整屏 240×296×2（142 KB） | 吞吐 |
|---|---|---|
| 20 MHz | 67 ms | 2.01 MB/s |
| **40 MHz**（推荐） | **43 ms** | **3.15 MB/s** |
| 60 MHz | 37 ms | 3.71 MB/s |
| 75 MHz | 39 ms | 3.47 MB/s |

探针侧 Python 基线是 40 MHz 4.22 MB/s、60/75 饱和 ~4.7 MB/s；浏览器侧每帧多一层 IPC，差约 25%。
完整记录（含按交接文档改的 4 处、两个吞吐坑）见 §11.4。ST77916 的验收用 `--panel=st77916` 随时可跑（那边屏没接时跳过）。

---

## 10. 风险与坑（先认下来）

### 10.1 契约层（要回馈固件侧，网页先按实现走）

1. `cs_policy` 注释与实现不符（§2.1）→ 网页下拉按**实现**写，并在文档里记一条"proto.h 注释待订正"。
2. `STATUS` 的 `actual_sclk` / `frames_err` 位置与 `sb_stats_t` 字段顺序不符 → 网页按实现解析；建议固件把两个字段补进 `sb_stats_t` 或改注释。

### 10.2 传输层

3. **一帧不跨包 + 不许填充**（§5.2）——违反的后果是 `frames_err` 涨、数据错位，且**回环测试会"看起来通过"**（写坏后回读也一致），所以打包器要单独自测。
4. **WebUSB 的 `endpointNumber` 不含方向位**（scope 页踩过）：`0x8B → 11/'in'`、`0x0B → 11/'out'`，**同一个号两个方向**，只能靠 `direction` 区分。
5. **同设备有两个 0xFF 接口**（SPI 桥 vs WebUSB 平台接口，后者 0 端点）→ 按"class 0xFF 且有 bulk EP11 双向"认接口。
6. **无取消接口** → 收尾纪律（§5.3）；超时即标脏设备，下次认领前复位端口。
7. **短等待必须走 `pace.js`**（页面不可见时 `setTimeout` 被钳到 ≥1 s）——这条在本仓库是铁律（见 `docs/` 与记忆里的实测）。
8. **跨页签/僵尸认领** → 复用 `probe-bus.js`；新页面必须接入让位链，否则"有时候认领不上"会重现。

### 10.3 硬件/语义层

9. **SPI 桥只在 EVKLite 构建里**（akaLinkPro 构建为 0）：页面对"没有这个接口"要给出明确、可操作的提示（刷 EVKLite 固件），而不是只说"设备没找到"。
10. **P1 固件全轮询**（`tx_dma_cnt` 恒 0）：页面别把 DMA 阈值装成"已在生效"。
11. **全双工必须等长**：回环与传感器读都要注意（不等长拆两帧）。
12. **辅助脚与排针共用**：PA09（TinyUF2 按键）、PA10（板载 LED）、PA00/PA01（UART0）列在表里但默认不选；开 quad 后 PA30/PA31 不能当辅助脚（固件会拒，页面要提前拦）。
13. **IN 环只有 16 槽**：批量刷图时**只有最后一片带 RSP**，否则 IN 流量会拖慢灌数据（固件方案 §7.6 的要求）。

---

## 11. 分阶段里程碑

| 阶段 | 内容 | 完成判据（离线） |
|---|---|---|
| **P1** ✅ 骨架 + 协议层 + 假探针（**已按 §0 第 10 条拆成两页**） | `app/spi/{protocol,transport,mock,session,bus-view,panel-view}.js`、两个标签页、连接/配置/档位/状态、通用帧控制台、回环自检（假探针内自环）、`make test-spi` + `make test-spi-page`、本文件转正 | ✅ Node 79 项 / CDP 页面 41 + 33 项全绿；假探针下"配置→使能→XFER 回环→状态对账"与"按屏套用→STEP 展开"都跑通 |
| **P2** 面板档 + 表 | `panels.js`（含两套内置表 + 提取脚本 + 对账测试）、表格编辑器、位编辑器、导入导出、单发/重放/复位 | 档 1/档 2 的线上字节流金样例逐字节通过；内置表与 C 头文件对账通过；页面自测覆盖重放整表 |
| **P3** 图片 | `image.js`（BMP + `createImageBitmap`）、预览/对齐/裁剪、RGB565、切片发送、进度/速率、内置图案 + 灰阶 | 小图逐字节金样例通过；页面自测：96×96 图切片数/末片 RSP/无 frames_err；预览与"实际下发窗口"一致 |
| **P4** 真机（等板子） | `spi-hw.mjs` + `make spi-hw`、错误诊断打磨、吞吐标定、README/docs 更新 + 截图 + 自测清单 | 回环长度扫描全 PASS（1/2/4 线）；SCLK 逐档记录；有屏时屏能亮 + 整屏刷图计时 |

每阶段一个中文提交；每阶段把新增入口写进 `Makefile`（`test-spi` / `test-spi-page` / `spi-hw`）与 `make check` 的语法检查清单，README 页面表与截图在 P4 一并补。

### 11.1 P1 实施记录（2026-09-29，已完成，未上板）

**落地清单**

| 文件 | 内容 |
|---|---|
| `app/spi/protocol.js` | 帧/HID 0x35/配置块/面板档 的编解码、`packFrames`（一帧不跨包）、`parsePack`（照固件的包解析语义）、`RspStream`（IN 字节流切包）、`RspMatcher`（seq 配对 + 超时 + cancel） |
| `app/spi/mock.js` | 假探针：HID 九个 action 的响应逐字节照固件 + 帧执行（XFER 回环 / STEP 三档展开 / DELAY 非阻塞 / CS/GPIO/RESET/AUX_IN）+ 故障注入（`loopback` / `dropRsp` / `inFull` / `forceStatus` / `disabledAlways`） |
| `app/spi/transport.js` | `WebUsbSpiTransport`（认领 class 0xFF + EP11 双向的接口、多条 IN 在飞、收尾等在飞读回来、认领失败端口复位重试）+ `MockSpiTransport`（同形） |
| `app/spi/view.js` | 页面装配：连接/配置/辅助脚/面板档/使能/状态/通用帧/回环自检/日志/统计 |
| `index.html` `app/app.css` `app/main.js` | 第 8 个标签 `SPI/QSPI 屏`（`#spi`）+ 面板 + 样式；注册 `SpiView`、`onShow`、`summary`；接入 `probeBus` 让位链 |
| `Makefile` | `make test-spi`（纯 Node）、`make test-spi-page`（CDP 真页面）、`make check` 语法清单 |
| 自测 | `tools/selftest/spi-proto.test.mjs`（**79 项**）、`tools/selftest/spi-panel-code.test.mjs`（**71 项**）、`tools/selftest/spi-bus-page.test.mjs`（**41 项**）、`tools/selftest/spi-panel-page.test.mjs`（**53 项**） |

**P1 踩到的四个坑（都已钉进自测）**

1. **状态字的 `err` 不能判断"本次是否成功"**：它是"最近一次错误码"，固件成功后**不清**（`spi_bridge.c` 只在出错时写 `s_last_err`）→ 拿它判 SET_CFG/PIN_CFG 会误报。页面改成 **SET_CFG 后回读对账**（顺带能发现固件把字段夹取走了，比如开 quad 后退掉 PA30/PA31）；自测里也钉了一条"成功写入后状态字里仍留着上一次的 RANGE"。
2. **发送半路失败会制造 unhandled rejection**：`sendFrames()` 里先登记了 N 个在飞请求，若第 1 个包就写失败（没使能 → NAK），后面的请求没人 await，1.5 s 后超时 reject → 页面自检报"整场跑完有未捕获错误"。修法：**登记时就挂 `onRejected`**，并在发送失败时 `matcher.cancel()` 掉本批。
3. **`decodeProfile` 要返回布尔**：否则页面里 `dcActiveHigh === true` 与固件回的 `1` 对不上（`1 !== true`），是个只在断言里现形的坑。
4. **`encodeCfg` 不夹取 `mode`/`bits`**：非法值原样下发、由固件用 RANGE 拒绝 —— 静默改值是最难查的一类问题（这条直接来自 §10.1 的第 1 条）。

**验收口径（本轮）**：`make test`（含 `spi-proto` 79 项）、`make test-spi-page`（41 + 33 项）、`make check` 全过；真机项（回环跳线、SCLK 逐档、实屏）**等板子**，见 §9.3。

### 11.2 拆页记录（2026-09-29，用户反馈"目前这个 web 有点繁重"）

**怎么拆的**：把原来那一页按"**这是通用链路的事，还是调屏的事**"切两半，并抽出一层共享会话。

| 层 | 文件 | 职责 |
|---|---|---|
| 会话 | `app/spi/session.js` | 连接（HID / 数据端点 / 假探针）、`sendFrames`、配置/档位/状态的读写与**回读对账**、统计、日志 ring、`subscribe()` 广播。**不碰 DOM** |
| 桥视图 | `app/spi/bus-view.js` | 桥配置、辅助脚、使能与状态、通用帧控制台、回环自检 |
| 屏视图 | `app/spi/panel-view.js` | 面板档、按屏套用推荐值（`PANEL_PRESETS`）、快捷面板步、复位/显示、只读摘要 |

**为什么共用会话而不是各连各的**：一个 USB 接口/一个 HID 只能被一个程序占用，两页各连一次既反直觉又容易撞"接口已被占用"；
共用之后"在屏页连上、桥页也能发帧"，这跟「串口助手 / 终端」共用串口会话是同一个模式。

**拆页带来的两个新坑（都已修 + 进了自测）**

1. **`session.lastStatus?.enabled` 恒为 `undefined`**：`parseStatusPayload()` 返回的是协议原样字段（`status` 是那个 u32 状态字），
   `enabled` 是 bit0，得用 `statusWord()` 解。后果是桥页"桥还没使能 —— 先点使能"那句提醒**从来没触发过**。
   现在会话上有一个 `get enabled()`，视图与自测都用它。
2. **假探针的延时单位不统一**：`STEP.delay_ms` 记的是毫秒、`DELAY` 帧记的是微秒、`RESET` 又是毫秒，
   自测里拿 `delays.includes(120)` 对账时才发现。现在统一记**毫秒**（`DELAY` 帧的 µs 在入口处除以 1000）。

**顺带确认的既有问题**：`make test-ui` 里「RTT Viewer：目标类型下拉（SWD / RISC-V）」那一项失败
（切 RISC-V 后 `r-range` 没换成 `0x01240000`，停在 `0x00080000`）—— 用 `git stash` 把我的改动摘掉重跑**同样失败**，
与本次拆页无关，待单独处理。

### 11.3 P2 + P3 实施记录（2026-09-29：面板初始化大框 + 图片/图案刷屏）

**新增模块**

| 文件 | 内容 |
|---|---|
| `app/spi/panel-code.js` | 初始化代码解析器：`parsePanelCode()`（C 数组为主 / 顺带纯文本行与 JSON）、`rowsToItems()`（表 → STEP 帧，只有末条带 RSP）、`rowsToC/Json/Text` 导出 |
| `app/spi/panels-data.js` | 内置两套表的**原始 C 文本**（由 `tools/dev/extract-panel-tables.mjs` 从 `E:\esp-idf-wsh` 的 `axs15352_init_cmds.h` / `st77916_init_cmds_ch32.h` 提取；带 `expect` 供对账） |
| `app/spi/image.js` | 18 种内置图案、`composeImage()`（适应/铺满/拉伸/原始）、`rgbaTo565()`（高字节在前 + R/B 交换 + 电平）、`parseBMP()`（16/24bpp，含 BI_BITFIELDS 掩码）、`alignWindow()`、`windowItems()`、`pixelItems()`、`imageToFrames()` |
| `tools/selftest/spi-panel-code.test.mjs` | **71 项**：解析器 + 与源 C 头文件对账 + 图片逐字节 + 整屏刷端到端（527 片喂给假探针） |

**页面（`#panel`）**：主区两块大卡片（可折叠）—— 「面板初始化」（大文本框 + 载入示例/文件 + 解析并预览 + 表格 + 重放/单发/导出）、「图片 / 图案刷屏」（图案 chips + 拖放 + 预览 + 缩放/开窗/屏幕/R-B/电平 + 刷这一张）；左栏补了「复位 / 显示」。

**这一轮踩到的坑（都进了自测）**

1. **BMP 的像素是 BGR 顺序存的**：我手搓测试 BMP 时按 RGB 写，结果"红绿蓝白"全反了 —— 自测里现在直接拿红/绿/蓝三色钉住。
2. **没有外层数组壳的 C 片段解析不了**：我们自己 `rowsToC()` 导出的就是 `{...},\n{...},` 这种形态，而解析器原来只会剥"`= { ... }` 外壳"。
   现在判据换成"最外层括号的顶层分隔里有没有以 `{` 开头的段"（有 = 容器，钻进去；没有 = 整段就是元素列表），导出 → 再解析的往返因此进了自测。
3. **行号差一行**：按"段起始偏移"算行号时没算段内前导空白里的换行 → 报错行号整体偏 1（排查时最误导的一类）。现在按"第一个非空白字符"算。
4. **解析纪律**：自报长度与实际字节不符 → 用实际字节 + **告警**；认不出的行 → **报错带行号与原文**（宁可报错也不猜）。
5. **几何要跟着"套用推荐值"走**：套用 ST77916 时把预览的屏幕几何一起切到 360×360，否则切片数/字节数全按错的屏算（页面自测里显式钉了这条）。
6. **预览要显示"发出去的样子"**：预览走一遍 `composeImage → rgbaTo565 → rgb565ToRgba`，所以 R/B 交换与电平的效果在预览里就能看出来，不用等屏。

### 11.4 真机验收记录（2026-09-29：AXS15352 屏点亮）

探针侧完工并给了交接文档（`akaLinkPro/docs/web-handoff-spi-bridge.md`）后，真机一次跑通：
**面板初始化 32 帧 + 整屏 292 帧全部零错误，屏上出现 8 条彩条**。

**按交接文档对齐的 7 处**（前 4 处是"不改就可能不亮/很慢"的）

| # | 改动 | 依据 |
|---|---|---|
| 1 | **档 1 刷像素改成"RAMWR 命令帧（DC=0）+ 像素片全程 CS_HOLD、末片才释放"** 的管道化写法 | 交接文档 §5 + `tools/panel_show.py:133-143`（原先我每片自成 CS 窗口且不发 RAMWR） |
| 2 | **自动补 `0x36 MADCTL=0x00` + `0x3A COLMOD=0x55`**（排在厂家序列之前，只影响重放/导出，不改用户贴的文本） | 厂家表里没有这两条，**缺了全黑**（文档明确） |
| 3 | 字节序给了 **高/低字节在前** 开关，与 **R/B 交换** 并存，提示"颜色不对只翻一个" | 两处交换会互相抵消（0x08 + 低字节在前），红蓝看着一样、绿色偏蓝 |
| 4 | **写请求并发**（`outInFlight`，默认 8）：1.47 → **3.15 MB/s** | 串行 `await transferOut` 时每片要等一个完整 USB 往返（真机每片 ~120 µs 开销） |
| 5 | 显示 `last_ticks`（"单笔事务 xx µs"） | 新增的 `STATUS` 第 10 个字（MCHTMR @24 MHz） |
| 6 | 配置块补上 `module_clk_hz`（解码保留，未做 UI） | 新增的"调板旋钮"，0 = 自动 |
| 7 | pad 表标注 `PY00/PY01` v1 不支持；发送前未使能会警告"bulk OUT 不武装，写会 NAK" | 文档 §4.3 / §7.1 |

**没做的**：固件的 `DBG(10)` / `PINTEST(11)` / `WIGGLE(12)` 三个诊断 action —— 用户明确说那是研发调板用的，对外交付不加（协议层只留一行注释说明号段被占）。

**真机数字**（142 KB 整屏，240×296×2，档 1 @40 MHz 推荐档）：

| SCLK | 实测 | 吞吐 | 单笔事务 |
|---|---|---|---|
| 20 MHz | 67 ms | 2.01 MB/s | 156.5 µs（贴线速） |
| 40 MHz | 43 ms | 3.15 MB/s | 79.9 µs |
| 60 MHz | 37 ms | 3.71 MB/s | 58.4 µs |
| 75 MHz | 39 ms | 3.47 MB/s | 47.5 µs |

**又一个"数字骗人"的坑**：验收脚本最早是从页面**累积日志**里正则取"刷图完成：… ms"——
日志是累积的，于是每一档都取到**第一次**那行，四档显示一模一样的 76 ms。
现在页面把最近一次刷图记成 `panel.summary().lastRun`（ms/bytes/slices/实际 SCLK），脚本读它 —— 客观、可复现。

**顺带修的体验问题**：「连接数据端点」以前每次都弹设备选择框（哪怕早授权过）。现在按钮先试**已授权设备**，
没有才弹框 —— 自动化脚本也因此不用再应答弹框。

### 11.5 页面功能流程验收（2026-09-29：一次通过，零错误）

用户指定的顺序，写成可复现脚本 `tools/selftest/spi-hw-flow.mjs`（`make spi-flow`）：

```
打开 web → 连接探针 → 初始化屏 → 发图 ×3 → 再次初始化屏 → 发图 ×3
```

**严格模式**：任何一步出错立刻停（不再往下跑），并打印现场（页面未捕获错误 / `frames_err` / err 级日志 /
最近一次刷图 / 两页日志尾部）。判"出错"的三条口径都取**增量**：
① 页面未捕获错误必须始终为 0；② 探针侧 `frames_err` 每步不得增长；③ 页面日志里 err 级新条目不得增长。

实测（AXS15352 @40 MHz，探针 + 真屏）：

```
① 打开 web ✓          页面错误 0
② 连接探针 ✓          HID + 数据端点（接口 4）
③ 配置就位 ✓          档 1 · 40 MHz · 表 30 条 · 自动补 0x36/0x3A
④ 初始化屏（第一次）✓  重放 0..31 完成（2 包 / 109 ms）
⑤ 发图 ×3 ✓           色条 8 / 混色卡 / 棋盘 16px：各 289 片 138.8 KB，43~65 ms，坏应答 0
⑥ 再次初始化屏 ✓      重放 0..31 完成（2 包 / 107 ms）
⑦ 发图 ×3 ✓           渐变 / 对半红绿 / 4px 网格：44~52 ms，坏应答 0
11 步全完成，16.5 s　累计 frames_ok=2140　frames_err=0　页面错误=0　err 级日志=0
```

吞吐在 2.08~3.17 MB/s 之间波动（并发写的抖动，同一档重复跑 ±10%）；关键是**反复初始化 + 连续刷图不累积错误**。

---

## 12. 已拍板与 TBD

**已拍板**：见 §0（9 条），本轮不再有悬空问题。

**TBD（明确先不做，等以后）**

1. **TE 撕裂信号**：读电平与"等 TE 再发下一片"都留到上板看到撕裂之后再评估；页面暂不暴露 `pad_te`。协议层的 `AUX_IN` 帧仍实现（通用帧控制台里可手动发，成本为零）。
2. **帧序列 / 面板表的本地持久化**：localStorage 存档、"某块屏 + 某个图案"的一键流程留 TBD；P2 做的是**文件**导入导出（JSON / C 片段），不是浏览器本地状态。
3. **背光 PWM 调光**：v1 只有 BL 开/关（固件方案 §9.2 已列为后续）。
4. **SCLK 80 MHz**：5301EVKLite 上限 75 MHz，不再考虑 80 MHz。
5. **README / 截图 / `docs/backends.md`**：P4 一起改。
