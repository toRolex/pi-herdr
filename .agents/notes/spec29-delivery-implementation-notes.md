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

## #31 exit sidecar watcher

- 缝是 `DeliveryDeps.watchSidecar` / `sidecarWrittenAt` / `debug`，加上公开的 `observeExitSidecars(deps, tick)`。测试注入这三者，不碰真实 `fs.watch`。
- 一次写入只 `wake` 一次 tick；同一事件不重复靠现有 `record.delivery` 标记，轮询路径不另做去重。
- watcher 抛错按 record 吞掉。2.5s `setInterval` 仍跑 `deliverOnce`，降级路径就是这条。
- 检测延迟只打 `done`/`error` 且带 `sessionPath` 的终端 push：`sidecar mtime → push 调用前`。日志行 `segment=sidecar→push`。`notifications: none` 不 push，也不记这条延迟。busy 排队延迟不进这个数（#32）。
- 默认 watcher 盯 session 目录（sidecar 往往还不存在），只对 `<session>.exit` 的文件名回调。`fs.watch` 的 `filename === null` 仍触发，避免漏报。
- `registerDelivery` 启动时 arm，每个 poll tick `sync()`：新 pi 记录补 watcher，已投递或离队的关掉。`stopDeliveryLoop` 一并 close。
- wake 策略、sidecar 正文字段未改。
