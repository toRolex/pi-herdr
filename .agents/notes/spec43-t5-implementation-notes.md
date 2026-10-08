# spec43 T5 (#48) 实现笔记

## 基线与交付
- 接手未提交 WIP；stash 保存后 `git merge spec43-integration` fast-forward 到 `4b0a2fc`，恢复 WIP。package/smoke 冲突保留 T3/T6/T7/T11 注册和测试，再加入 T5。
- `herdr_trigger_turn` 接受时分配 UUID；busy FIFO 持久化在 owner registry，活动 run 与 completion-event 不变。执行才提升 pendingRunId。
- idle 同 pane 输入 `<herdr-followup runId>`；child 更新 completion 身份，不当作人工 takeover。gone/drain 通过原 session 恢复，agentId/lineage 不变。
- 队列只在旧 pane 退场后启动，先使用原 deliverSidecar 交付旧事件，继续走 T3 durable sink 与 T7 parent gate。不绕过结果仲裁。
- 新 run 清理当前 sidecar，保留 `.completion-<eventId>.json` 事件归档。清除旧 close authorization；T2 fresh owner/run/pane 核验继续生效。
- trigger/resume/drain 共用 agent execution transition lock，拒绝同进程并发恢复。启动中的初次 spawn 不由 drain 重复创建。
- 回执 queued/starting 区分；started=false 是保守承诺，starting 只是已请求启动。启动失败 details 包含 accepted runId/status=start-error。
- busy pane 被回收且缺旧 sidecar：报治理错误，再恢复已接受队列；不伪造旧完成正文。

## 验证
- 全量 npm test：指定 HERDR_* 清理基础上，再逐项移除继承的 PI_HERDR_*（原命令 substrate 85/91 为注入污染）。最终末行 `99 passed, 0 failed`。
- T5 seam：`27 passed, 0 failed`。包含 idle、busy 双请求、run 保留、旧交付先行、gone、resume/trigger 单飞、启动失败 run 回执、pane 回收恢复。
- npm run typecheck：通过。
- 真实 CLI / child pi TUI：`.agents/evidence/spec43-t5/tui-110648/`。末行 `GREEN idle / busy FIFO / gone same session / old event addressable`。doctor HEALTHY；cleanup workspaceGone/scratchGone/evidenceRetained=true。
- fixture 替换模型决策，Herdr server、CLI、child TUI、session、生产 spawn/lifecycle/delivery/result 真运行。父编排由 Node 驱动，不宣称父模型自主调用质量。
- 证据复制至 `/tmp/spec43-notes/evidence/spec43-t5/`。

## Deviations / 风险
- 未复用有中断流程的 lifecycle-live WIP；使用专门隔离 workspace 的 T5 deterministic demo，避免测试 busy 用人工 interrupt 假装安全排队。
- 历史失败 demo 保留 commands/doctor/cleanup 证据；成功以 tui-110648 为准。
- 当前单飞锁范围是 owner pi 进程；跨两个进程同时操作同 owner session 不在支持模型。启动中进程硬崩溃的外部执行者租约回收仍属于治理层，不承诺 exactly-once substrate。
- 接手期间发现前棒 pane 仍活动并有并发编辑，已通知其停写及父 agent；最终版本重跑全测和真实 demo。
