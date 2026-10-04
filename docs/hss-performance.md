# HSS 性能改动与上板验收

本次改动尚未上板测速，速率目标不是实测结果。

## 小数周期

周期支持 2.25 / 2.5 / 2.75 µs，按 24 MHz timer tick 量化；下限仍是 2 µs。
整数周期继续使用旧 action 7 / v1 包。小数周期发送 action 10 / v2 包，网页在配置前检查
STATUS w0 bit2 支持位；旧固件会要求升级，不会把未知命令当成成功配置。
v2 包头时间戳和 DEF/STAT 周期均为 tick；页面先去 u32 回绕再换算到 µs。
原始包回放同时支持 v1/v2。完整协议见探针仓库 docs/hss-tick-protocol.md。

推荐周期按钮保留原来的保守规则；先手动测试小数周期，根据丢拍和抖动选择稳定档位。

离线：`node tools/selftest/scope-proto.test.mjs`。
