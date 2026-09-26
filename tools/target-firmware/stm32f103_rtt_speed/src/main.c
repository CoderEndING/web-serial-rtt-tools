/*
 * STM32F103 · SEGGER RTT **吞吐测试固件**
 *
 *   while(1) 里死循环发 "hello world!\n"，**不加任何延时**、不碰串口。
 *   RTT 用 BLOCK_IF_FIFO_FULL（见 segger_rtt/SEGGER_RTT_Conf.h）：缓冲满就阻塞 ——
 *   于是目标写多快**完全由主机取多快决定**，主机读到的字节/秒就是 RTT 的实际吞吐。
 *   这正是"拿同一块板子对比 WebUSB 与 OpenOCD 两条主机通路"的干净做法。
 *
 * 三个全局量留给主机读（交叉验证用）：
 *   g_bytes —— 目标实际写出去的字节数（阻塞模式下应当 ≈ 主机读到的字节数）
 *   g_loops —— 循环次数（×13 = g_bytes）
 *   g_ms    —— SysTick 毫秒数（**判断目标是否还活着**：阻塞在 RTT 写里时它照样在走，
 *              所以它不涨才是真卡死，而不是"在等主机读"）
 */
#include <stdint.h>

#include "stm32f103_regs.h"
#include "SEGGER_RTT.h"

volatile uint32_t g_bytes;
volatile uint32_t g_loops;
volatile uint32_t g_ms;

void SysTick_Handler(void){ g_ms++; }

int main(void){
  /* 只开时钟，不碰任何外设：这条通路越干净，量出来的数字越可信 */
  RCC_APB2ENR |= RCC_APB2ENR_AFIOEN | RCC_APB2ENR_IOPAEN | RCC_APB2ENR_IOPCEN;
  SYST_RVR = 8000 - 1;
  SYST_CVR = 0;
  SYST_CSR = 7;

  SEGGER_RTT_Init();
  SEGGER_RTT_WriteString(0, "\r\n=== RTT 吞吐测试：BLOCK_IF_FIFO_FULL，死循环发 hello world ===\r\n");

  static const char msg[] = "hello world!\n";          /* 13 字节 */
  for (;;){
    unsigned n = SEGGER_RTT_Write(0, msg, sizeof(msg) - 1);
    g_bytes += n;                                      /* 阻塞模式下 n 恒等于 13 */
    g_loops++;
  }
}
