# Spec29 实际入口修复

## Seams（协调者指定）
- receiver registerReceiverInbox → 安装 SDK AgentSession.prompt/_runInputHandlers 与 _bindExtensionCore void binding。
- registerDelivery → session_start → 当前 session disk registry → orphan adoption。
- 两个重叠 deliverOnce 调用 → 实际 owner registry。
- SDK sendCustomMessage 异步失败、quiet enqueue → public getBranch durable entry ack。

## Red → green
- inbox-sdk：旧入口模型验证0次；内部随机一次性水印仅匹配 source extension，恢复原文后验证1次。busy settle 同一路径只排一次。SDK fixture 仅停在模型配置验证，不发网络请求。
- delivery-entry：session_start 旧 registry size0；校验 owner/name/kind 后恢复当前 session；root 恢复后 orphan push1。损坏 registry 抛错，不当空表。
- overlap：同一 owner 并发 pushes2；所有 deliverOnce 进入 awaited serial，后调用重新读 persisted marks，push1/close1。
- delivery-sdk：旧 void sink 被视为成功；真实 SDK async reject 下新 sink 保 pending/pushError，不 mark、不 close。用独立随机 deliveryToken 对 public branch custom_message 逐项确认，不只 await void。
- pending token 去重；busy followUp/quiet nextTurn 未落盘期间保持 pending；30秒未确认只记录 unknown/timeout，保留原token，禁止自动重复enqueue。ack 后复用原 takeover 重新读取保护。

## Evidence
- `/tmp/pi-herdr-spec29/fix-{inbox,restore,overlap,ack}-{red,green}.log`
- `/tmp/pi-herdr-spec29/fix-targeted.log`
- 新测试均纳入 package test。smoke注册拓扑新增 registry restore / durable sink 两个session_start。

## Decisions / limitations
- 不使用 SDK private context 替换 API。public getSessionFile JSONL 是确认源，branch mutation 不证明落盘。
- 无 getBranch 的注入离线 sink 沿旧同步协议；真实 registerDelivery 的 session_start 必定绑定 public context。
- async SDK wrapper 的错误不能通过 await 捕获；持久入口缺失由 pending confirmation/timeout 可见，pane保持。
- 同进程 tick 串行；不声称跨进程互斥。
- own terminal ack 后、close 前持久化delivery；tick完成再次写全部own标志（含submissionnotified）。写失败恢复volatile dedupe并throw/pushError，不当已持久。
- adopted ack后先持久owner delivery+closePending，再close，最后写close outcome；失败抛错可见，不吞。真实registry EISDIR回归close前备份已含done；own sidecar await链消除unhandled rejection。
- sink reload额外按实际JSONL terminal eventId去重，owner标志写失败也不重enqueue已持久正文。
- 证据 `fix-registry-order-{red,green}.log`，测试 `delivery-registry-failure-sdk.mjs`。
- actual SDK session_start reload 回归：diskdelivery done / reload mapdone / queue1；证据 `fix-reload-{red,green}.log`，测试 `delivery-reload-sdk.mjs`。
