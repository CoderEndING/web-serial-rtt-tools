/*
 * STM32H7B0（Cortex-M7 @280MHz）· SEGGER RTT **吞吐测试固件**
 *
 *   while(1) 里死循环发 "hello world!\n"，**不加任何延时、不碰串口**。
 *   RTT 用 BLOCK_IF_FIFO_FULL（见 segger_rtt/SEGGER_RTT_Conf.h）：缓冲满就阻塞 ——
 *   于是目标写多快**完全由主机取多快决定**，主机读到的字节/秒就是 RTT 的实际吞吐。
 *   这是"同一块板子对比 WebUSB 与 OpenOCD 两条主机通路"的干净做法。
 *
 * 与 stm32f103_rtt_speed 的差别（都是 H7 特有的，踩过才知道）：
 *   ① 时钟：H7B0 的 HSI 就是 **64MHz**，不用外部晶振也能跑满 280MHz ——
 *      自定义板子常常没焊 HSE，所以默认走 HSI→PLL1（见 clock_280mhz_hsi()）。
 *      板上有 8/16/25MHz 晶振、想更准的话，把 HSE 那段打开即可（代码里留了位置）。
 *   ② 内存：RTT 缓冲放 **DTCM（0x20000000 起）** —— 内核直连、零等待，且不用开任何
 *      外设时钟；AXI SRAM(0x24000000)/AHB SRAM(0x30000000) 也够用，但要额外开时钟。
 *      链接脚本 ld/stm32h7b0.ld 已经把 .data/.bss/栈都放 DTCM。
 *   ③ VOS0：280MHz 属于"超频档"，必须先 SYSCFG_PWRCR.ODEN=1 再把 PWR_D3CR.VOS 设成 0b11，
 *      否则 PLL 输出再高内核也上不去（现象：跑起来就 HardFault / 时钟没切过去）。
 *   ④ 编译开关 `-DHSI_64MHZ_ONLY=1`：完全不碰 PLL/VOS，直接用 64MHz 跑。
 *      280MHz 起不来时先编这个版本，能把"时钟没配对"和"别的问题"分开 —— bring-up 保命用。
 *
 * 三个全局量留给主机读（交叉验证用）：
 *   g_bytes —— 目标实际写出去的字节数（阻塞模式下应当 ≈ 主机读到的字节数）
 *   g_loops —— 循环次数（×13 = g_bytes）
 *   g_ms    —— SysTick 毫秒数（**判断目标是否还活着**：阻塞在 RTT 写里时它照样在走，
 *              所以它不涨才是真卡死，而不是"在等主机读"）
 */
#include <stdint.h>

#include "stm32h7b0_regs.h"
#include "SEGGER_RTT.h"

volatile uint32_t g_bytes;
volatile uint32_t g_loops;
volatile uint32_t g_ms;
volatile uint32_t g_sysclk_hz;        /* 实际切过去的系统时钟（主机读它核对） */

void SysTick_Handler(void){ g_ms++; }

/* 简单延时（用循环，不依赖定时器）：切换时钟前后都要给稳压器/Flash 留时间 */
static void delay_loop(volatile uint32_t n){ while (n--) __asm__ volatile("nop"); }

/**
 * HSI(64MHz) → PLL1 → 280MHz（VOS0）。
 *
 * PLL1 计算：ref = HSI / DIVM1 = 64MHz / 8 = 8MHz
 *            VCO = ref × DIVN1 = 8MHz × 70 = 560MHz（必须在 192~836MHz 的宽量程内）
 *            SYSCLK = VCO / DIVP1 = 560MHz / 2 = 280MHz
 * DIVM1/DIVN1/DIVP1 都是"值 - 1"写进去，别写成实际值（第一版就栽在这）。
 */
