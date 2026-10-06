# #30/#38 reload lifecycle

基线 712692a；仅当前 worktree。Seam 按任务授权：真实 SDK loadExtensions + ExtensionRunner，InteractiveMode reload 的 beforeSessionStart/history component 重构顺序，真实 AgentSession input path。

## 诊断

- SDK InteractiveMode.handleReloadCommand 在 AgentSession.reload 的 beforeSessionStart 回调中 rebuildChatFromMessages，之后才 emit session_start。
- CustomMessageComponent 构造时捕获 renderer，不会因后续 registerMessageRenderer 自动切换。
- 所以 session_start 内注册会让 reload 重构历史永久 generic；不应改 presentNotices。
- 排序假设：①注册晚于重构（已由 SDK 源码确定）；②官方 wrapper 未在 reload 重新加载 src；③模块 timer guard 阻止新 runtime 注册。
- loader 使用 moduleCache:false，factory 每轮执行；explicit -e 路径由 resource loader 保留。需要直接路径测试区分产品与 fixture。
- 子代理审查尝试被 spawn depth 3 上限拒绝，自己执行。

## 实现与验证

- `node tests/render-reload-sdk.mjs` 先红：reload历史 `[herdr-agent-message]` generic。factory阶段注册、session_start仅更新当前context后绿；未改pure presentNotices、inbox或delivery算法。
- 真实SDK loadExtensions直接加载当前checkout绝对src/index.ts，新runner重新注册input；两种同ID到达顺序、历史重构及新增custom component、ctrl+o、typed event一次custom、无ID progress只触发一次真实AgentSession model validation都通过。
- 默认package-lock SDK 1.0.2与当前真实pi host SDK 1.0.4均通过。通过`PI_HERDR_TEST_SDK_ROOT`可重跑host版本。
- session_shutdown清掉旧module timer，loader factory重复执行后建立新runtime；该真实链条通过，不因fixture wrapper症状额外修改产品input/timer。
- 定向channel/inbox-sdk/inbox/delivery-reload-sdk/delivery-render/smoke（181）及tsc通过，<=180秒。日志`/tmp/s29-render-{red,green,targeted,host-sdk}.log`。
- 额外全套npm test在既有tests/substrate.mjs:426因缺s.jsonl.exit失败；render测试尚未运行到。日志`/tmp/s29-render-full.log`。

## Deviations / 限制

- 不在此worker操作真实Herdr pane；已给coordinator复测pointer为本wt/src/index.ts，要求官方driver正确加载checkout。
- 真实SDK证明direct-path input未丢，故不针对未证实产品故障改inbox，也不patchwrapper module缓存。
