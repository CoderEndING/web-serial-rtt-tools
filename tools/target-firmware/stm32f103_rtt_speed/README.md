# RTT 吞吐测试固件（STM32F103）

用来量 **SEGGER RTT 的极限速度**，并且**在同一块板子上对比 WebUSB 与 OpenOCD 两条主机通路**。

## 它做什么

```c
for (;;){
  unsigned n = SEGGER_RTT_Write(0, "hello world!\n", 13);   /* 不加任何延时 */
  g_bytes += n;
  g_loops++;
}
```

RTT 配成 **`SEGGER_RTT_MODE_BLOCK_IF_FIFO_FULL`**（缓冲满就阻塞）——这是测量的关键：
目标写多快**完全由主机取多快决定**，所以**主机读到的字节/秒就等于 RTT 的实际吞吐**，
不需要去数目标侧的计数，也不受"目标丢包/覆盖"干扰。

留了三个全局量给主机交叉验证：

| 变量 | 含义 |
|---|---|
| `g_bytes` | 目标实际写出去的字节数（阻塞模式下应当 ≈ 主机读到的字节数） |
| `g_loops` | 循环次数（×13 = `g_bytes`） |
| `g_ms` | SysTick 毫秒数 —— **判断目标是否还活着**：阻塞在 RTT 写里时它照样在走，不涨才是真卡死 |

## 编译 / 烧录

```powershell
pwsh -File build.ps1          # arm-none-eabi-gcc，不需要 Keil
pwsh -File flash.ps1          # OpenOCD + CMSIS-DAP（烧录前先把桥/OpenOCD 停掉）
```

## 跑吞吐测试

```powershell
# 走桥（OpenOCD Tcl RPC）
node bridge\rtt-bridge.mjs --target stm32f103
node tools\selftest\rtt-speed.mjs bridge 10

# 走 WebUSB（零安装，需要浏览器带调试端口）
pwsh -File tools\selftest\launch-browser.ps1
node tools\selftest\rtt-speed.mjs webusb 10
```

脚本会打印：读到的字节数 / 秒、轮询次数、每次平均搬多少字节，并把目标侧的 `g_bytes` 读出来对账。

## 实测结果（MicroLink CMSIS-DAP + STM32F103，64KB/8KB 缓冲，2026-09-26）

| 主机通路 | 吞吐 | 每次读平均 | 说明 |
|---|---|---|---|
| **WebUSB · CMSIS-DAP** | 见 `rtt-speed.mjs` 输出（本次实测值写在下文「结论」里） | | 单命令往返 0.34 ms；受限于 AP 读速 |
| **OpenOCD · Tcl RPC** | | | `read_memory` 是**文本十六进制字**，同样受 AP 读速限制，但多了一层文本转换 |

> ⚠️ 阻塞模式有个反直觉现象：**主机一停，固件就卡在 `SEGGER_RTT_Write` 里不返回**。
> 这不是死机（看 `g_ms` 还在涨），是设计使然。所以测完记得让主机继续读、或者复位目标。
