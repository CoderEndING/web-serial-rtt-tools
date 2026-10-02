/*
 * STM32H743（Cortex-M7）最小寄存器定义 —— 只够跑「J-Scope 采样靶子」这份固件用。
 *
 * 为什么手写而不用 ST 的 HAL/CMSIS 头：这份例程要能"一条 gcc 命令就编出来"、不引任何外部依赖
 * （与 stm32f103_scope / stm32h7b0_rtt_speed 同一套路）。
 *
 * ---------------------------------------------------------------------------
 * 地址与位域的出处（都是本机能查到的实物，**别再凭记忆改**）：
 *   ① 正点原子阿波罗 H743 标准例程里的 CMSIS 头（ST 原版 stm32h743xx.h）：
 *        RCC_BASE  = D3_AHB1PERIPH_BASE(0x58020000) + 0x4400 = 0x58024400
 *        PWR_BASE  = D3_AHB1PERIPH_BASE + 0x4800 = 0x58024800
 *        FLASH_BASE= 0x52002000      DBGMCU_BASE = 0x5C001000
 *        RCC 偏移：CR 0x00 / CFGR 0x10 / D1CFGR 0x18 / D2CFGR 0x1C / D3CFGR 0x20
 *                  PLLCKSELR 0x28 / PLLCFGR 0x2C / PLL1DIVR 0x30 / PLL1FRACR 0x34
 *   ② 同一份头文件里的位域（逐条核过）：
 *        PLLCKSELR : PLLSRC[1:0]（10 = HSE）、DIVM1[9:4]
 *                    🚨 字段里放的就是**分频值本身**，不是"分频值-1"！
 *                    依据：`__HAL_RCC_PLL_CONFIG` 宏直接写 `(__PLLM1__) << 4U`，
 *                    且 HAL_RCC_GetSysClockFreq 里 `pllm = (PLLCKSELR & DIVM1) >> 4`
 *                    之后**直接做除**（N/P/Q/R 才会有 `-1`）。
 *        PLL1DIVR  : N1[8:0] / P1[15:9] / Q1[22:16] / R1[30:24] —— 这四个才是"值-1"
 *        PLLCFGR   : FRACEN[0] / VCOSEL[1]（0 = 宽量程 192~836MHz）/ RGE[3:2]
 *                    （00:1~2MHz 01:2~4 10:4~8 11:8~16）/ DIVP1EN[16] / DIVQ1EN[17] / DIVR1EN[18]
 *        D1CFGR    : HPRE[3:0]（AXI/AHB）/ D1PPRE[6:4]（APB3）/ D1CPRE[11:8]（CPU）
 *                    ⚠️ 顺序是 HPRE 在最低位，**不是** D1CPRE 在最低位（照 RM0455 的 CDCFGR1 抄会错）
 *                    分频编码：0xxx = /1，1000 = /2，1001 = /4，1010 = /8，1011 = /16
 *        D2CFGR    : D2PPRE1[6:4]（APB1）/ D2PPRE2[10:8]（APB2）
 *        D3CFGR    : D3PPRE[6:4]（APB4）
 *        CFGR      : SW[2:0] / SWS[5:3]（011 = PLL1）
 *        PWR_CR3   : SCUEN[2]（供电配置更新使能）
 *        PWR_D3CR  : VOS[15:14] / VOSRDY[13]
 *        FLASH_ACR : LATENCY[3:0] / WRHIGHFREQ[5:4]
 */
#ifndef STM32H743_REGS_H
#define STM32H743_REGS_H

#include <stdint.h>

#define REG32(addr) (*(volatile uint32_t *)(uintptr_t)(addr))

/* ---------------- RCC（0x58024400）---------------- */
#define RCC_BASE        0x58024400u
#define RCC_CR          REG32(RCC_BASE + 0x00)   /* HSION[0] HSIRDY[2] HSEON[16] HSERDY[17] PLL1ON[24] PLL1RDY[25] */
#define RCC_CFGR        REG32(RCC_BASE + 0x10)   /* SW[2:0] / SWS[5:3] */
#define RCC_D1CFGR      REG32(RCC_BASE + 0x18)   /* HPRE[3:0] D1PPRE[6:4] D1CPRE[11:8] */
#define RCC_D2CFGR      REG32(RCC_BASE + 0x1C)   /* D2PPRE1[6:4](APB1) D2PPRE2[10:8](APB2) */
#define RCC_D3CFGR      REG32(RCC_BASE + 0x20)   /* D3PPRE[6:4](APB4) */
#define RCC_PLLCKSELR   REG32(RCC_BASE + 0x28)   /* PLLSRC[1:0] / DIVM1[9:4]（写分频值本身） */
#define RCC_PLLCFGR     REG32(RCC_BASE + 0x2C)   /* FRACEN[0] VCOSEL[1] RGE[3:2] DIVP1EN[16] ... */
#define RCC_PLL1DIVR    REG32(RCC_BASE + 0x30)   /* N1[8:0] P1[15:9] Q1[22:16] R1[30:24]（值-1） */
#define RCC_PLL1FRACR   REG32(RCC_BASE + 0x34)

#define RCC_CR_HSEON    (1u << 16)
#define RCC_CR_HSERDY   (1u << 17)
#define RCC_CR_PLL1ON   (1u << 24)
#define RCC_CR_PLL1RDY  (1u << 25)

#define RCC_CFGR_SW_MASK   0x7u
#define RCC_CFGR_SW_HSI    0x0u
#define RCC_CFGR_SW_PLL1   0x3u
#define RCC_CFGR_SWS_MASK  0x38u
#define RCC_CFGR_SWS_PLL1  0x18u

