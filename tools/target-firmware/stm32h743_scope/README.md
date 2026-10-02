# STM32H743 · scope（HSS 采样）测试固件

给「J-Scope 波形页」（探针侧 HSS 采样）用的**靶子**：每个被采样的量都有**精确已知的数学波形**，
所以"采样率对不对、有没有混叠、丢了多少、有没有撕裂读"都能**客观判定**，不用靠肉眼看波形。

- 变量契约、应有值算式、ISR 更新顺序 —— **与 `../stm32f103_scope/` 逐字相同**（同一套靶子）。
- 时基：HSE 25MHz → PLL1 → SYSCLK 400MHz（CPU 200 / AXI 200）→ SysTick 每 20000 周期
  = **10 kHz**，ISR 里所有量一次更新完。
- 目标固件**不占任何外设**（只开时钟 + SysTick + 可选 D-Cache），寄存器级，不依赖 HAL/CMSIS。
- 与 F103 那份的**唯一实质差别**：H7 上"变量放哪块 RAM"变成了硬要求 —— 见第 2 节。

> 📦 目录根的 **`fw.elf` 是编好的产物**（默认 flash 版），直接在网页里载入即可；
> 改了源码就重跑 `build.ps1`（它会重新覆盖这一份）。

---

## 1. 变量契约（`t` = g_tick，10 kHz 计数）

| 变量 | 地址¹ | 类型 | 应有值 |
|---|---|---|---|
| `g_pack.f_sin` | 0x24001014 | f32 | `SIN100[t%100]/1000` —— 100 Hz 正弦 ±1.0 |
| `g_pack.f_tri` | 0x24001018 | f32 | 100 Hz 三角，峰值在 `t%100==50`（与正弦差 90°） |
| `g_pack.i_tick` | 0x2400101c | i32 | `t` |
| `g_pack.u_ramp` | 0x24001020 | u16 | `t % 1000`（100 Hz 锯齿） |
| `g_pack.i_sq1k` | 0x24001022 | i16 | `(t%10<5) ? +1000 : -1000` —— **1 kHz 方波** |
| `g_pack.u_cnt` | 0x24001024 | u8 | `t & 0xFF`（约 39 Hz 回绕） |
| `g_pack.i_saw` | 0x24001025 | i8 | `(int8_t)(t*3)` —— 8 位锯齿，步进 3 |
| `g_pack.rsv0` | 0x24001026 | u8 | 保留（只为让 `u_hi` 4 字节对齐，不采） |
| `g_pack.u_hi` | 0x24001028 | u32 | `0x10000000 \| (t & 0xFFFF)` —— **高位非零，验 u32 精度** |
| `g_lfsr` | 0x24000000 | u32 | xorshift32（宽带伪随机） |
| `g_far_cnt` | 0x24000008 | u32 | `t` |
| `g_far_sq100` | 0x2400000c | i16 | 100 Hz 方波 ±1000 |
| `g_isr_count` | 0x24001010 | u32 | `t`（与 `g_tick` 同值 → 验两个地址都对） |
| `g_pair_a` / `g_pair_b` | 0x2400102c / 0x2400102e | u16 | `t` / `~t` —— **撕裂自检**：`a^b != 0xFFFF` 即"读到两次 store 之间" |
| `g_pulse` | 0x24001030 | u8 | `(t%2000 < 100) ? 1 : 0` —— 5 Hz 脉冲、5% 占空比（**触发测试**用） |
| `g_ramp64` | 0x24001038 | f64 | `1.0 + t*1e-6`（主循环更新，验 8 字节载荷/浮点精度） |
| `g_sq5k` | 0x24001040 | i16 | `(t&1) ? +1000 : -1000` —— **5 kHz 方波：采样率 < 10 kHz 必然混叠** |
| `g_tick` | 0x24001044 | u32 | `t`（**主对齐量**） |
| `g_hole[4096]` | 0x2400000e | u8[] | 占位（不采），作用只是把地址拉开 4 KB |

¹ 本机构建实测（`build.ps1` 每次会打印一遍；换编译器/改代码后地址会变，**以 nm 为准**）。
`g_pack` 整块 **24 B**、连续（`check.py` 会断言这个大小）。

