# 工程生成页（.uvprojx → 调试配套文件）

第 5 个标签页 `#gen`。目标很简单：**把另一个 Python 工具（`uvprojx2cmake.py`）里"Debug / Download"那一组的产物，
在网页上点几下就拿到**，不用装 Python、不用记命令行。

页面是纯前端：不连串口、不连探针、不需要本地桥。

---

## 1. 怎么用

1. 打开页面 → 顶部「工程生成」。
2. 把 Keil 工程的 `.uvprojx` **拖到页面里**（或点「选择 .uvprojx…」）。
   页面会读 `<Device>`、`<TargetName>`、`<Cpu>` 里的 `IROM(...)`/`IRAM(...)`：
   - **项目名**：拖文件夹进来时取 `.uvprojx` 所在目录名（与 Python 工具一致）；否则取 `<TargetName>`；
   - **器件**：按内置器件表归族（`STM32F103C8` → `STM32F103RB`，与 Python 工具的映射一致）；表外型号原样透传；
   - **Flash 起址**、**PyOCD 目标**、**OpenOCD 目标**：一并填好。
3. 左侧勾选要哪些产物、按需改参数（改动立刻反映到右侧预览）。
4. 右侧「产物」一行切换文件，看内容 / 复制 / 单独下载。
5. 落地：
   - **写入文件夹…**（Edge/Chrome，File System Access API）：选一次目录，多个文件**直接写入**，不打包；
     若目录里已有同名文件，会先列出来问你（勾了「已存在就直接覆盖」才不问）。
   - **打包 ZIP**：不支持上面那个 API 的浏览器走这里，ZIP 落「下载」文件夹。
   - 单独文件也可以只下那一个。

> 浏览器安全模型决定了：网页**不能**静默写你的项目目录，必须由你亲手选一次目录。

---

## 2. 五个产物是什么

| 勾选 | 文件 | 关键 targets / 内容 |
|---|---|---|
| J-Link Makefile | `Makefile.jlink` | `cmake/build/clean` + `jlink-erase`、`jlink-prog`(.hex)、`jlink-prog-bin`(.bin)、`jlink-rtt`(`JLinkRTTLogger`)、`jlink-swo`、`jlink-gdb`(`JLinkGDBServerCL`)、`jlink-debug`(arm-none-eabi-gdb + `jlink_gdb.script`)、`jlink-check`。擦/烧/查这几条是**现场拼一个临时 Commander 脚本**（`@echo r > jlink_prog.script`）跑完即删 |
| GDB 脚本 | `jlink_gdb.script` | `set logging on` / `print pretty` / 清断点，自定义宏 `do_more`（连按 500 次 `next`）、`do_func`（`next` 到 `$sp` 变化 = 跳出函数）；`target remote localhost:3333` → `monitor reset halt` → `load` → `break main` → `continue`。`Makefile.openocd` / `Makefile.pyocd` 里的 `GDB_SCRIPT` 也指向它 |
| PyOCD Makefile | `Makefile.pyocd` | `pyocd-erase/prog/prog-bin(--base-address)/gdb(gdbserver)/rtt(-a <RTT 地址> -d rtt.txt)/reset/debug` |
| OpenOCD Makefile | `Makefile.openocd` | `openocd-erase`(`flash erase_sector 0 0 last`)、`openocd-prog`(elf)、`openocd-prog-bin`、`openocd-gdb`、`openocd-reset/halt`、`openocd-sram`（`load_image test_sram.bin` → `dump_image sram_dump.bin` 回读比对）、`openocd-rtt`（`rtt setup/start ; rtt server start 9090 0`）。`OPENOCD_ROOT` 决定 `$(OPENOCD) = $(OPENOCD_ROOT)/bin/openocd` |
| （随 OpenOCD 附带） | `rtt_logger.py` | 连 `127.0.0.1:9090`、把 RTT 落 `rtt_log.txt`，每秒打印 `Speed / Avg / Total` 的 socket 小脚本 |
| SRAM test bin | `test_sram.bin` | **不是固件**：`bytes(i % 256)` 的递增图案（大小可填，默认 20480），配合 `make -f Makefile.openocd openocd-sram` 量 RAM 读写吞吐 |

---

## 3. 参数对应关系（填的框 → 产物里的哪一行）