/* PLLCKSELR */
#define RCC_PLLCKSELR_PLLSRC_HSI  0x0u
#define RCC_PLLCKSELR_PLLSRC_CSI  0x1u
#define RCC_PLLCKSELR_PLLSRC_HSE  0x2u
#define RCC_PLLCKSELR_DIVM1_SHIFT 4u             /* DIVM1[9:4]：写**分频值**（5 = /5） */

/* PLLCFGR */
#define RCC_PLLCFGR_PLL1FRACEN (1u << 0)
#define RCC_PLLCFGR_PLL1VCOSEL (1u << 1)         /* 0 = 宽量程 192~836MHz（我们要的） */
#define RCC_PLLCFGR_PLL1RGE_SHIFT 2u
#define RCC_PLLCFGR_DIVP1EN    (1u << 16)
#define RCC_PLLCFGR_DIVQ1EN    (1u << 17)
#define RCC_PLLCFGR_DIVR1EN    (1u << 18)

/* ---------------- PWR（0x58024800）----------------
 * H743 上用 CR3 选供电来源（复位默认 LDO），D3CR 设电压档 VOS[15:14]。
 * ⚠️ 本文件**只清 SCUEN 这一位**（而且只在它置位时才写），绝不整块写 CR3 ——
 *    无条件写供电寄存器在 H7 上出过"AP 事务恒 WAIT、只能整板断电"的事故
 *    （见 ../stm32h7b0_rtt_speed/RESULTS.md 第 1 条）。 */
#define PWR_BASE        0x58024800u
#define PWR_CR3         REG32(PWR_BASE + 0x08)   /* LDOEN[1] BYPASS[0] SCUEN[2] */
#define PWR_D3CR        REG32(PWR_BASE + 0x18)   /* VOS[15:14] VOSRDY[13]（⚠️ 偏移 0x18，不是 0x10） */

#define PWR_CR3_SCUEN       (1u << 2)
#define PWR_D3CR_VOS_MASK   0xC000u
#define PWR_D3CR_VOS_HIGH   0xC000u              /* 0b11：最高电压档（老文档 Scale1=400MHz / 新文档 Scale0=480MHz） */
#define PWR_D3CR_VOSRDY     (1u << 13)

/* ---------------- FLASH（0x52002000）----------------
 * ACR：LATENCY[3:0] + WRHIGHFREQ[5:4]（Flash 信号延时档）。
 * 🚨 LATENCY 宁大不小：给少了会取到错指令（现象千奇百怪，极难查）。 */
#define FLASH_BASE      0x52002000u
#define FLASH_ACR       REG32(FLASH_BASE + 0x00)
#define FLASH_ACR_LATENCY(n)     ((n) & 0x0Fu)
#define FLASH_ACR_WRHIGHFREQ(n)  (((n) & 0x3u) << 4)

/* ---------------- DBGMCU（0x5C001000）----------------
 * 让内核在调试器停住时**时钟继续跑**（否则排查时钟/时序问题时会误判）。 */
#define DBGMCU_BASE     0x5C001000u
#define DBGMCU_CR       REG32(DBGMCU_BASE + 0x04)
#define DBGMCU_CR_DBG_CLOCKS 0x7u

/* ---------------- Cortex-M7 内核外设 ---------------- */
#define SYST_CSR        REG32(0xE000E010u)
#define SYST_RVR        REG32(0xE000E014u)
#define SYST_CVR        REG32(0xE000E018u)
#define SCB_CCR         REG32(0xE000ED14u)       /* bit16 = DCACHEEN, bit17 = ICACHEEN */
#define SCB_CCR_ICACHE  (1u << 17)
#define SCB_CCR_DCACHE  (1u << 16)
#define SCB_VTOR        REG32(0xE000ED08u)       /* 向量表偏移（RAM 运行版必须显式指过去） */
#define SCB_ICIALLU     REG32(0xE000EF50u)
#define SCB_CPACR       REG32(0xE000ED88u)       /* CP10/CP11 = FPU 访问许可 */
#define FPU_FPCCR       REG32(0xE000EF34u)       /* ASPEN[31] / LSPEN[30] */

/* ---------------- 本板时钟目标 ---------------- */
#define HSE_HZ          25000000u                /* 阿波罗 H743 板载 25MHz 晶振 */
#define HSI_HZ          64000000u                /* H7 的 HSI = 64MHz（无晶振时的后备） */
#define SYSCLK_HZ       400000000u               /* HSE/5 ×160 /2 = 400MHz（VCO 800MHz） */
#define HCLK_HZ         200000000u               /* HPRE=/2，且 D1CPRE 也 =/2 → CPU 与 AXI 同为 200MHz */
#define TICK_HZ         10000u                   /* 采样靶子的时基 */

/* 时钟路径（g_clk_src） */
#define CLK_SRC_HSE_PLL 0u                       /* 25MHz 晶振 → PLL1 → 400MHz（正常路径） */
#define CLK_SRC_HSI     1u                       /* HSI 64MHz 直出（PLL 任一步没成时的保命档） */

/* 时钟初始化出错位（g_clk_err）：不接调试器也能知道卡在哪一步 */
#define CLK_ERR_VOSRDY   (1u << 0)
#define CLK_ERR_HSE_RDY  (1u << 1)
#define CLK_ERR_PLL_RDY  (1u << 2)
#define CLK_ERR_SW_PLL1  (1u << 3)
#define CLK_ERR_FALLBACK (1u << 7)               /* 最终没跑到 400MHz，退在 HSI 64MHz */

#endif /* STM32H743_REGS_H */