**诊断量**（不属契约，但页面/脚本可以顺手采；都在同一块 AXI SRAM 里）：

| 变量 | 地址 | 含义 |
|---|---|---|
| `g_z_dcache` | 0x24001050 | 0 = D-Cache 关，1 = 开（一眼看出烧的是哪一版） |
| `g_z_sysclk_hz` | 0x24001058 | 实际 SYSCLK（400000000 或降级的 64000000） |
| `g_z_hclk_hz` | 0x24001054 | 实际 HCLK（= SysTick 时基；200000000 / 64000000） |
| `g_z_clk_src` | 0x2400104c | 0 = HSE→PLL，1 = HSI 直出（保命档） |
| `g_z_clk_err` | 0x24001048 | 出错位或：bit0 VOSRDY / bit1 HSERDY / bit2 PLLRDY / bit3 切换 / bit7 降级 |

**更新顺序 = 契约的一部分**（主机据此放宽断言）：先 `g_tick`，再 `g_pack` 各字段（逐个 store，
**不是原子快照**），最后散落量。所以任何读到的值都可能落在"上一 tick"⇒ 断言要允许 ±1 tick。

---

## 2. 内存布局：被采样的变量**必须**在 AXI SRAM（H7 特有的硬要求）

```
0x08000000  FLASH   128 KB   向量表 + 代码 + .rodata（探针读得到，但这里没有被采样的量）
0x20000000  DTCM    128 KB   ★ 只放栈 —— 内核私有总线，AHB-AP 探针**读不到**
0x24000000  AXI SRAM 512 KB  ★ .data/.bss 全在这里（所有 g_* = 被采样的量）
```

H7 的 ITCM/DTCM 挂在**内核私有总线**上，外部调试器走 AHB-AP 够不着（本仓库
`../stm32h743_rtt_speed/README.md` 与 `../stm32h7b0_rtt_speed/RESULTS.md` 都记着这条）。
J-Scope 靶子的全部意义就是"让探针把变量读出来"，所以链接脚本把 `.data/.bss` 整个放到 AXI SRAM；
栈留在 DTCM（探针不需要读栈，而 DTCM 零等待、最省事）。

**这条要求是机器可验的**（不需要硬件）：

```powershell
arm-none-eabi-nm -S build\fw.elf | Select-String '\sg_'
# 输出里每一行都必须是 24xxxxxx：
#   24001014 00000018 B g_pack      24001044 00000004 B g_tick
#   24000000 00000004 D g_lfsr      2400000e 00001000 B g_hole
python check.py --static-only        # 会逐条断言"都在 AXI SRAM"，越界直接判失败
```

有人会问"DTCM 到底能不能被探针读到"—— 本仓库的结论是**读不到**，而这正是这份靶子要坐实的事：
如果你手上的探针/工具链真能读 DTCM，把 `ld/stm32h743.ld` 的 `.data/.bss` 改回 `> DTCM`
再采一遍，就能拿到反证（`check.py` 的静态检查会先拦下来，别硬改忘了那一步）。

### 地址分两块 → 正好对比"读计划"的两条路径

```
span A  0x24000000 .. 0x2400000e   14 B   （g_lfsr / g_far_cnt / g_far_sq100）
        ── 4 KB 空洞（g_hole 占位）──
span B  0x24001010 .. 0x24001048   56 B   （其余全部；再接 20 B 诊断量 g_z_*）
```

| 采样方案 | 每样本（按 scope 页面的时钟模型估） | 上限（模型估算） |
|---|---|---|
| 8 个字段全取 `g_pack`（**一个 span，24 B**） | ≈12.4 µs | **≈81 kHz** |
| 跨 span 取 8 个（A 14 B + B 56 B） | ≈31 µs | **≈32 kHz** |
| 朴素：8 次 `swd_read_memory()` | ≈54 µs | ≈18 kHz |

**这些是模型估算，不是实测** —— 页面里会显示它自己的估算，真值要等探针固件标定。
注意：span B 如果连 `g_z_*` 一起勾上会超过页面单个 span 的 64 B 上限，页面会**自动拆成多个 span**。

---

## 3. 编译 / 烧录 / 验收

