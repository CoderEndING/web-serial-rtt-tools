/*
 * STM32H7B0（Cortex-M7）最小寄存器定义 —— 只够跑 RTT 吞吐测试用。
 *
 * 为什么手写而不用 ST 的 HAL/CMSIS 头：这份例程要能"一条 gcc 命令就编出来"，
 * 不引入任何外部依赖（和 stm32f103_rtt_speed 一个套路）。所以只列出本工程真正碰的寄存器。
 *
 * ⚠️ 地址与位域出处（**别再照抄 H743/RM0433**）：H7A3/B3/B0 这一代（RM0455）改了不少寄存器
 *    布局，第一版按 H743 写，结果 PLL 死活锁不上（详见 README「踩坑」第 10 条）。本文件的每个
 *    定义都与板子自带 SDK 的 `stm32h7b0xx.h` 逐条核对过：
 *      E:\Share\STM32H7B0VBT6 KIT\SDK\DEMO\USART\Drivers\CMSIS\Device\ST\STM32H7xx\Include\stm32h7b0xx.h
 *    改这里之前，务必回那份头文件（或 RM0455）再核一遍。
 *
 * 与 H743 的关键差异（本工程踩过的）：
 *   ① RCC_PLLCKSELR：**PLLSRC 在 bit[1:0]、DIVM1 在 bit[9:4]**（H743 是 PLLSRC[23:22]、DIVM1[5:0]）。
 *      照 H743 写 → 硬件把低两位当成 PLLSRC（=HSE，没晶振就完全没输入）→ PLL 永不锁定。
 *   ② RCC_APB4ENR 偏移是 **0xF4**（H743 是 0x6C，那在 H7B0 上是保留/别的寄存器）。
 *   ③ PLLCFGR：**VCOSEL=0 才是宽量程**（192~836MHz），RGE[3:2] 选参考频率档。
 *   ④ PWR 里没有 "D3CR" 了，叫 **SRDCR**（VOS[15:14] / VOSRDY[13]）；也**没有** SYSCFG_PWRCR.ODEN
 *      这个超频开关（那是 H743 的东西，H7B0 上不需要）。
 */
#ifndef STM32H7B0_REGS_H
#define STM32H7B0_REGS_H

#include <stdint.h>

#define REG32(addr) (*(volatile uint32_t *)(uintptr_t)(addr))

/* ---------------- RCC（0x58024400）---------------- */
#define RCC_BASE        0x58024400u
#define RCC_CR          REG32(RCC_BASE + 0x00)   /* HSION[0] HSIRDY[2] HSIDIV[4:3] HSEON[16] HSERDY[17] PLL1ON[24] PLL1RDY[25] */
#define RCC_CFGR        REG32(RCC_BASE + 0x10)   /* SW[2:0] / SWS[5:3] */
#define RCC_CDCFGR1     REG32(RCC_BASE + 0x18)   /* HPRE[3:0] CDPPRE[6:4](APB3) CDCPRE[11:8] */
#define RCC_CDCFGR2     REG32(RCC_BASE + 0x1C)   /* CDPPRE1[6:4](APB1) CDPPRE2[10:8](APB2) */
#define RCC_SRDCFGR     REG32(RCC_BASE + 0x20)   /* SRDPPRE[6:4](APB4) */
#define RCC_PLLCKSELR   REG32(RCC_BASE + 0x28)   /* 🚨 PLLSRC[1:0] / DIVM1[9:4]（不是 H743 的 [23:22]/[5:0]！） */
#define RCC_PLLCFGR     REG32(RCC_BASE + 0x2C)   /* FRACEN[0] VCOSEL[1] RGE[3:2] DIVP1EN[16] DIVQ1EN[17] DIVR1EN[18] */
#define RCC_PLL1DIVR    REG32(RCC_BASE + 0x30)   /* N1[8:0] P1[15:9] Q1[22:16] R1[30:24] */
#define RCC_PLL1FRACR   REG32(RCC_BASE + 0x34)
#define RCC_APB4ENR     REG32(RCC_BASE + 0xF4)   /* 🚨 0xF4，不是 0x6C！SYSCFGEN = bit1 */

#define RCC_CR_HSION    (1u << 0)
#define RCC_CR_HSIRDY   (1u << 2)
#define RCC_CR_HSEON    (1u << 16)
#define RCC_CR_HSERDY   (1u << 17)
#define RCC_CR_PLL1ON   (1u << 24)
#define RCC_CR_PLL1RDY  (1u << 25)

#define RCC_APB4ENR_SYSCFGEN (1u << 1)

#define RCC_CFGR_SW_MASK   0x7u
#define RCC_CFGR_SW_PLL1   0x3u                  /* SW[2:0] = 011 → PLL1 做系统时钟 */
#define RCC_CFGR_SWS_MASK  0x38u
#define RCC_CFGR_SWS_PLL1  0x18u                 /* SWS[2:0] = 011 → PLL1 已生效 */

/* PLLCKSELR */
#define RCC_PLLCKSELR_PLLSRC_HSI  0x0u           /* PLLSRC[1:0]：00=HSI 01=CSI 10=HSE */
#define RCC_PLLCKSELR_PLLSRC_CSI  0x1u
#define RCC_PLLCKSELR_PLLSRC_HSE  0x2u
#define RCC_PLLCKSELR_DIVM1_SHIFT 4u             /* DIVM1[9:4]：写入 分频值-1 */

