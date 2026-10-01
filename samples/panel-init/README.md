# 面板初始化样例（`samples/panel-init`）

给网页「SPI/QSPI 屏」页（`#panel`）用的**面板初始化序列** —— 全是标准 C 数组，
**整段贴进页面的『面板初始化』大框**就能解析（页面解析器吃的就是 C 数组，注释会被剥掉）。

| 文件 | 屏 | 规模 | 来源 |
|---|---|---|---|
| `gc9a01_init_cmds.h` | GC9A01（圆屏；模块常见规格 1.28 吋 / 240×240）· SPI + DC · RGB565 · 48 MHz | **43 条命令 / 参数 134 B** | `E:\esp-idf-wsh\资料\panel_init\dumps\gc9a01.json`（提取自 SiFli-SDK `customer/peripherals/gc9a01/gc9a01.c`；该驱动在 SDK 里的注册名是 `ST7789V_GMT024`） |

## 怎么用

1. 打开网页 →「**SPI/QSPI 屏**」页 → 找到「**面板初始化**」大框；
2. 把整个 `.h` 的内容**整段粘进去**；
3. 点「解析并预览」→ 表里逐条列出命令与参数，可直接「重放全部」；
4. 几何（宽×高）、档位（`spi_dcx` / `qspi`）、RST/BL 脚在页面上另外选。

## 怎么重新生成

由 `tools/dev/panel-json-to-c.mjs` 从 SiFli-SDK 的 dump JSON 生成（44 份 dump 都在那个目录）：

```powershell
node tools/dev/panel-json-to-c.mjs gc9a01 --note="圆屏模块常见规格 1.28 吋 240×240"
node tools/dev/panel-json-to-c.mjs --all          # 44 份全导（给别的屏用）
```

## ⚠️ 两个坑（生成的文件头注释里也写着）

- **表内没有延时项**，也**不含 `0x11`（sleep out）/ `0x29`（display on）** —— SDK 驱动把它们写在
  初始化表**外面**。上屏前自己补：`0x11` → 等 ≥120 ms → `0x29`；GC9A01 这类 IPS 圆屏模块
  通常还要先发 `0x21` 开**反显**，颜色才正。
- dump 里的 `res_w` / `res_h` 常常是 `null`（分辨率取自板级宏），**别当成已知值**；
  文件头那行"常见规格"只是提示，实际以你手上模块为准。

> 校验方式：把文件交给页面同款解析器（`app/spi/panel-code.js` 的 `parsePanelCode`），
> 断言"43 条 / 参数 134 B / 0 错误"，并与 dump 逐条对账 —— 见
> `tools/selftest/spi-panel-code.test.mjs` 里的「samples 样例」一节。
