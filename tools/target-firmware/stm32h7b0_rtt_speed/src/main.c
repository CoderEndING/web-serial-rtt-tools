/*
 * STM32H7B0（Cortex-M7 @280MHz）· SEGGER RTT **吞吐测试固件**
 *
 *   while(1) 里死循环发 "hello world!\n"，**不加任何延时、不碰串口**。
 *   RTT 用 BLOCK_IF_FIFO_FULL（见 segger_rtt/SEGGER_RTT_Conf.h）：缓冲满就阻塞 ——
 *   于是目标写多快**完全由主机取多快决定**，主机读到的字节/秒就是 RTT 的实际吞吐。
 *   这是"同一块板子对比 WebUSB 与 OpenOCD 两条主机通路"的干净做法。
 *
 * 目标板：STM32H7B0VBT6 KIT（板载 **25MHz** 晶振）。
 *   时钟配方直接对齐板子自带 SDK（CubeMX 工程 `SDK\DEMO\USART`）：
 *     HSE 25MHz → DIVM1=5 → 5MHz 参考 → ×DIVN1(112) → 560MHz VCO → /DIVP1(2) → **280MHz**
 *     RGE = 4~8MHz 档（5MHz 参考）、VCOSEL = 宽量程、VOS0、FLASH LATENCY=7
 *   没有晶振的板子会自动退到 HSI 64MHz→PLL 280MHz，两条路都能跑满 280MHz。
 *
 * ⚠️ 一块**不能碰**的寄存器：PWR_CR3。无条件写它会把板子带进"ACTVOSRDY 永不置位"的死状态
 *    （DP 还能读 IDCODE，但所有 AP 事务恒 WAIT，只能整板断电），详见 clock_init_280mhz() 第 1 步。
 *
 * 三个全局量留给主机读（交叉验证用）：
 *   g_bytes —— 目标实际写出去的字节数（阻塞模式下应当 ≈ 主机读到的字节数）
 *   g_loops —— 循环次数（×13 = g_bytes）
 *   g_ms    —— SysTick 毫秒数（**判断目标是否还活着**：阻塞在 RTT 写里时它照样在走，
 *              所以它不涨才是真卡死，而不是"在等主机读"）
 *   g_sysclk_hz / g_clk_src / g_clk_err —— 时钟最终落在哪条路径、哪一步出过问题（见 regs.h）
 */
#include <stdint.h>

#include "stm32h7b0_regs.h"
#include "SEGGER_RTT.h"

volatile uint32_t g_bytes;
volatile uint32_t g_loops;
volatile uint32_t g_ms;
volatile uint32_t g_sysclk_hz;        /* 实际切过去的系统时钟（主机读它核对） */
volatile uint32_t g_clk_src;          /* CLK_SRC_*：最终生效的时钟路径 */
volatile uint32_t g_clk_err;          /* CLK_ERR_* 位或：哪一步超时了（0 = 全程顺利） */

void SysTick_Handler(void){ g_ms++; }

/* 每次等待最多轮询多少遍 —— **所有等待都必须有上限**。
 * 第一版就是无限 `while(!(RCC_CR & PLL1RDY))`：PLL 锁不上 → 固件静静卡死，
 * 主机只能看到"连上了但一句 RTT 都没有"，排查成本极高。宁可退到慢时钟，也不要卡死。 */
#define WAIT_SPINS  20000000u

/**
 * 轮询直到 (reg & mask) == want（want 为 0 时表示"字段清空"）。
 * 返回 1 = 等到，0 = 超时。addr 用物理地址（RCC_BASE + 偏移），避免对 REG32 取地址。
 */
static int wait_field(uintptr_t addr, uint32_t mask, uint32_t want, uint32_t spins){
  while (spins--){
    if ((REG32(addr) & mask) == want) return 1;
  }
  return 0;
}