| 界面 | 产物里的变量 | 模板默认 |
|---|---|---|
| 项目名 | 文件头注释、`HEX_FILE`/`BIN_FILE`、`add_executable` 名字的来源 | `project` |
| 器件 | `JLINK_DEVICE` | 按器件表推出 |
| Flash 起址 | `loadfile $(BIN_FILE) <addr>`、`pyocd --base-address`、`openocd program $(BIN_FILE) <addr>` | `0x08000000` |
| 接口 | `JLINK_IF` | `SWD` |
| 时钟 kHz | `JLINK_SPEED` | `25000` |
| RTT 地址 / 范围 | `RTT_ADDR` / `RTT_SIZE`（J-Link 的 `-RTTSearchRanges`、OpenOCD 的 `rtt setup`、PyOCD 的 `-a`） | `0x20002000` / `0x5000` |
| GDB 端口 | `GDB_PORT`（三个 Makefile 共用） | `3333` |
| build 目录 | `BUILD_DIR` | `build` |
| CMake 生成器 / 构建类型 | `CMAKE_GENERATOR` / `CMAKE_BUILD_TYPE` | `Ninja` / `Debug` |
| PyOCD 目标 / Hz | `PYOCD_TARGET` / `PYOCD_FREQ` | 按器件表 / `10000000` |
| OpenOCD 根 / 接口 / 目标 / kHz | `OPENOCD_ROOT` / `OPENOCD_INTERFACE` / `OPENOCD_TARGET` / `OPENOCD_FREQ` | MounRiver 路径(*) / `interface/cmsis-dap.cfg` / `target/stm32f1x.cfg` / `10000` |
| RTT 端口 | `RTT_PORT`（`rtt server start`） | `9090` |
| bin 大小 | `test_sram.bin` 字节数 | `20480` |

(*) 页面里 OpenOCD 根目录预填的是**本机 Python 工具自动探测到的那个 MounRiver 路径**；换机器要改成自己的
（OpenOCD 目录里得有 `bin/` 和 `scripts/`）。

**只改你动过的项**：某个框等于模板默认值时，产物里那一行原样保留 —— 所以"填了默认值"和"没填"产出的文件逐字节相同。

---

## 4. 与 Python 工具的一致性（硬指标）

- 模板是**原样移植**的：`app/gen/templates.js` 里就是 `uvprojx2cmake.py` 里那几个
  `JLINK_MAKEFILE_TEMPLATE` / `PYOCD_MAKEFILE_TEMPLATE` / `OPENOCD_MAKEFILE_TEMPLATE` /
  `RTT_LOGGER_TEMPLATE` + `generate_gdb_script` 的 f-string + `generate_test_bin` 的图案规则。
- 对账基线：`tools/fixtures/gen/mdk-arm/`（Python 工具对真实工程 `CubeMX_Config.uvprojx` 的原始产物）。
- 跑对账：

  ```powershell
  make test-gen            # 等价于 node tools\selftest\gen-parity.mjs
  ```

  它检查：6 个产物逐字节相同（含 CRLF）、LF 模式只差换行、单项覆盖只改那一行、
  "填了默认值 = 没填"、`test_sram.bin` 图案、ZIP 能被自己解回来、`.uvprojx` 解析结果。

- 再跑一遍**真页面**验收（要 `make open` 起的浏览器）：

  ```powershell
  make test-gen-page       # 等价于 node tools\selftest\gen-page.test.mjs
  ```

  41 项：页面接好没、产物字节 vs 基线（在页面里生成、取回来比）、预览内容、
  勾选/换行符/SWD 频率开关、拖入 `.uvprojx` 自动填参、「打包 ZIP」真的下下来、
  「写入文件夹」的写入逻辑（用假目录句柄跑真实的 `saveToFolder()`：同名冲突确认、覆盖开关、每个文件的字节）。

### 故意不同的两处

1. **项目名**：Python 工具固定取 `.uvprojx` 所在**目录名**（脚本在工程目录里跑）；网页拿不到目录名时退回
   `<TargetName>`，再不行用文件名。三者都可以手改。
2. **换行符**：默认 CRLF（= Python 产物）；给 git 用可以切 LF，除此之外内容一致。

---

## 5. 代码结构

```
app/gen/templates.js   模板 + render*(params)（不在本页改动，改模板要同步改 Python 工具那侧）
app/gen/model.js       器件映射表、.uvprojx 正则解析、参数 → 文件内容（buildOutputs）、换行符处理
app/gen/zip.js         零依赖 ZIP（store 模式 + CRC32），时间戳可注入以便复现
app/gen/view.js        页面：绑定/持久化(localStorage)、拖放、预览、写入文件夹 / 打包 / 单文件下载
index.html             #tab-gen 面板（标签按钮 + 侧栏字段 + 预览区）
tools/selftest/gen-parity.mjs   逐字节对账自测
tools/fixtures/gen/             对账基线与 uvprojx 样例
```

## 6. 不在范围内

`CMakeLists.txt` 生成、SEGGER RTT 源码、TRACE_LOG 源码那几组**没做**（那要把整个 uvprojx→CMake 引擎搬过来）。
需要的话另开一单。

## 7. 已知未验证 / 边角

- **真·「写入文件夹」**（真的弹目录选择框、真的落盘）需要真人手势 + 文件系统授权，自动化测不了；
  自动测到的是它**下面那层逻辑**（冲突检测 / 覆盖开关 / 写字节 / 状态行），用假目录句柄驱动真代码路径。
- Firefox / Safari：没有 `showDirectoryPicker`，走 ZIP；这两个浏览器的拖放行为也没测过。
- ZIP 用的是 store 模式（不压缩）：产物本来就小（约 42 KB），而且这样字节可控、便于对账；
  Windows 资源管理器 / 7-Zip / unzip 都能解。
- 大文件不在场景里（产物总共 ~42 KB）。
