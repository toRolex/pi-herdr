# #36/#37 receiver inbox

## Decisions

- 公共验收 seam：createReceiverInbox 的 receive/setBusy/settle 与 deliver/receipt sinks；registerReceiverInbox 负责真实 input/lifecycle。
- limiter 属于接收 session，不属于发送进程。busy 时所有 sender 共享 cap8；settle 自动 drain。
- receipt 独立 `<agent-receipt>` 通道，接收端转 custom 消息、不进入 inbox、不唤醒；立即发往被丢 sender，而非等待下次调用。
- 本任务单块实现，已有并行 t38 集成及审核 agent；不再嵌套派发，避免同文件竞争。
- 发送端旧 limiter/inboxes 移除，export reset/admit seams 保留为无状态兼容函数；pending flag 仅兼容，不再把文本留在错误的 sender process。
- receipt 立即由 receiver 使用 Herdr prompt 发向 sender label（Herdr name/pane id）；无法解析、pane 消失、CLI 失败时 receiver custom + toast 显示失败，不假称 sender 已收到。
- receiver session_start 重置 session 队列和窗口，避免切 session 串扰。

## Validation

- RED：tests/inbox.mjs 首个 tracer 因缺失 src/inbox.ts 失败。
- GREEN：fake clock 测 20/10s、sender 独立预算、共享 cap8、两个实际被丢 sender receipt、自动 settle drain、已交付不变、sink failure retry、raw answer 豁免、receipt no-loop。
- npm test 首次因继承当前 child 的 PI_HERDR_SESSION 等环境污染 substrate fixture 失败；清除继承 child env 后全 suite 通过（/tmp/spec29-inbox-test-clean.log）。
- tsc --noEmit 通过。

## Limits

- receipt 是 out-of-band input，不唤醒；sender transcript 在下一次输入处理时显示。非 pi pane 只显示 receipt envelope，没有 custom 接收转换。
- 已聚合 sender 的后续损失不另发 receipt；count 在 receiver 内聚合，新被丢 sender 收到当时累计值。
- live TUI 接收与真实负载未在本任务跑；t38 负责 index 接线、独立 completion parser/render。