/**
 * 配 PLL1 的源/分频/倍频。**必须在 PLL1ON=0 时调用**（否则这些寄存器写不进去）。
 *   src   ：RCC_PLLCKSELR_PLLSRC_xxx
 *   divm  ：参考分频（**写分频值本身**，1..63 —— 与 N/P/Q/R 不同，那三个才是写"值-1"）
 *   divn  ：倍频（实际值，内部写 divn-1）
 *   rge   ：参考频率档位值（0:1~2MHz 1:2~4 2:4~8 3:8~16）
 * PLL1P/Q/R 固定 /2（P 给 CPU，Q/R 填合法值免得被 assert 的等价物坑）。
 */
static void pll1_config(uint32_t src, uint32_t divm, uint32_t divn, uint32_t rge){
  /* DIVM1 在 bit[9:4]（6 位）、PLLSRC 在 bit[1:0] —— 按本机 SDK 的 stm32h7b0xx.h 逐位核过
   * （RCC_PLLCKSELR_DIVM1_Pos = 4、RCC_PLLCKSELR_PLLSRC_Pos = 0）。
   *
   * 🚨 2026-10 修正 off-by-one：这里原来写的是 `(divm - 1u)`，而 DIVM1 要写**分频值本身**
   *    （依据：HAL 的 __HAL_RCC_PLL_CONFIG 宏就是 `(__PLLM1__) << 4U`，HAL_RCC_GetSysClockFreq
   *    里也是 `pllm = (PLLCKSELR & DIVM1) >> 4` 之后直接做除）。
   *    写 divm-1 的后果：HSE 路径实际 25/4 × 112 / 2 = **350 MHz**，而固件把 g_sysclk_hz 报成
   *    280 MHz —— H7B0 是 280 MHz 的片子，等于一直在**超规格**跑（HSI 后备路径同理）。
   *    注意只有 DIVM1 是"写值本身"，N1/P1/Q1/R1 仍是"写值-1"（见下面 PLL1DIVR）。 */
  RCC_PLLCKSELR = src | (divm << RCC_PLLCKSELR_DIVM1_SHIFT);
  RCC_PLL1FRACR = 0;                                   /* 不用小数分频 */
  RCC_PLLCFGR   = (rge << RCC_PLLCFGR_PLL1RGE_SHIFT)   /* 参考频率档 */
                | RCC_PLLCFGR_DIVP1EN                  /* CPU 时钟走 PLL1P，必须开 */
                | RCC_PLLCFGR_DIVQ1EN | RCC_PLLCFGR_DIVR1EN;
  /* VCOSEL=0（宽量程 192~836MHz）、FRACEN=0 —— 都不置位即是 */
  RCC_PLL1DIVR = ((divn - 1u) << 0)                    /* N1[8:0] */
               | ((2u - 1u) << 9)                      /* P1[15:9] */
               | ((2u - 1u) << 16)                     /* Q1[22:16] */
               | ((2u - 1u) << 24);                    /* R1[30:24] */
}

/** 开 PLL1 → 等锁定 → 切 SYSCLK 到 PLL1。返回 0 成功，1 = PLL 没锁，2 = 切换没生效。 */
static int pll1_start_and_switch(void){
  RCC_CR |= RCC_CR_PLL1ON;
  if (!wait_field(RCC_BASE + 0x00u, RCC_CR_PLL1RDY, RCC_CR_PLL1RDY, WAIT_SPINS)) return 1;

  RCC_CFGR = (RCC_CFGR & ~RCC_CFGR_SW_MASK) | RCC_CFGR_SW_PLL1;
  if (!wait_field(RCC_BASE + 0x10u, RCC_CFGR_SWS_MASK, RCC_CFGR_SWS_PLL1, WAIT_SPINS)) return 2;
  return 0;
}

/** 关掉 PLL1 并等它真的关掉（重配前必须） —— 同样带超时。 */
static void pll1_stop(void){
  RCC_CR &= ~RCC_CR_PLL1ON;
  (void)wait_field(RCC_BASE + 0x00u, RCC_CR_PLL1RDY, 0u, WAIT_SPINS);
}

