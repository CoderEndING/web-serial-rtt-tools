# 自测入口顺序

自测分成离线、页面和真机三层。编号表示推荐顺序，日期记录放在
[`docs/validation/README.md`](../../docs/validation/README.md)。真机步骤会占用探针，
同一时间只运行一个页面/脚本。

## 00. 静态体检

```powershell
make check
make test-board-matrix
```

第一条检查 Node 模块和页面模板；第二条检查四块活动板卡的例程、构建脚本和产物路径，
避免容量档或旧目录混用。

## 10. 离线逻辑回归

```powershell
make test-offline
```

覆盖协议、ELF/DWARF、SPI/I2C、桥、调试器、J-Scope、生命周期和 SVD 等纯逻辑测试。
这一步不需要浏览器、探针或目标板。需要定位问题时再使用同组的细分目标：
`make test-dbg`、`make test-scope`、`make test-hid`、`make test-gen`、`make test-i2c-dsl`。

## 20. 页面回归

```powershell
make open
make test-ui
make test-dbg-page
make test-scope-page
make test-gen-page
```

页面测试使用假探针和 CDP 浏览器，不烧录目标板。`make open` 已经启动本地静态服务和
自动化浏览器；页面端口被占用时先用 `make serve-stop`。

## 30. 换板确认

```powershell
make board-check-f103cb
make board-check-f103ze
make board-check-h743
make board-check-6800evk
```

只选择当前连接的那一条。流程会读取 IDCODE/DEV_ID/TAP IDCODE，型号不匹配就停止，避免
把错误容量的固件烧到板上。

## 40. 构建与真机基准

```powershell
make rebuild-all-examples
make hw-campaign-f103cb ARGS="--cycles=1 --alt=1"
make hw-campaign-f103ze ARGS="--cycles=1 --alt=1"
make hw-campaign-h743 ARGS="--cycles=1 --alt=1"
make hw-campaign-hpm ARGS="--cycles=1 --alt=1"
```

完整基准包括烧录、RTT Viewer、RTT 转发、10 秒落盘和 J-Scope；`--cycles=1 --alt=1` 是
快速冒烟，正式验收省略参数。HPM 第一次可加 `--record` 重新生成自己的速度线。

## 50. 一条命令全流程

```powershell
make full_flow_f103cb
make full_flow_f103ze
make full_flow_h743
make full_flow_6800evk
```

每条流程都按“认板 → 构建 → 场景基准 → 烧调试靶子 → 调试器压力”执行，并固定使用本地
页面。完整流程会覆盖 RTT 转发、RTT Viewer、J-Scope、烧录、断点、单步、复位和新加入的
BT/DWT Watch 压力项。

## 90. 诊断与历史脚本

`rtt-speed*.mjs`、`flash-timing.mjs`、`dbg-step-hw.mjs`、`hw-random-flow.mjs`、
`probe-hid-diag.py` 等是针对单一问题的诊断工具，不作为默认回归入口。它们仍保留，
但默认固件路径已经指向板卡清单；需要跑时先看脚本头注释和对应历史记录。
