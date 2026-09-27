/*
 * STM32H7B0（Cortex-M7）最小寄存器定义 —— 只够跑 RTT 吞吐测试用。
 *
 * 为什么手写而不用 ST 的 HAL/CMSIS 头：这份例程要能"一条 gcc 命令就编出来"，
 * 不引入任何外部依赖（和 stm32f103_rtt_speed 一个套路）。所以只列出本工程真正碰的寄存器。
 *
 * 地址出处：RM0455（STM32H7A3/7B3/7B0 参考手册）内存映射一章；与 H743(RM0433) 不完全一样，
 * 尤其是 PWR/FLASH 的细节 —— 改这块务必对着 RM0455 核对。
 */
#ifndef STM32H7B0_REGS_H
#define STM32H7B0_REGS_H

#include <stdint.h>

#define REG32(addr) (*(volatile uint32_t *)(uintptr_t)(addr))

/* ---------------- RCC（0x58024400）---------------- */
#define RCC_BASE        0x58024400u
#define RCC_CR          REG32(RCC_BASE + 0x00)   /* HSION/HSIRDY/HSIDIV… */
#define RCC_CFGR        REG32(RCC_BASE + 0x10)   /* SW / D1CPRE / HPRE / APB 分频 */
#define RCC_D1CFGR      REG32(RCC_BASE + 0x18)
#define RCC_D2CFGR      REG32(RCC_BASE + 0x1C)
#define RCC_D3CFGR      REG32(RCC_BASE + 0x20)
#define RCC_PLLCKSELR   REG32(RCC_BASE + 0x28)   /* PLLSRC / DIVM1 */
#define RCC_PLLCFGR     REG32(RCC_BASE + 0x2C)   /* PLL1RGE / DIVP1EN … */
#define RCC_PLL1DIVR    REG32(RCC_BASE + 0x30)   /* DIVN1 / DIVP1 / DIVQ1 / DIVR1 */
#define RCC_PLL1FRACR   REG32(RCC_BASE + 0x34)
#define RCC_CR_HSION    (1u << 0)
#define RCC_CR_HSIRDY   (1u << 2)
#define RCC_CR_PLL1ON   (1u << 24)
#define RCC_CR_PLL1RDY  (1u << 25)
#define RCC_CFGR_SW_PLL1  0x3u                   /* SW[2:0] = 011 → PLL1 做系统时钟 */
#define RCC_CFGR_SWS_MASK 0x38u                  /* SWS[2:0]，0x18 = PLL1 生效 */

/* ---------------- PWR（0x58024800）----------------
 * RM0455 的 PWR 与 H743 布局相近：D3CR 里 VOS[15:14]。
 * 280MHz 必须 VOS0（0b11），而 VOS0 还要先开 SYSCFG_PWRCR.ODEN。 */
#define PWR_BASE        0x58024800u
#define PWR_D3CR        REG32(PWR_BASE + 0x18)
#define PWR_D3CR_VOS_MASK  0xC000u
#define PWR_D3CR_VOS0      0xC000u               /* 0b11 << 14 = Scale 0 */
#define PWR_D3CR_VOSRDY    (1u << 13)

#define SYSCFG_BASE     0x58000400u
#define SYSCFG_PWRCR    REG32(SYSCFG_BASE + 0x04)
#define SYSCFG_PWRCR_ODEN (1u << 0)               /* Over-drive 使能 */

/* ---------------- FLASH（0x52002000）----------------
 * ACR：LATENCY[3:0] + WRHIGHFREQ[5:4]。
 * 🚨 LATENCY 宁可**给大**（多等几个周期只是慢，给少了会读到错指令）；这里按 VOS0/280MHz
 *    取 4（RM0455 表里 280MHz 对应 3~4，取 4 安全），WRHIGHFREQ = 0b10（185 < HCLK ≤ 285）。 */
#define FLASH_BASE      0x52002000u
#define FLASH_ACR       REG32(FLASH_BASE + 0x00)
#define FLASH_ACR_LATENCY(n)   ((n) & 0x0Fu)
#define FLASH_ACR_WRHIGHFREQ(n) (((n) & 0x3u) << 4)

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
#define HSI_HZ          64000000u                /* H7 的 HSI 就是 64MHz（不用外部晶振） */
#define SYSCLK_HZ       280000000u               /* 目标主频（VOS0 + PLL1P） */
#define SYSTICK_HZ      1000u                    /* 1ms 心跳，用来判目标死活 */

#endif /* STM32H7B0_REGS_H */