/**
 * 时钟初始化：目标 280MHz（VOS0）。三级降级，**任何一级失败都不会卡死**：
 *   ① HSE 25MHz → PLL → 280MHz      （板子有晶振时的正常路径）
 *   ② HSI 64MHz → PLL → 280MHz      （晶振没起振/没焊时的后备，速度一样）
 *   ③ HSI 64MHz 直出                （PLL 也不行的保命档，RTT 一定能跑，用来分离问题）
 * 结果写进 g_clk_src/g_clk_err/g_sysclk_hz，主机读这三个量就知道目标处于什么状态。
 */
static void clock_init_280mhz(void){
  int r;

  /* 0) 先把 SYSCFG 时钟打开。🚨 APB4ENR 偏移是 0xF4（H743 是 0x6C）：
   *    第一版写成 0x6C，等于写到一个不相干的寄存器，SYSCFG 一直没时钟。
   *    （PWR 在 H7B0 上不需要单独开时钟，CR3/SRDCR 复位后就能写。） */
  RCC_APB4ENR |= RCC_APB4ENR_SYSCFGEN;

  /* 1) 🚨 **绝对不要写 PWR_CR3**（供电来源选择）。
   *    ST 的 HAL（HAL_PWREx_ConfigSupply）里这段是**有条件的**：先看供电配置是否已锁定 /
   *    是否已经是目标值，是就**直接返回、不写寄存器也不等 ACTVOSRDY**。第一版照着 SDK 抄时
   *    把判断丢了，改成无条件写 —— 实测后果很严重（2026 实测踩到）：
   *      写 PWR_CR3 → ACTVOSRDY 永不置位 → 目标内部时钟域停摆
   *      → SWD 的 **DP 还能读 IDCODE**（它由探针 SWCLK 直接驱动），但**所有 AP 事务恒为 WAIT**
   *      → 烧录/调试/OpenOCD/pyOCD 全部失效，**只有整板断电才能恢复**。
   *    复位默认本来就是 LDO（= SDK 里 PWR_LDO_SUPPLY 的值），所以这里**只读不写**：
   *    不是 LDO 就记个标志位完事，绝不替板子的硬件做决定。 */
  if ((PWR_CR3 & (PWR_CR3_LDOEN | PWR_CR3_BYPASS)) != PWR_CR3_LDOEN)
    g_clk_err |= CLK_ERR_SUPPLY_NOLDO;

  /* 2) VOS0（Scale 0）：280MHz 必需。H7B0 没有 H743 那个 SYSCFG_PWRCR.ODEN 开关。 */
  PWR_SRDCR = (PWR_SRDCR & ~PWR_SRDCR_VOS_MASK) | PWR_SRDCR_VOS0;
  if (!wait_field(PWR_BASE + 0x18u, PWR_SRDCR_VOSRDY, PWR_SRDCR_VOSRDY, WAIT_SPINS))
    g_clk_err |= CLK_ERR_VOSRDY;

  /* 3) Flash 等待周期**先给够再升频**：取 SDK 用的 7 等待 + WRHIGHFREQ 高频档 */
  FLASH_ACR = (FLASH_ACR & ~0x3Fu)
            | FLASH_ACR_LATENCY(FLASH_ACR_LATENCY_280MHZ)
            | FLASH_ACR_WRHIGHFREQ(FLASH_ACR_WRHIGHFREQ_HI);

  /* 4) 总线分频：CPU/AXI/HCLK 全 /1（280MHz），APB1~4 /2（140MHz）—— 与 SDK 一致。
   *    CDCFGR1: HPRE[3:0] CDPPRE(APB3)[6:4] CDCPRE[11:8]
   *    CDCFGR2: CDPPRE1(APB1)[6:4] CDPPRE2(APB2)[10:8]
   *    SRDCFGR: SRDPPRE(APB4)[6:4]        分频值 4 = /2 */
  RCC_CDCFGR1 = (RCC_CDCFGR1 & ~0x00000FF0u) | (4u << 4);
  RCC_CDCFGR2 = (RCC_CDCFGR2 & ~0x00000FF0u) | (4u << 4) | (4u << 8);
  RCC_SRDCFGR = (RCC_SRDCFGR & ~0x00000070u) | (4u << 4);

  /* 5)/6) 只有在 **VOS0 确实生效** 时才敢上 280MHz。
   *    超频档配错电压会跑飞，而且飞法很难查 —— 宁可老实用 64MHz，换来确定性。 */
  if (!(g_clk_err & CLK_ERR_VOSRDY)){
    /* 5) 首选：HSE 25MHz → 5MHz 参考 → ×112 = 560MHz VCO → /2 = 280MHz */
    RCC_CR |= RCC_CR_HSEON;
    if (wait_field(RCC_BASE + 0x00u, RCC_CR_HSERDY, RCC_CR_HSERDY, WAIT_SPINS)){
      pll1_config(RCC_PLLCKSELR_PLLSRC_HSE, 5u, 112u, 2u);
      r = pll1_start_and_switch();
      if (r == 0){
        g_clk_src = CLK_SRC_HSE_PLL;
        g_sysclk_hz = SYSCLK_HZ;
        return;
      }
      g_clk_err |= (r == 1) ? CLK_ERR_PLL_RDY_HSE : CLK_ERR_SW_HSE;
      pll1_stop();
    } else {
      g_clk_err |= CLK_ERR_HSE_RDY;
    }

    /* 6) 后备：HSI 64MHz → /8 = 8MHz 参考 → ×70 = 560MHz VCO → /2 = 280MHz */
    RCC_CR |= RCC_CR_HSION;
    (void)wait_field(RCC_BASE + 0x00u, RCC_CR_HSIRDY, RCC_CR_HSIRDY, WAIT_SPINS);
    pll1_config(RCC_PLLCKSELR_PLLSRC_HSI, 8u, 70u, 3u);
    r = pll1_start_and_switch();
    if (r == 0){
      g_clk_src = CLK_SRC_HSI_PLL;
      g_sysclk_hz = SYSCLK_HZ;
      return;
    }
    g_clk_err |= (r == 1) ? CLK_ERR_PLL_RDY_HSI : CLK_ERR_SW_HSI;
    pll1_stop();
  }

  /* 7) 保命档：HSI 64MHz 直出。慢，但 RTT 一定能跑起来 —— 能跑就能读 g_clk_err 定位问题 */
  RCC_CFGR = (RCC_CFGR & ~RCC_CFGR_SW_MASK) | 0u;      /* SW = HSI */
  if (!wait_field(RCC_BASE + 0x10u, RCC_CFGR_SWS_MASK, 0u, WAIT_SPINS))
    g_clk_err |= CLK_ERR_SW_HSI;
  g_clk_src = CLK_SRC_HSI;
  g_clk_err |= CLK_ERR_FALLBACK;
  g_sysclk_hz = HSI_HZ;
}

