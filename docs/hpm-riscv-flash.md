# HPM 系列（RISC-V）零安装烧录 —— 设计、离线验证与 bring-up 清单

> 目标：在**烧录器**页用 WebUSB 直接烧 HPM 系列的外部 flash，不需要 OpenOCD/本地桥。
> 数据来源：`E:\sdk_env_v1.11.0\hpm_sdk`（HPM SDK v1.11.0）。本轮**未使用探针**（被别的开发占用），
> 所以下面严格区分「离线已验证」与「待真机 bring-up」。

## 1. 为什么这条路的每一环都是"有据可依"的

| 环节 | 依据（不是猜的） |
|---|---|
| 烧录算法的机器码 | HPM SDK 自带 `samples/openocd_algo/`（RV32 源码 + 链接脚本 + 入口表），本仓库用 SDK 的工具链自己编 |
| 算法怎么调 | 入口表 + 各函数签名（`flash_init/erase/program/read/get_info/erase_chip/deinit`）来自那份源码 |
| 板级参数（flash 基址/XPI 基址/option0/option1） | SDK 的 `boards/openocd/boards/*.cfg` 里 `flash bank xpi0 hpm_xpi …` 一行 |
| TAP IDCODE / IR 长度 / work-area | SDK 的 `boards/openocd/soc/*.cfg` |
| ROM API 表地址 | 各 `soc/<系列>/<型号>/hpm_romapi.h`：**全系都是 `0x2001FF00`** ⇒ 一份 blob 通吃 |
| JTAG 位序、DMI 流水线、SBA 语义 | akaLinkPro 探针固件 `src/riscv/riscv_jtag.c`（那份在 HPM6800EVK 上跑通过），逐条对齐 |
| DAP 封包格式 | 探针固件 `src/dap/DAP.c` 的 `DAP_JTAG_Sequence` 实现（照它的字节布局，不照记忆） |
| output_mode 切换报文 | akaLinkPro 的 `script_test/hpm6800_probe.py set-mode`（照抄 7 个字节） |

## 2. 数据通路

```
烧录器页
 ├─ HID 0xFF00 ──── CMD_SET_CONFIG(0x02) → 探针 output_mode = SWD+JTAG（RAM-only，掉电即失）
 └─ WebUSB（interface 0，CMSIS-DAP v2，bulk OUT 0x02 / IN 0x81）
      ├─ DAP_Connect(2)         → 拿 JTAG 口
      ├─ DAP_JTAG_Configure(5)  → 一个 TAP、IR 长度 5
      └─ DAP_JTAG_Sequence(0x14) × N
            └─ TAP: IR=0x01 读 IDCODE / IR=0x10 读 DTMCS / IR=0x11 读写 DMI(41 位)
                  └─ Debug Module：dmcontrol/dmstatus/abstractcs/command/data0（停核、传参、取返回码）
                        └─ SBA（sbcs/sbaddress0/sbdata0）：往 SRAM 写 flashloader、读写数据中转区
```

模块（`app/flash/hpm/`）：

| 文件 | 职责 |
|---|---|
| `algo.js` | **自动生成**：flashloader blob（base64）+ 构建时的符号地址 + header 常量 |
| `entry.js` | 入口表解析：走一遍 `jal` 发现偏移（**步长不是 8 B**，见下） |
| `chips.js` | 10 块板的参数 + 全系通用常量 + 范围检查（纯函数） |
| `jtag.js` | TAP 动作 / DMI 41 位编码 / 抽象命令 / sbcs 位（TM 位置与固件逐条对齐） |
| `riscv-dm.js` | `RiscvTransport`：init / halt / waitHalted / 抽象寄存器 / SBA 块读写 / 单字流水读 |
| `dap-transport.js` | 真机：WebUSB + CMSIS-DAP 的 JTAG 序列封包/解包 |
| `flash.js` | `HpmFlasher`：加载算法 → init → get_info → 擦 → 写 → 校验 → 复位运行 |

## 3. 三个"踩过就知道"的点

1. **入口表步长不是 8 B**：`func_table.S` 里每项是 `jal` + `ebreak`，而汇编器把 `ebreak` 压成
   2 字节的 `c.ebreak` ⇒ **每项 6 B**。构建脚本一开始按 8 B 校验，第 2 项就炸了。
   现在偏移由 `entry.js` **真解码**（识别 RVC 的 16 位指令）得到，并用构建时抓的符号地址对账。
