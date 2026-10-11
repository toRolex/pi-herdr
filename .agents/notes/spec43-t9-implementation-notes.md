# spec43 T9 (#52) 实现笔记：Direct input 是普通输入，彻底移除 takeover/re-arm

## 基线
- 接手 worktree 内一次未提交的先前尝试（大量删除已就位）。stash → reset 到 origin/spec43-integration (ae4b0d2) → stash pop，冲突 7 文件取 integration tip 版本，随后把先前尝试的 T9 语义（child busy FIFO、无 marker、durable recycle 等）重新施加，提交为 merge commit 4c2fd2e。
- 收尾 merge：协调方确认 f24716d（T4 durable QueueOnly）是规定收尾动作"并入 integration tip"的一部分。在 in-progress merge（MERGE_HEAD=f24716d）上直接解决 7 文件冲突：解法与 spec43-t10 分支 cc73d30 同名冲突解法一致，再叠加 T9 语义覆盖。T4 侧改动（child.ts 的 registerQueueOnlyReceiver 接线、spawn.ts 的 PI_HERDR_PARENT_SESSION stamp、send/queue-only-inbox 全套）完整保留；T9 侧移除（takeover/rearm/steer watermark）完整生效。T10（8a284fc blockedEpisode）不在 f24716d 内，留给后续 merger。
- 教训：先前顾问"T4 不属于 T9"的裁决前提有误——规定收尾步骤"merge integration tip"在执行时 integration tip 即含 T4，属 T9 职责内。

## 实现（在 T2/T5/T7/T11 之上）
- **child.ts**：busy 时 input → `sendUserMessage(deliverAs:"followUp")` 安全排队，不 interrupt；`agent_done` 在 hasPendingMessages 时拒绝；`agent_settled` 在 hasPendingMessages 时保持 run 存活；queued input 触发的新 run 通过 `agent_start` + fresh `completionEventId`（randomUUID）获得新 run 身份，durable 保存后回收（T2 close intent + recycle worker）。extension 回声（source=extension 且在 queuedInputs 中）放行为 continue，避免排队回环。
- **删除**：`markTakeover`/`takenOver`/`takeoverPathFor` 写入、`isHumanInput`、steer watermark 读写（readSteerWatermark/clearSteerWatermark/inputMatchesSteer）、`rearmTimer`/`cancelRearm`/`idleRearmMs`/`ENV_IDLE_REARM_MS`、writeSidecar 的 rearm 参数。
- **sessionfile.ts**：删除 takeover/steer helper 全套；parseExitSidecar 对未知字段（含旧 `rearm`）容忍忽略——旧 marker 文件、旧 rearm 配置存在时读取不报错、不生效（AC7）。clearSidecars 仍会顺手清理 `.takeover`/`.steer` 残留文件。
- **settings.ts**：`idle_rearm_minutes` 保留定义但 description 标注 legacy ignored；loadSettings 强制 source=default，用户配置静默忽略。
- **delivery.ts**：删除 takeover marker 读取、"user took over" note、`takenOver`/`tookNotified`/`readTakeover` 分支；ownsPane 不再排除 takenOver；closeDeliveredPane/closeRecordPane 移除 rearm 参数与 takenOver 守卫；deliberately 保留 spawn.ts 上 inert 的 `takenOver?` 字段（旧 registry JSON 反序列化兼容）。保持 T3 storePullOnly、T7 parent gate 已移除（parent-delivery 不在 origin tip）。
- **inputwake.ts**：移除 `pi.on("input", advance)` —— 普通 input 不再打断 legacy wait；仅 host lifecycle（session_start/shutdown）释放。
- **spawn.ts / lifecycle.ts**：删除 writeSteerWatermark 调用与 import；paneCloseAuthorization 去掉 rearm 字段。
- **保护语义**：草稿/打字/焦点不再保护 autonomous pane（input handler 不再有 takeover 效果，settle 即回收）；已提交且实际开始的新 run（agent_start 后的新 completionEventId）保护 pane 不受旧完成关闭动作影响（T2 close authorization 按 agentId/runId/paneId 校验归属）。

## 验证
- `npx tsc --noEmit`：0 错误。
- `npm test` 全套：全绿（含 spec43-t9.mjs 单元测试 5 项断言、delivery 119、lifecycle 71、settings 123、input-wake、T2/T5/T6/T7/T11 回归）。
- 真实 CLI / child pi TUI：`node .pi/skills/verify-pi-herdr/scripts/verify.mjs launch|doctor → node tests/spec43-t9-live.mjs <artifacts>`，末行 `GREEN direct FIFO / parent inert / draft-focus recycled / explicit interrupt`。evidence：`.agents/evidence/spec43-t9/live-rerun/`（result.json 全 true；direct.jsonl 显示 BUSY_TOOL_FINISHED 先于 T5_FINAL DIRECT INPUT 即排队语义）。cleanup workspaceGone=true。

## 测试适配
- tests/delivery.mjs：删除 [1]/[2]（rearm typing、takeover marker、steer watermark、child takeover/re-arm 行为）两节；保留 [3] delivery loop。
- tests/lifecycle.mjs：seed 与 transient reset 断言移除 takenOver/tookNotified。
- tests/smoke.mjs：hook 计数按移除 parent-delivery 后的真实面（agent_start 3/2、turn_end 1、session_start 9/8）。

## 遗留风险
- T10（blockedEpisode / blocked-recovered / blocked 尊重 notifications 矩阵）未在本分支，tests/delivery.mjs 中 blocked 断言仍是 f24716d 时代的 "always wakes" 版本，与 T4 合并后的 src 一致；后续 merger 合入 T10 时需同步替换这些断言（参考 8a284fc 对 tests/delivery.mjs 的 17 处替换）。
- `idle_rearm_minutes` 设置项仍出现在 settings 表（仅标注 legacy），settings UI 会展示但值无效；后续可考虑从 SETTING_KEYS 完全移除（会改 schema 兼容面，未做）。
- pi `<session>.steer` 水印机制随 takeover 一并删除；parent 驱动 pane 输入现在与人工输入不可区分——这是 spec 期望（普通输入一律普通处理），但意味着父通过 pane send-keys 的驱动也会走 followUp 排队（真实 demo 已验证此路径）。