int main(void){
  /* 调试时让时钟继续跑（停住内核不冻结时钟），排查时钟问题少走弯路 */
  DBGMCU_CR |= DBGMCU_CR_DBG_CLOCKS;

#ifndef HSI_64MHZ_ONLY
  clock_init_280mhz();
#else
  g_clk_src = CLK_SRC_HSI;                       /* 保命档：不求快，只求能跑 */
  g_sysclk_hz = HSI_HZ;
#endif

  /* 1ms 心跳（SysTick 走 CPU 时钟，所以重载值随主频变） */
  SYST_RVR = (g_sysclk_hz / SYSTICK_HZ) - 1u;
  SYST_CVR = 0;
  SYST_CSR = 7;

  SEGGER_RTT_Init();
  SEGGER_RTT_WriteString(0, "\r\n=== RTT 吞吐测试（STM32H7B0）: BLOCK_IF_FIFO_FULL，死循环发 hello world ===\r\n");
  /* 把时钟结果**也发一句**：不接调试器、纯靠 RTT 就能看出跑在哪条路径上 */
  SEGGER_RTT_WriteString(0, (g_clk_err == 0) ? "clock: ok (280MHz, no fallback)\r\n"
                                             : "clock: FALLBACK/ERROR -> see g_clk_err\r\n");

  static const char msg[] = "hello world!\n";          /* 13 字节 */
  for (;;){
    unsigned n = SEGGER_RTT_Write(0, msg, sizeof(msg) - 1);
    g_bytes += n;                                      /* 阻塞模式下 n 恒等于 13 */
    g_loops++;
  }
}
