# spec29 投递与消息可靠性 — implementation notes

集成分支 `spec29-delivery`，基线 `16e365ae`（main）。主 checkout 的未提交 notes/prototype/issue-tracker 不纳入本分支提交。

## Decisions

- 编排在主会话；实现在独立 worktree + 独立分支，merger 串行推进 `spec29-delivery`。
- 用户授权 tracker 直接关闭，不开 PR、不合并 main。
- integration 目录同时是 git worktree（分支 `spec29-delivery`）和 jj workspace（`spec29-delivery`，`@` 与主 checkout 的 `konopxsl` 分开）。jj 0.45 `workspace add` 拒绝非空目录，不能直接挂到已有 git worktree；做法是先建空 jj workspace，再把 git worktree 的 `.git` 文件挂进来并改写 gitdir 指针。
- 探索笔记在 `/tmp/pi-herdr-spec29/`，不进仓库。

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