```powershell
pwsh -File build.ps1            # 默认 flash 版（arm-none-eabi-gcc 10.3，-g3 -gdwarf-4）
pwsh -File build.ps1 -DCache    # ★ D-Cache 干扰实验版（见第 4 节）→ build-dcache\fw.elf
pwsh -File build.ps1 -Ram       # 全 RAM 版 → build-ram\fw_ram.elf（本机这块板的 flash 算法跑不起来）
pwsh -File build.ps1 -Clean

pwsh -File flash.ps1            # OpenOCD + CMSIS-DAP 烧录（⚠️ 本机这块板烧不动，见第 5 节第 5 条）
python check.py                 # ★ 客观验收：静态查地址 + halt→dump RAM→逐项核对 + 复测 10 kHz 时基
python check.py --static-only   # 只做静态检查（没有硬件也能跑）
python check.py --hold          # 跑完保持 halt（排障）
```

`check.py` 做三件事：
1. **静态**：从符号表取地址，断言每个被采样的量都在 AXI SRAM（H7 上这是硬要求）；
2. halt 住目标、dump `0x24000000` 起 16 KB，**逐个变量核对契约**（浮点容差 2e-6，整型精确比对；
   每个量允许 `t` 或 `t-1`，被 halt 打断的 `g_pair_a/b` 会报"撕裂"而不是判失败）；
3. 让目标跑 3 s 再 halt 一次，用 `Δtick` 反测时基（偏差 >3% 才判失败）。

> `check.py` 用 pyelftools 读符号表取地址 —— **改了变量名/结构体布局要同步改它**。
> pyOCD 通路没实现，但目标名是 `stm32h743xx`（想手动对拍可以用
> `pyocd commander -t stm32h743xx`）。

**怎么用它验证 scope 页面**（与 F103 那份完全一样）：
1. 页面里载入 `build/fw.elf`，勾 8 个变量（建议先勾 `g_pack` 那一组：一个 span 的快路径）；
2. 采样率定成 **30 kHz 以上**（高于 5 kHz 方波的两倍才不混叠）；
3. 对账口径：`g_tick` 斜率 ≈ 采样率；跳变 > 1 = 丢样本（跳变量应等于页面的 `dropped`）；
   按 `g_tick` 反算其余通道；`g_pair_a ^ g_pair_b != 0xFFFF` 的占比 = 撕裂率；
   把采样率降到 6 kHz 看 `g_sq5k`（5 kHz 方波）变成什么低频假波。

---

## 4. ★ 「H7 D-cache 干扰」实验（本固件的第二个用途）

`-DCache` 编出来的固件除了 `main()` 里多这几行，源码**一模一样**：

```c
SCB_CCR |= (1u << 16);   /* DCACHEEN */
__asm__ volatile("dsb");
__asm__ volatile("isb");
g_z_dcache = 1u;         /* 让主机能一眼看出烧的是哪一版 */
```

AHB-AP（探针）走的是**物理内存**，而 CPU 的写会停在 D-Cache 里（AXI SRAM 默认是
Normal / Write-Back / Write-Allocate）。于是：

| 现象 | 关 D-Cache（默认） | 开 D-Cache（-DCache） |
|---|---|---|
| `g_tick` / `g_pack` 采样值 | 每个样本都在变，与契约逐点吻合 | 可能**冻住不变**（脏行长期不驱逐），或**成片变旧** |
| `g_ramp64`（主循环每 tick 写） | 正常递增 | 最容易被 cache 兜住的量 |
| `check.py` | 全绿 | 大概率报"与 tick 对不上" |

**正确读法**：这不是 bug，是**示范**。开 cache 后"采样值变旧/卡住不变"恰恰证明
"探针读的是内存、不是 cache"这条前提；要采到真值就必须让变量落在**非缓存**内存
（或像本项目这样把 D-Cache 关掉）。
做实验时请把两版都采一遍，并顺手采 `g_z_dcache` 确认当前跑的是哪一版。
（`g_z_clk_*` 也可以一起采：它们能告诉你目标有没有真的跑到 400MHz。）

---

## 5. 坑（本固件已踩/已处理）

