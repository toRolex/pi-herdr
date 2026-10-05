# spec29 投递与消息可靠性 — implementation notes

集成分支 `spec29-delivery`，基线 `16e365ae`（main）。主 checkout 的未提交 notes/prototype/issue-tracker 不纳入本分支提交。

## Decisions

- 编排在主会话；实现在独立 worktree + 独立分支，merger 串行推进 `spec29-delivery`。
- 用户授权 tracker 直接关闭，不开 PR、不合并 main。
- integration 目录同时是 git worktree（分支 `spec29-delivery`）和 jj workspace（`spec29-delivery`，`@` 与主 checkout 的 `konopxsl` 分开）。jj 0.45 `workspace add` 拒绝非空目录，不能直接挂到已有 git worktree；做法是先建空 jj workspace，再把 git worktree 的 `.git` 文件挂进来并改写 gitdir 指针。
- 探索笔记在 `/tmp/pi-herdr-spec29/`，不进仓库。

## #40 语义（待核实后落笔）

Ticket 正文同时写「隔代显式寻址拒绝」和「显式 pane-id/name 发送不受影响；校验仅作用于保留别名」。Spec 决策写的是「解析出的目标与发送者分属不同代际时拒绝」。以 spec Implementation Decisions 的代际拒绝为产品语义，ticket 验收里「显式地址不受影响」按「未知归属的外部 pane（裸 pane、非 registry）保留 anyone↔anyone」理解，不把已知隔代的显式 handle 放行。若代码无法区分「已知隔代」与「未知归属」，保守拒绝并在错误里说明。

## Deviations

（实现中补）

## #32 wake policy

- 忙闲只在 push 时刻读。`DeliveryDeps.busy` / `WatchdogDeps.busy` 默认不注入，读不到或抛错都当空闲，旧测试仍走 steer。
- 只有会唤醒的 `done` 在忙时改成 `followUp` + `triggerTurn`。pi 的 followUp 排到当前 run 结束，不 abort 正在跑的工具。测试只断言 sendMessage 选项，不真的取消工具。
- `blocked`、`stalled`、`stall-recovered` 固定 `steer`，blocked 仍无视 notifications。`error` / `gone` / `start-error` 不排队：quiet → nextTurn，none → 不推，normal → steer。gone 和 start-error 保持插队，是为了消失和启动失败不被一次长 run 吞掉。
- `SteeredMessage.deliverAs` 可选。没写时 sink 仍按 wake 映射：wake → steer，否则 nextTurn。显式 followUp 时 triggerTurn 为 true。
- ExtensionAPI 没有 `isIdle`。`trackOrchestratorBusy` 用 `agent_start`…`agent_settled` 覆盖整段 run（含工具），用 `session_before_compact` 到 compact 成功或失败覆盖压缩。没有 `on` 的 mock 保持空闲。
- 负载实验（忙碌时工具不被中断）没跑。