2. **blob 必须 `-nostdlib` + 自带 `memset`**：算法只用到一个 `memset`，而链 newlib 会把
   malloc 表 / `impure_data` / GOT 一起带进来 —— 实测 **1388 B → 16868 B**。要逐字写进 SRAM，差一个数量级。
3. **等算法跑完只能轮询，不能再写 haltreq**：算法靠最后一条 `ebreak` 自然停住来交差；
   轮询时若再发 `haltreq` 会把还在擦写的算法当场打断，返回码变垃圾（`waitHalted()` 与 `halt()` 因此分开）。

## 4. 离线已验证（`make test-hpm`，60 项，无需探针/板子）

`tools/selftest/hpm-sim.mjs` 是**模拟目标**：真的按位解释 `jtag.js` 生成的 JTAG 序列
（TAP 状态机 → IR → 41 位 DMI 流水线），实现 DM 寄存器、SBA 语义、SRAM、XPI flash，
并按**入口表**执行七个算法函数（包括 NOR 的"按位与"编程语义）。

已验证：
- blob 尺寸/入口表/符号对账；垃圾输入不会进表；
- TAP 复位与装 IR 的位序、41 位 DMI 布局、抽象命令编码、sbcs 位；
- IDCODE/DTMCS/DMSTATUS 读回、halt、抽象命令读写寄存器与 dpc；
- SBA 块写→块读逐字节一致、非对齐读补齐、越界写报错、单字流水读的"延迟一拍"语义；
- **端到端**：加载 flashloader（1388 B 经 SBA 写入 SRAM）→ `flash_init` → `flash_get_info`
  （拿回真容量/扇区）→ 擦 → 按 4 KB 分块写（尾块补 0xFF）→ `flash_read` 校验；
- 负例：往"已是 0"的位写 1 → 校验必须抓出（NOR 语义）；主机侧范围检查拦住越界地址；
- DAP 封包/解包与固件 `DAP.c` 的布局一致（含"TMS=1 的序列也要带 TDI"这条）。

## 5. 待真机 bring-up（**都没验过**，按这个顺序查）

1. **output_mode 切换**：HID `CMD_SET_CONFIG` 是否立即生效（还是要 `CMD_SAVE`/复位）。
   现象：`DAP_Connect(2)` 返回 1（SWD）而不是 2（JTAG）。
2. **JTAG 链路**：`DAP_JTAG_IdCode` 应读到 `0x1000563D`。读不到 → 接线（TCK/TMS/TDI/TDO/GND）、
   板子供电、探针引脚模式。
3. **DMI 通不通**：`init()` 会打印 DTMCS（期望 `idle=7`）与 DMSTATUS。DTMCS 全 0 →
   IR 没装上（JTAG 时序/`DAP_JTAG_Configure` 的 TAP 数）。DMSTATUS 全 0 → DM 没上电（`dmactive`）。
4. **SBA 读写 SRAM**：写一小段 → 读回比对。失败看 `sbcs` 的 `sbbusyerror/sberror`（写 1 清零）。
   本探针的 DMI idle 拍默认 8（固件默认），必要时调 `RiscvTransport` 的 `idle`。
5. **算法**：`flash_init` 返回 0 且 `flash_get_info` 给出合理容量/扇区。
   返回 4/5（no flash / 未初始化）→ `option0/option1` 或 `xpi_base` 与板子不符（对比 SDK 的 board cfg）。
6. **吞吐**：当前实现每个 DMI 访问一次扫描 + 每字一次 `sbcs` 查询（安全优先）。
   真机上若太慢，可把"读 sbcs"从每字改成每块一次（固件里的块读就是这么做的）。

## 6. 怎么自己重建算法

```powershell
# 需要 HPM SDK + RISC-V 工具链（默认路径见脚本头部，可用环境变量覆盖）
pwsh -File tools/target-firmware/hpm_flash_algo/build.ps1   # 或 make hpm-algo
```

脚本会编译、校验入口表、写出 `app/flash/hpm/algo.js`（base64）。改了 SDK 版本或板子后重跑一次即可。