static void clock_280mhz_hsi(void){
  /* 0) 🚨 先把 **SYSCFG 与 PWR 的时钟打开**。
   *    这两句最容易漏：复位后 RCC_APB4ENR = 0，PWR/SYSCFG 的寄存器写**会被直接忽略**
   *    （不报错、也不生效），现象就是"PLL 配了但内核频率没变 / 一跑就 HardFault"。
   *    ST 的 HAL 里 `__HAL_RCC_PWR_CLK_ENABLE()` + `__HAL_RCC_SYSCFG_CLK_ENABLE()` 干的就是这事。 */
  RCC_APB4ENR |= RCC_APB4ENR_SYSCFGEN | RCC_APB4ENR_PWREN;

  /* 1) 打开 HSI 并等就绪（复位后本来就在跑，这里只是确凿一点） */
  RCC_CR |= RCC_CR_HSION;
  while (!(RCC_CR & RCC_CR_HSIRDY)) { }

  /* 2) 提高 Flash 等待周期**再**升频：LATENCY 给 4（宁大不小），WRHIGHFREQ 按 185~285MHz 档 */
  FLASH_ACR = (FLASH_ACR & ~0x3Fu) | FLASH_ACR_LATENCY(4) | FLASH_ACR_WRHIGHFREQ(2);

  /* 3) VOS0：先允许 over-drive，再把 VOS 设成 Scale 0，等 VOSRDY */
  SYSCFG_PWRCR |= SYSCFG_PWRCR_ODEN;
  PWR_D3CR = (PWR_D3CR & ~PWR_D3CR_VOS_MASK) | PWR_D3CR_VOS0;
  while (!(PWR_D3CR & PWR_D3CR_VOSRDY)) { }
  delay_loop(20000);

  /* 4) 配 PLL1：源 = HSI，DIVM1 = 8 → 8MHz 参考；DIVN1 = 70；DIVP1 = 2 */
  RCC_PLLCKSELR = (0u << 6)                      /* PLLSRC = 00：HSI */
                | (8u - 1u);                     /* DIVM1 = /8 */
  RCC_PLL1FRACR = 0;                             /* 不用小数分频 */
  RCC_PLLCFGR = (3u << 0)                        /* PLL1RGE = 0b11：8~16MHz 参考 */
              | (1u << 16);                      /* DIVP1EN = 1：要 PLL1P 输出（CPU 时钟走它） */
  RCC_PLL1DIVR = ((70u - 1u) << 0)               /* DIVN1 */
               | ((2u - 1u) << 9)                /* DIVP1 */
               | ((2u - 1u) << 16)               /* DIVQ1（不用，填合法值） */
               | ((2u - 1u) << 24);              /* DIVR1（不用） */
  RCC_CR |= RCC_CR_PLL1ON;
  while (!(RCC_CR & RCC_CR_PLL1RDY)) { }

  /* 5) 切系统时钟到 PLL1；D1CPRE/HPRE 保持 /1（复位默认就是 1 分频） */
  RCC_D1CFGR = 0;                                /* D1CPRE=1, HPRE=1 */
  RCC_D2CFGR = 0;
  RCC_D3CFGR = 0;
  RCC_CFGR = (RCC_CFGR & ~0x7u) | RCC_CFGR_SW_PLL1;
  while ((RCC_CFGR & RCC_CFGR_SWS_MASK) != (RCC_CFGR_SW_PLL1 << 3)) { }
  g_sysclk_hz = SYSCLK_HZ;
}

int main(void){
  /* 调试时让时钟继续跑（停住内核不冻结时钟），排查时钟问题少走弯路 */
  DBGMCU_CR |= DBGMCU_CR_DBG_CLOCKS;

#ifndef HSI_64MHZ_ONLY
  clock_280mhz_hsi();
#else
  g_sysclk_hz = HSI_HZ;                          /* 保命档：不求快，只求能跑 */
#endif

  /* 1ms 心跳（SysTick 走 CPU 时钟，所以重载值随主频变） */
  SYST_RVR = (g_sysclk_hz / SYSTICK_HZ) - 1u;
  SYST_CVR = 0;
  SYST_CSR = 7;

  SEGGER_RTT_Init();
  SEGGER_RTT_WriteString(0, "\r\n=== RTT 吞吐测试（STM32H7B0）: BLOCK_IF_FIFO_FULL，死循环发 hello world ===\r\n");

  static const char msg[] = "hello world!\n";          /* 13 字节 */
  for (;;){
    unsigned n = SEGGER_RTT_Write(0, msg, sizeof(msg) - 1);
    g_bytes += n;                                      /* 阻塞模式下 n 恒等于 13 */
    g_loops++;
  }
}
