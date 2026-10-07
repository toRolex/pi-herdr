# spec43 T10 (#53)

## 计划与边界
- 用户明确要求原生 git、自行实现，不派子代理。
- 基线已是整合 c44d7b7。测试 seam：生产 deliverOnce、registerParentDelivery、waitForAgentEvent、注册 result 工具及 child hooks；真实 SDK/TUI 使用生产扩展，deterministic provider 仅替代模型输出。
- blocked 是可等待的状态通知，不是 durable completion；明确回答仍用 message_agent/send_keys，send 不变。
- 先补 blocked wait 红测，再实现；通知统一接收 T7 策略，episode identity 跨 reload 保留，失败复用 T3 账本。

## 实现与验证
- 红测：安装缺失依赖后，blocked wait 返回 timeout；实现生产 wait 的 live blocked discovery，返回 kind=blocked、身份，不给 completion eventId。blocked ACK 沿 T11 拒绝路径；恢复后显式 wait 继续等待 durable completion。current-run wait 增加 agent/run/sequence stale guard。
- blocked episode 计数随 registry 持久化；通知有独立 noticeId，parent store 按其去重，不将 blocked 冒充 child completion。push 成功才标记 episode；registry 写失败回滚 episode。新增 blocked-recovered；watchdog stalled/recovered 同样补身份、遵守 normal/quiet/none。
- terminalWake 仅 normal 为 true。生产 T7 admission 仍持久保存全部通知、busy/finished 不 dispatch，自然下一 run 才消费；显式 wait 不需要 steer 即返回事件。legacy done+busy adapter 保留 followUp：改掉会破坏 delivery-lineage SDK 兼容路径；生产 parent admission 不提前排此队列。
- retry grace 原实现已满足：真实 TUI retry 第一次 overloaded→SDK 自动重试→done；两次 provider 请求均无 terminal sidecar。不可恢复 failure 无 final 时保留明确 error text，不伪造成功正文。失败 Pull 同 T3 ledger，第二次无正文。
- 全 suite 更新旧 always-wakes 断言；最终用户精确 env npm test exit0，末行 `99 passed, 0 failed`。npm run typecheck exit0；git diff --check exit0。
- 真实 SDK（完整 AgentSession/ExtensionAPI/生产 parent+sink）normal/quiet/none：finished 后4类通知零新增请求；下一自然 run normal/quiet 各一次，none 不投递。证据 parent-sdk-summary.json + 各 parent JSONL/provider context。
- 真实 Herdr CLI/pi TUI host1.0.4：18ca8244-bb2d-48bb-a73d-d7a39b5f320a，blocked 权限选择 overlay→pane send-keys Enter 明确 Allow→恢复 done；retry overloaded→2次请求→done；unrecoverable→稳定 error。wait.json 证明真实 blocked wait，blocked-terminal.json 保存真实 overlay，child JSONL/trace/result/ledger 保存结果。
- live harness 初次遇 name>32、read 输出不是 JSON、send-keys 空 stdout，逐项修正并重跑成功。失败尝试 evidence/cleanup 保留；只关闭该次新建 workspace。证据镜像 /tmp/spec43-notes/evidence/spec43-t10/。
- merge spec43-integration 两次均 already up to date，基线 c44d7b7。suite 改写其他票据证据后 git restore，仅交本票。

## 限制与风险
- deterministic provider 仅替代模型输出；无真实远程认证或自然语言判断质量承诺。TUI live 证明 child 生命周期、明确权限选择和 SDK retry；parent finished/busy 的接收证明使用真实 SDK fixture，不称 full parent-child live 编排。
- 无 final 的 done 仍 fail closed，缺 durable declaration 不伪造成功。错误正文是明确 failure declaration，不是虚构 assistant final。
- 沿用 T3 的 claim→append unknown failclosed、单宿主写者与 SDK JSONL 非fsync边界；不宣称断电/跨进程 exactly-once。
- blocked 是当前 live 状态，不是历史可消费 terminal；离线/reload 依靠 fleet 状态和 registry episode；未观察到的两个 polling tick 之间瞬时 episode 不承诺完整历史。
- T7 的 scoped wake 仍只匹配 terminal kinds；等待 blocked 用显式 wait，不能用普通 send 隐式响应/执行。quiet/none 均不提升授权。

## Deviations
- 遵从用户不派子代理，人工自审 + 真实 SDK/TUI + 全suite验收。未修改 T12 的全局术语迁移文件。