1. **DTCM 探针读不到** ⇒ `.data/.bss` 全放 AXI SRAM，栈留 DTCM。这是本目录与 F103 版最大的差别，
   也是"为什么不能照抄 F103 的链接脚本"的唯一原因（`nm` 可验、`check.py --static-only` 可断言）。
2. **`g_hole` 会被 gc 掉**：`-fdata-sections` + `--gc-sections` 下，没有任何引用的 4096 B 数组
   会连同"地址空洞"一起消失。现在 `main()` 里有 `g_hole[0] = 0;` 保命 —— 别删。
3. **必须 `-gdwarf-4`**：scope 页面第一版的 DWARF 解析器只吃 DWARF 4，而 GCC 11+ 默认切 5。
   本机 GCC 10.3 默认就是 4，仍然显式写死，免得工具链一升级就解析不出来。
4. **`RCC_PLLCKSELR.DIVM1` 里写的是"分频值本身"**（5 = /5），**不是"分频值-1"**；
   只有 N1/P1/Q1/R1 才是"值-1"。依据：`__HAL_RCC_PLL_CONFIG` 宏直接 `(__PLLM1__) << 4U`，
   且 `HAL_RCC_GetSysClockFreq()` 里 `pllm = (PLLCKSELR & DIVM1) >> 4` 之后**直接做除**。
   ⚠️ 顺手记一条：兄弟目录 `../stm32h7b0_rtt_speed` 的 `-Minimal` 版在这里写成了 `divm - 1`，
   于是它实际跑 350MHz 而固件自报 280MHz（HAL/SDK 版不受影响）。本目录的两份都按正确写法。
5. **本机这块阿波罗 H743 板子的 flash 算法跑不起来**（halt 通、AHB-AP 读写正常、flash 全 0xFF、
   RDP 无保护，但写 flash 时 `timed out while waiting for target halted`；SRST 也没接到探针）——
   见 `../stm32h743_rtt_speed/README.md`。所以 `flash.ps1` 这条路**在本机没跑通**，
   真要用请 `build.ps1 -Ram` 出全 RAM 版，用网页「烧录器」把镜像写进 AXI SRAM 再指 SP/PC。
   RAM 版的固件自带 `SCB_VTOR = g_vectors`（否则中断向量还从 flash 别名取，SysTick 一进中断就飞）。
6. **VOS 的写会被硬件静默忽略**，除非 `PWR_CR3.SCUEN` 已经清 0。本固件**只在 SCUEN 置位时**
   才去清它，绝不整块写 `PWR_CR3` —— 无条件写供电寄存器在 H7 上是能把板子写进
   "AP 事务恒 WAIT、只能整板断电"的死状态的（H7B0 那边真踩过）。
7. **升频之前必须先把 flash 等待周期给够**（本固件 LATENCY=4 + WRHIGHFREQ=0b11）。
   厂商例程用 2、兄弟例程用 4+0b10，三种都能跑；等待周期只影响速度不影响正确性，这里取最保守的。
8. **CPU 时钟与 HCLK 故意都取 200MHz**（D1CPRE = HPRE = /2）：H7 上 CPU 时钟与 AXI/HCLK
   可以不同，而 SysTick 到底跟哪一个说法不一（ARM 说跟 processor clock，ST 的 HAL 按 HCLK 算）。
   让两者相等，10 kHz 时基就没有这个歧义 —— 反正被采样量的刷新与 AHB-AP 读只关心 HCLK。
9. **每一步时钟等待都有上限**：任何一步失败就整档放弃、退到 HSI 64MHz 并把 `g_z_clk_err` 记下来
   （不接调试器也能知道卡在哪一步）。绝不写无上限的 `while(!(RCC->CR & PLL1RDY))` ——
   那样固件会静静卡死，主机只看到"连上了但一个数都不动"。
10. **`check.py` 里写了 `--static-only`**：没有硬件的时候也能跑（只查符号地址与 `g_pack` 布局）。
    ⚠️ 诚实标注：本目录的固件在本次交付里**只做到了"编译通过 + 静态检查通过"**，
    **没有上板跑过**（手上没接这块 H743）。上板第一件事是 `python check.py` 而非肉眼看波形。
