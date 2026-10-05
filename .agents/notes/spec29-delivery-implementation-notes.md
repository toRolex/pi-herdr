# spec29 投递与消息可靠性 — implementation notes

集成分支 `spec29-delivery`，基线 `16e365ae`（main）。主 checkout 的未提交 notes/prototype/issue-tracker 不纳入本分支提交。

## Decisions

- 编排在主会话；实现在独立 worktree + 独立分支，merger 串行推进 `spec29-delivery`。
- 用户授权 tracker 直接关闭，不开 PR、不合并 main。
- integration 目录同时是 git worktree（分支 `spec29-delivery`）和 jj workspace（`spec29-delivery`，`@` 与主 checkout 的 `konopxsl` 分开）。jj 0.45 `workspace add` 拒绝非空目录，不能直接挂到已有 git worktree；做法是先建空 jj workspace，再把 git worktree 的 `.git` 文件挂进来并改写 gitdir 指针。
- 探索笔记在 `/tmp/pi-herdr-spec29/`，不进仓库。
- #35 Enter 漏发根因：不能确定是 Enter 丢失、TUI 未就绪，还是 submit 分支没走到。代码能确定的只有这些：正常 spawn 会走到 `submitAndWait`，也就是 `herdr agent prompt --wait`，贴文本和提交是同一次调用，没有单独的 Enter；herdr 在非 working 起手、5 秒内看不到 working/blocked 时返回 `agent_prompt_stalled`，旧代码把它当成可能丢失并回 `NOT_STARTED`，然后把整段任务再贴一次，不是补一次 Enter。`agent get`（herdr 0.9.3 的 AgentInfo）没有编辑器字段，默认读回只能看到 status。`resumeSilent` 会故意跳过提交，不是这次漏发。

## #40 语义（待核实后落笔）

Ticket 正文同时写「隔代显式寻址拒绝」和「显式 pane-id/name 发送不受影响；校验仅作用于保留别名」。Spec 决策写的是「解析出的目标与发送者分属不同代际时拒绝」。以 spec Implementation Decisions 的代际拒绝为产品语义，ticket 验收里「显式地址不受影响」按「未知归属的外部 pane（裸 pane、非 registry）保留 anyone↔anyone」理解，不把已知隔代的显式 handle 放行。若代码无法区分「已知隔代」与「未知归属」，保守拒绝并在错误里说明。

## Deviations

（实现中补）
