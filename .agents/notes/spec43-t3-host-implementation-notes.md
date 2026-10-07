# Spec43 T3 host seam

## Decisions
- 完整读取 `tests/delivery-durable-sdk.mjs`；它已证明真实 SDK void `sendMessage`、等待队列及 SessionManager 先改内存后写盘。
- 独立 SDK 审计派发被 spawn-depth=3 拒绝。当前 agent 继续读取真实 SDK 实现。
- 公共 ExtensionAPI 无精准队列取消、无 dequeue hook；不使用全量 clear。但 `message_end` 同role替换是更高可用公共正文撤销 seam，见下方追加。
- **最终生产 seam：公共 `message_end` 提交前正文重仲裁。** 不需要 AgentSession injection；旧Push变无正文状态receipt，正文在provider采样及持久化前消失。无需物理dequeue或删除message envelope。
- 早期显式 SDK 私有队列适配仅为 research：实例队列 `messages` 精准 splice，包裹同步 `drain`；nextTurn数组iterator。它不是最高可用生产seam，CLI extension拿不到该session。
- 私有 dequeue research 重仲裁必须同步；**公共 `message_end` 仲裁可异步 await**，真实provider闭环已验证。
- durable receipt 只读实际 session JSONL，拒绝 branch-only acknowledgement。SDK 不 fsync；文件可读不是断电安全证明。

## Crash windows
- tool execute 返回及 `tool_result` hook 后、`message_end` append 前，进程崩溃可丢整个 tool result。
- `message_end` 扩展/public listeners 在 append 前；那里写 ledger ack 会先于实际 tool result 文件写。
- SessionManager append 先改 branch 再 appendFileSync；写失败使内存/文件分叉，不允许 branch acknowledgement。
- appendFileSync 无 fsync；成功读回后仍有机器崩溃/掉电丢数据窗口。适配只承诺本地 JSONL 可读，不承诺 fsync durability。
- SDK drain 与 message_end persistence 间崩溃：队列已出、消息未写，必须交给调用方的 durable outbox/ledger 重试；宿主本身不能消除。

## Validation
- `node tests/spec43-t3-host.mjs` 通过：真实 Agent queue/loop、真实 AgentSession.prompt 与 nextTurn array replacement、真实 tool execution/_afterToolCall、真实 SessionManager reopen/EISDIR。
- 精准取消覆盖 steer/followUp/nextTurn；人类输入与其他扩展（包括复用同 token）保留。取消按 token + owned details identity。
- 同步仲裁在 SDK drain / nextTurn iterator 最后边界执行。返回 false 表示撤销该排队项，不是 hold；caller durable outbox 必须接管 fallback/retry。throw 或非boolean 不修改队列。
- Advisor 复核暴露 idle wake 绕过私有queue gate：research适配禁止idle steer/followUp，capability `wakeEnqueue: busy-only`。公共message_end生产gate不受此限制，wake:true AgentSession路径依旧走extension事件；只有context-only append旁路需禁止。
- `createDeliveryHost` 私有research接口若无 session 注入保持 `receipt-only`；**不代表公共生产能力只有receipt**。普通 CLI extension通过 `installQueuedDeliveryArbitration(pi,...)` 可撤销旧Push正文，不需私有session。
- `npm run typecheck`、原有 `node tests/delivery-durable-sdk.mjs`、`git diff --check` 通过。
- 临时目录 finally 删除；没有启动测试 pane。证据保留 `.agents/evidence/spec43-t3/host-sdk.json`。

## Deviations
- 精准 queue seam 不在公共 ExtensionAPI，私有适配只给显式 SDK 宿主用。公共 extension 优先用下方 message_end 正文撤销；这是不同能力，不宣称 dequeue取消。
- 无法在此 seam 消除 SDK drain -> append 或无 fsync 窗口。证据如实列出，不承诺 exactly-once/power-loss-safe。

## Public message_end seam (parent discovery)
- 父 agent 发现 `MessageEndEventResult.message` 同role替换。真实 `_emitExtensionEvent` 调用 Runner.emitMessageEnd 后 `_replaceMessageInPlace`，随后才 append。
- 公共入口 `installQueuedDeliveryArbitration(pi,{arbitrate(message,ctx),onError?})`：arbitrate true保留正文并标commit，false撤销，undefined不改无关push，可Promise。`registerDeliveryMessageGate(pi,{owns,allow,onError?})` 是它的便捷wrapper。allow false 或错误替换为空 content、display=false、details.deliveryHostWithdrawn=true。可异步 await 仲裁。
- Runner 会吞 handler 异常并继续原文。gate 必须在识别 owned 后内部 catch，把仲裁失败变成正文撤销。owns 匹配器必须 total/可靠，不能在未知ownership时误改无关消息。
- 真实 loadExtensionFromFactory + ExtensionRunner + AgentSession._bindExtensionCore + Agent loop 测试通过：队列入队后改变仲裁；同object state/disk被替换；模型request与disk均没有旧正文；外来push保留；allow异常也撤销。
- 非dequeue取消：message_start/UI可能已见正文；后加载的可信 extension handler也可能再覆盖替换。
- 空正文仍持久化 custom_message + 原token。redaction details白名单仅 `{eventId,deliveryToken,deliveryHostWithdrawn:true}`，旧 result/message/error、旧 bodyCommitted 全部剥离；替换整个 custom message，防止未知顶层payload泄漏。
- `inspectDeliveryReceipt` 发现withdrawn返回 `status: absent, withdrawn: true`，可审计entry但永不作为body commit ack。allow获准时加 `deliveryHostBodyCommitted: true`，父ledger还需检查token/claim。
- 最新真实测试覆盖metadata正文剥离与获准commit marker。host测试/typecheck通过；全局diff check被并发result agent whitespace挡住，宿主未碰该文件。
- 证据 `public-message-end-real-extension-runner`；所有现有 host测试/typecheck通过。
- provider证据强化：真实 streamFunction 截获最终request context；message_end arbiter通过手动promise latch挂起，pending期间无后续provider调用或正文append；release后才采样。不是仅观察state/disk。
- 真实 SDK `_appendCustomMessage` context-only路径确实跳过extension gate（测试保留 `UNGUARDED CONTEXT APPEND` 来证明）。新增 `assertDeliveryDispatchOptions`，只允许 nextTurn 或显式 triggerTurn=true steer/followUp；治理push入口必须调用它，不能靠假设wake:true。