/* PLLCFGR */
#define RCC_PLLCFGR_PLL1FRACEN (1u << 0)
#define RCC_PLLCFGR_PLL1VCOSEL (1u << 1)         /* 0 = 宽量程 192~836MHz（我们要的） */
#define RCC_PLLCFGR_PLL1RGE_SHIFT 2u             /* 00:1~2MHz 01:2~4 10:4~8 11:8~16 */
#define RCC_PLLCFGR_DIVP1EN    (1u << 16)
#define RCC_PLLCFGR_DIVQ1EN    (1u << 17)
#define RCC_PLLCFGR_DIVR1EN    (1u << 18)

/* ---------------- PWR（0x58024800）----------------
 * H7B0 上用 CR3 选供电来源（LDO），SRDCR 设电压档 VOS[15:14]：
 *   VOS0 = 0b11 = 0xC000 → 280MHz 必需。写完等 VOSRDY[13]。
 *   （H743 那套 "先 SYSCFG_PWRCR.ODEN=1" 在 H7B0 上不存在，别照搬。） */
#define PWR_BASE        0x58024800u
#define PWR_CSR1        REG32(PWR_BASE + 0x04)   /* ACTVOSRDY[13] */
#define PWR_CR3         REG32(PWR_BASE + 0x08)   /* LDOEN[1] BYPASS[0] */
#define PWR_SRDCR       REG32(PWR_BASE + 0x18)   /* VOS[15:14] VOSRDY[13] */

#define PWR_CR3_LDOEN          (1u << 1)
#define PWR_CR3_BYPASS         (1u << 0)
#define PWR_CSR1_ACTVOSRDY     (1u << 13)
#define PWR_SRDCR_VOS_MASK     0xC000u
#define PWR_SRDCR_VOS0         0xC000u           /* 0b11 << 14 = Scale 0 */
#define PWR_SRDCR_VOSRDY       (1u << 13)

#define SYSCFG_BASE     0x58000400u              /* 本工程只用来确认 APB4 时钟使能是否生效 */

/* ---------------- FLASH（0x52002000）----------------
 * ACR：LATENCY[3:0] + WRHIGHFREQ[5:4]（Flash 信号延时档）。
 * 取值直接跟板子 SDK 对齐：HAL_RCC_ClockConfig(..., FLASH_LATENCY_7) →
 *   LATENCY = 7；WRHIGHFREQ = 0b11（HAL 里 FLASH_PROGRAMMING_DELAY_3，即"启动/高频档"）。
 * 🚨 LATENCY 宁大不小：给少了会取到错指令（现象千奇百怪，极难查）。 */
#define FLASH_BASE      0x52002000u
#define FLASH_ACR       REG32(FLASH_BASE + 0x00)
#define FLASH_ACR_LATENCY(n)     ((n) & 0x0Fu)
#define FLASH_ACR_WRHIGHFREQ(n)  (((n) & 0x3u) << 4)
#define FLASH_ACR_LATENCY_280MHZ 7u
#define FLASH_ACR_WRHIGHFREQ_HI  3u

/* ---------------- DBGMCU（0x5C001000）----------------
 * 让内核在调试器停住时**时钟继续跑**（否则调试时定时器/时钟状态会变，排查容易误判）。 */
#define DBGMCU_BASE     0x5C001000u
#define DBGMCU_CR       REG32(DBGMCU_BASE + 0x04)
#define DBGMCU_CR_DBG_CLOCKS 0x7u                /* D1/D2/D3 域时钟保持 */

/* ---------------- Cortex-M7 内核外设 ---------------- */
#define SYST_CSR        REG32(0xE000E010u)
#define SYST_RVR        REG32(0xE000E014u)
#define SYST_CVR        REG32(0xE000E018u)
#define DHCSR           REG32(0xE000EDF0u)
#define DEMCR           REG32(0xE000EDFCu)

/* ---------------- 本板时钟目标 ---------------- */
#define HSE_HZ          25000000u                /* 板载晶振 25MHz（SDK .ioc: RCC.HSE_VALUE=25000000） */
#define HSI_HZ          64000000u                /* H7 的 HSI 就是 64MHz（无晶振时的后备） */
#define SYSCLK_HZ       280000000u               /* 目标主频（VOS0 + PLL1P） */
#define SYSTICK_HZ      1000u                    /* 1ms 心跳，用来判目标死活 */

/* 时钟路径（g_clk_src） */
#define CLK_SRC_HSE_PLL 0u                       /* 25MHz 晶振 → PLL → 280MHz（正常路径） */
#define CLK_SRC_HSI_PLL 1u                       /* HSI 64MHz → PLL → 280MHz（晶振没起振时的后备） */
#define CLK_SRC_HSI    2u                        /* 直接 HSI 64MHz（PLL 也起不来时的保命档） */

/* 时钟初始化出错位（g_clk_err），用于**不接串口也能知道卡在哪一步** */
#define CLK_ERR_ACTVOSRDY   (1u << 0)
#define CLK_ERR_VOSRDY      (1u << 1)
#define CLK_ERR_HSE_RDY     (1u << 2)
#define CLK_ERR_PLL_RDY_HSE (1u << 3)
#define CLK_ERR_SW_HSE      (1u << 4)
#define CLK_ERR_PLL_RDY_HSI (1u << 5)
#define CLK_ERR_SW_HSI      (1u << 6)
#define CLK_ERR_FALLBACK    (1u << 7)            /* 最终退到 HSI 64MHz，没跑到 280MHz */
#define CLK_ERR_SUPPLY_NOLDO (1u << 8)           /* PWR_CR3 显示供电不是 LDO（只报警，**不改**） */

#endif /* STM32H7B0_REGS_H */
