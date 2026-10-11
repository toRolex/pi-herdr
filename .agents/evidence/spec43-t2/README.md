# Spec43 T2：真实 Herdr/pi autonomous recycle

通过运行：`44e25e11-4291-4e49-8a6e-93704c626e26/`。
ownerSession/worker 守卫更新后重跑：`1c067720-eff8-4f64-bc55-1cf2fc47cd72/`，退出码 0。对应源码 SHA256 见该目录 `summary.json`。
最新 durable fsync 版本重跑：`4a7dfe54-8dbe-4f10-990a-3715b7ba7604/`，退出码 0；源码 SHA256 见该目录 `summary.json`。
生成 fixture 加 `@ts-nocheck`，避免证据目录触发生产 TypeScript 隐式 any 误警；历史 fixture 补相同注释（不改 transcript/event/transport）。
最新 wx immutable-event 版本：`b77703bb-38a4-427a-882a-dd38cc91fa38/`（普通自主退出），退出码 0。
worker restart proof：`00c88fbb-da27-4907-96f2-63aaf0ca45ad/`，命令 `T2_RESTART_WORKER=1 node tests/spec43-t2-live.mjs`，退出码 0。
该模式只把 child 的 HERDR_BIN_PATH 替换为记录 worker PID 并退出 1 的本地 fixture。确认 child 已退出、intent pending=true、真实 shell pane 仍存在后终止失败 worker；使用真实 Herdr 执行当前 `node src/recycle-worker.mjs <intent> herdr`。确认 intent pending=false、pane 消失、完整结果仍可恢复。历史 error 字段可能保留，pending=false 是完成状态。没有父 delivery/ACK。
restart 模式诊断失败：`083c1ba9-*`（shell integration 覆盖 HERDR_BIN_PATH；修为 fixture 内设置）、`1b417628-*`（新 shell 尚未 ready；启动前加等待）。均 scoped cleanup；保留证据。
命令：`node tests/spec43-t2-live.mjs`，退出码 0。

## 边界

真实 Herdr CLI/server、真实 pi TUI/process、当前 checkout `src/child.ts` 和 detached `src/recycle-worker.mjs`。
仅模型替换为 deterministic provider。父为 inert Node tracer；不 import delivery，不调用 deliverOnce，不写 ACK。初始化 `.steer` 为 spawn 首次 prompt 水印，不是 ACK。
不调用 agent_done；自动通过 agent_settled 保存并退出。测试侧 cleanup 仅在 process exit 和 pane disappearance 断言后进行。
该测试验证 child/runtime seam，不验证 spawnAgent 注册表路径、真实模型、父重启后的 delivery 恢复。

## 通过断言

- boot trace：PI_HERDR_AGENT_ID/RUN_ID/SEQUENCE、HERDR_PANE_ID、AUTO_EXIT 均正确。
- immutable completion event：type=done；agentId/runId/eventId/sequence 完整。
- 完整 final 10,171 bytes：事件、session、fresh Node 恢复输出均严格相等。
- child PID 85231 自行退出；pane w8E:p1 随后消失。
- recycle intent pending=false，无 error；测试未提前 close pane。
- 事件字节退出前后不变；session 和恢复结果保留。
- deliveryPasses=0、ackWrites=0；无 ACK artifact。

关键文件：`summary.json`（源码和数据 SHA256、观测时间）、`transport.jsonl`（真实 CLI 返回）、`child-trace.jsonl`（boot/settled/shutdown）、`child.jsonl.completion-*.json`、`child.jsonl.recycle.json`、`recovered-result.txt`。

## 保留的诊断尝试

- `f5f99df6-2114-4874-9da0-7162eff598a2`：漏初始 steer 水印，被真实 child 判断为 takeover。修复 fixture；非 src 漏洞。
- `0fa01d47-c7b7-4830-b4df-36bfe2f040de`：带初始 CLI prompt 的 child 在 agent start readiness 返回前已退出，CLI timeout。改为先启动到 ready，再真实 agent prompt。
- `e46f50ed-c245-4989-aaf3-665ba536fefe`：所有行为断言通过，但 Herdr 最后 pane 消失后已自动删 workspace，冗余 cleanup 返回 not-found。修复 scoped cleanup 后重新跑绿。

所有尝试均关闭自己创建的 workspace；未操作其它 pane；未改变全局配置。
镜像：`/tmp/spec43-notes/evidence/spec43-t2/`。
