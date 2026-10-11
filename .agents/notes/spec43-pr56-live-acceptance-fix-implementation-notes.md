# spec43 / PR56 真实验收新增缺陷修复

## 起点与保护

- 从冻结 `a6dc7fc60ea7366a2a1be6a3858ee668f1009b69` 新建独立 jj workspace `spec43-pr56-live-fix`，不改旧 SHA/证据或原脏现场。
- 新工作副本初始 change `vqkywntr`，初始 commit `234aa7049c60b06ff5c783d627b3373a1a795044`。作者与原 Git/jj 配置一致。
- workspace add 首次使用 `--ignore-working-copy` 返回需更新工作副本错误，已创建空 workspace/root child；未删除或重试覆盖。仅在新 workspace 使用 `jj new a6dc...` 建立正确父节点并填入1188文件。多余空root child保留，未abandon。
- 原MAIN/OLD_DIRTY status/diff及stash身份顺序复核UNCHANGED。

## 新发现（尚待紧反馈与根因核定）

1. T1 普通 queued 任务无 pendingFollowups，parent真实重启并恢复后，holder已durable关闭、容量空闲，任务仍queued且无pane。独立原件 `.../opus-governance/`，最终紧因果报告待补。
2. T6 真实注册spawn被接受后仍startup，parent注册wait期间按Esc取消，child启动继承父turn signal而被中止，startOutcomeUnknown含aborted，child未prompt/终态。通信原件 `.../communication/`，需排除fixture启动/取消时序。

## 决策

- 单一Fable实现者修复两项，Opus只读根因/原件及治理验收供证。
- 必须先正确seam红测、最小化、单变量排除、TDD，再新源码真实场景证明。
- a6dc已有离线/真实结果保持原SHA，不自动改标为新修复SHA；只做受影响新增验证与输入差异审查，完整门禁后才更新PR。
- 验收fixture问题与生产缺陷分开，不通过放松断言掩盖。

## 紧反馈与单变量验证

- 实际入口原红（a6dc）：真实生产注册 `spawn → wait → Esc` 令已接受但仍 startup 的 child 出现 `agent start aborted`，不是取消 child 的显式操作。另一个真实重启场景留下普通 queued、无 pendingFollowups，容量释放后没有调度。
- 取消最小测试复用 `tests/spec43-pr56-lifecycle.mjs` 的公共注册工具 seam，只有 Herdr 外部 transport 用临时可暂停CLI适配器；两次 red 均精确失败于“取消等待不得取消已接受child启动”。不是只断言父signal指针。只为 detached 启动复制 deps 并移除调用turn signal 后 green；foreground启动依然传原signal。
- 接受前已取消负例先 red，再在最后异步验证之后、任何接受副作用之前拒绝；未取消对照也实际启动并提交。对照初版复用了适配器 working 标记，导致 boot 等idle超时；只重置临时适配器的新executor初态，原失败日志保留。
- 恢复最小测试由正常 spawn 产生真实持久 queued record，再新建独立 Node 进程调用 `restoreSpawnRegistry`。不手调 drain/ensureDrainLoop；系统时钟边界把3000ms调度间隔映射25ms。先观察容量仍满，再释放容量，要求原 agent/run/sequence 自动启动。
- 普通 queued 恢复先 red，增加 eligible queue 重臂后 green。混入 unknown、creating、terminal、缺身份记录的负例又揭示 identity-review 被排进启动；显式排除待核对身份、未知结果和无后续任务的终态，负例 green。没有通过补新身份或解锁unknown来修测试。
- 再注入已取消的旧父turn signal，恢复timer负例 red；timer只捕获独立浅拷贝 deps 并去除turn signal后 green，接受记录/实际启动/失败治理仍走同一生产路径。
- 先展示过四假设，再单变量验证：共享signal泄漏；wait主动interrupt（transport无此命令，排除）；启动适配器/registry本身坏（未取消对照正常）；timer复用expired deps（独立负例证实）。恢复侧排除身份过滤/容量占用/旧进程timer残留，确认普通queued未重臂。
- 原件均在 `/tmp/pi-herdr-pr56-live-fix-20261009/`，逐red/green使用不同日志，未覆盖a6dc source、snapshot或live原件。该测试证明生产注册/持久恢复控制流；不把外部CLI适配器宣称真实pi TUI结果提交，真实新SHA回归另跑。

## 验证与冻结策略

- 新增两回归放在既有 npm test 链内的生命周期文件，支持 `LIVE-CANCEL` / `LIVE-RESTORE` 前缀秒级执行；不另建一套退出码伪绿的验证入口。
- 新workspace只读链接既有node_modules，不改依赖；定向检查使用外部HOME、`PI_OFFLINE=1`、PATH拒绝真实Herdr的适配器，避免碰原验收pane。
- 冻结前已实际通过：两新增回归、全 `spec43-pr56-lifecycle.mjs`（12个场景）、typecheck、`spec43-t5.mjs`、`spec43-t6.mjs`、`lifecycle.mjs`、`spawn.mjs`。出口/完整日志见外部 `targeted-result.json` 及 `lifecycle-full.*`；未重跑a6dc全量四片，不宣称新SHA全量green。
- 固定新tip后停止本change源码/notes写；完整tracked输入副本与版本绑定交主线程，原a6dc失败仍原SHA。后续审查新增head需另绑定，不改标已跑证据。

## Deviations

真实验收新增候选生产缺陷，原“仅补验收与PR”需要扩展为独立增量修复；用户要求完成所有剩余工作，因此继续修复，但不重做此前已完成的修复/原件。
