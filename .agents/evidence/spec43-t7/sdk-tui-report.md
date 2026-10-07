# T7 scoped pi TUI evidence

## 最终成功

- 最终全busy-hold源码Run：`tui-governance-hold-20261007-094033-66219`
- 先前设计成功Run：`tui-governance-20261007-093655-55422`（保留历史，不作为最新源码hash证明）。
- 真实 Herdr CLI / pi 1.0.4 TUI / checkout `src/index.ts`，deterministic provider只替代模型决策。
- 使用 `verify-pi-herdr` 的 launch / doctor / evidence / cleanup；T7专用 driver `tests/spec43-t7-tui.mjs`。旧 mapped circular exchange与T7 finished hold语义不兼容，未强行修改生产适配旧fixture。
- entry fixture：`tests/fixtures/spec43-t7-tui.ts`，调用完整 production extension、取 `makeDeliverySink(pi)` 已缓存治理sink；命令只注入唯一fixture event。
- `/t7-late` 在finished收到done事件：provider request仍1，正文未入session，durable sidecar保存。
- 真实terminal `t7-natural`：request累计2，finished正文在provider出现一次，TUI最终回答 `T7_TUI_NATURAL_CONSUMED`。
- 真实模型调用 `herdr_wake_subscription` event scope、ttl=60000；含tool response这轮新增2requests。
- `/t7-explicit` scoped事件：新增且仅1request（总5），TUI回答 `T7_TUI_EXPLICIT_CONSUMED`，one-shot subscription耗尽。
- driver exit0、launch READY、doctor HEALTHY、evidence CAPTURED、cleanup CLEANED。
- 最新owned workspace `w8T`、scratch均已删除；`cleanup.json`三项true。没有关闭任何非owned workspace。

## 保存的证据

成功run下：`parent.jsonl`、`provider-contexts.jsonl`/`t7-provider.jsonl`、`terminal.json`、`transport.jsonl`/`tui-actions.jsonl`、`result.json`、`doctor.json`、`evidence.json`、`run.json`、`cleanup.json`。

同目录镜像到 `/tmp/spec43-notes/evidence/spec43-t7/`；`sdk-mirror-receipt.json`记录原路径、镜像路径与逐文件SHA256。原证据保持。

## 保留失败尝试

1. `tui-20261007-093338-43522`：旧message-ack mapped fixture实际完成child question与parent ACK，但child缺durable terminal declaration产生persistence-error；旧driver按已auto-exit child查pane失败，同时完成消息finished hold并非自动wake。捕获与cleanup成功。不标已绿。
2. `tui-governance-20261007-093621-53327`：所有T7行为断言GREEN，但finally capture误把 `pane read --format text` 当JSON解析；driver exit1。捕获与cleanup成功，driver修复后用新run完整重跑绿。不冒称该run exit0。

## 边界

- T7 scene不spawn child；child工具/exchange前一次有现场部分证据，不因此宣称spawn-result map全部覆盖。
- 不证明视觉layout fidelity、真实网络provider、blocked dialog或机器崩溃。
- 核心finished/自然/explicit wake是TUI现场，不再仅SDK模拟入口。
- SDK独立测试按terminal-only订阅补 `kind: done`，且按全busy-hold移除safe断言、加terminate:true：10cases通过；未改生产src。
- Deviation：不再宣称tool turn_end safe seam可证明自然继续；普通工具和terminate工具都hold正文到下一自然用户run，真实SDK分别验证原run2requests/1request且没有通知附加请求。
