# DWARF / ELF 解析的对账基线

`tools/selftest/dwarf.test.mjs` 用的**真 ELF 快照**（二进制，见 `.gitattributes` 里的 `binary`）。
为什么要入库：`tools/target-firmware/**/build/` 是构建产物（被 .gitignore 忽略），
在干净克隆里不存在 —— 解析器不能"本机有固件才测得动"。

| 文件 | 来源 | 用来测什么 |
|---|---|---|
| `stm32f103_scope.elf` | `tools/target-firmware/stm32f103_scope/`（`build.ps1` 产物，`-g3 -gdwarf-4`） | **结构体展开**（`g_pack` 24 B → 9 个成员）、类型映射（f32/f64/u16/i16/u8/i8/u32/i32）、数组剔除、8 种标量全覆盖 |
| `stm32f103_rtt_speed.elf` | `tools/target-firmware/stm32f103_rtt_speed/` | **真工程风格**：多 CU、typedef 结构体（`_SEGGER_RTT`）、以及 `DW_AT_specification`（定义 DIE 无名，名字/类型在声明那侧 —— 不追就会把 RTT 控制块整个漏掉） |

两个都是 **DWARF 4**（GCC 10.3 的默认版本；GCC 11+ 默认 DWARF 5，所以那两份 `build.ps1` 里
显式写了 `-gdwarf-4`）。解析器只支持 DWARF 4，遇到 5 会**明确报错**而不是猜。

## 重新生成

```powershell
cd tools\target-firmware\stm32f103_scope;   pwsh -File build.ps1
cd tools\target-firmware\stm32f103_rtt_speed; pwsh -File build.ps1
Copy-Item ..\stm32f103_scope\build\fw.elf        ..\..\fixtures\dwarf\stm32f103_scope.elf -Force
Copy-Item ..\stm32f103_rtt_speed\build\fw.elf   ..\..\fixtures\dwarf\stm32f103_rtt_speed.elf -Force
node tools\selftest\dwarf.test.mjs     # 期望的地址/类型都写在测试里，变了就得同步
```

> 快照里的地址是**链接结果**，改代码/换编译器都会变。测试里那张地址表就是"变量契约"，
> 变更是**有意义的信号**（比如结构体加了字段），别顺手改测试了事。
