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

## #30 renderer

核实符号（pi-coding-agent 1.0.3，`dist/core/extensions/types.d.ts`）：

- `ExtensionAPI.registerMessageRenderer(customType, renderer: MessageRenderer)`
- `MessageRenderer` = `(message: CustomMessage, options: MessageRenderOptions, theme: Theme) => Component | undefined`
- `MessageRenderOptions` = `{ expanded: boolean; outputPad: number }`
- 挂载点：`src/index.ts` 调用 `registerDeliveryRenderer`，customType `herdr-delivery`

折叠状态不是 renderer 自己订阅键盘。`interactive-mode.js` 的 `toggleToolOutputExpansion` → `setToolsExpanded` 遍历 chat 子组件，`isExpandable` 要求 `setExpanded`。`CustomMessageComponent.setExpanded` 会带着 `{expanded}` 重调 renderer。因此 ctrl+o 会展开本条消息，不另做一套 UI。

模型侧读 `CustomMessage.content`（`sendMessage` 原文）。renderer 只替换 TUI 组件，不改 content。

旧格式空结果：没有 `content` 字段时正文按空串处理，折叠仍是一行 `empty result`。

live（真实 ctrl+o）本票未跑。

`registerDeliveryRenderer` 在 `registerMessageRenderer` 不是函数时直接返回。离线 smoke 的 mock pi 没有这个方法；缺 API 时退回 pi 默认 custom message 全文，不另做 UI。

## Deviations

（实现中补）

## #32 wake policy

- 忙闲只在 push 时刻读。`DeliveryDeps.busy` / `WatchdogDeps.busy` 默认不注入，读不到或抛错都当空闲，旧测试仍走 steer。
- 只有会唤醒的 `done` 在忙时改成 `followUp` + `triggerTurn`。pi 的 followUp 排到当前 run 结束，不 abort 正在跑的工具。测试只断言 sendMessage 选项，不真的取消工具。
- `blocked`、`stalled`、`stall-recovered` 固定 `steer`，blocked 仍无视 notifications。`error` / `gone` / `start-error` 不排队：quiet → nextTurn，none → 不推，normal → steer。gone 和 start-error 保持插队，是为了消失和启动失败不被一次长 run 吞掉。
- `SteeredMessage.deliverAs` 可选。没写时 sink 仍按 wake 映射：wake → steer，否则 nextTurn。显式 followUp 时 triggerTurn 为 true。
- ExtensionAPI 没有 `isIdle`。`trackOrchestratorBusy` 用 `agent_start`…`agent_settled` 覆盖整段 run（含工具），用 `session_before_compact` 到 compact 成功或失败覆盖压缩。没有 `on` 的 mock 保持空闲。
- 负载实验（忙碌时工具不被中断）没跑。

## #31 exit sidecar watcher

- 缝是 `DeliveryDeps.watchSidecar` / `sidecarWrittenAt` / `debug`，加上公开的 `observeExitSidecars(deps, tick)`。测试注入这三者，不碰真实 `fs.watch`。
- 一次写入只 `wake` 一次 tick；同一事件不重复靠现有 `record.delivery` 标记，轮询路径不另做去重。
- watcher 抛错按 record 吞掉。2.5s `setInterval` 仍跑 `deliverOnce`，降级路径就是这条。
- 检测延迟只打 `done`/`error` 且带 `sessionPath` 的终端 push：`sidecar mtime → push 调用前`。日志行 `segment=sidecar→push`。`notifications: none` 不 push，也不记这条延迟。busy 排队延迟不进这个数（#32）。
- 默认 watcher 盯 session 目录（sidecar 往往还不存在），只对 `<session>.exit` 的文件名回调。`fs.watch` 的 `filename === null` 仍触发，避免漏报。
- `registerDelivery` 启动时 arm，每个 poll tick `sync()`：新 pi 记录补 watcher，已投递或离队的关掉。`stopDeliveryLoop` 一并 close。
- wake 策略、sidecar 正文字段未改。
