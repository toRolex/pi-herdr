# PR56 review fix r2

## 范围与安全门
- 唯一生产写入 workspace：现有 r2；基线 integration 5563d43d；不重做 T1–T12。
- jj skill/workflow、tdd、pre-implement 已加载。首次 snapshot 前扫描无 .env/key/pem/credentials 文件；git check-ignore 确认 .env、.env.local、node_modules；Git/jj 姓名邮箱一致，空 @ change 沿用。
- 沿 handoff 已批准 seams：triggerTurn / drainQueueOnce / getAgentResult；复现未知驻留提交、retained archive 身份、未发布 current failure eventId。
- 独立复制 host，SDK/core/AI overlay 匹配；使用 handoff sandbox 和 ENOENT stub，禁止网络、真实 Herdr、共享依赖及旧现场写入。

## 实现决策
- UNKNOWN-RETRY：提交前严格持久化 uncertain 与 accepted identity，持久化失败不联系 executor；TIMEOUT、throw、进程退出/无可解析响应保留身份与 FIFO head，阻止自动重发。明确拒绝仍回滚并重试。仅凭同身份合法 child archive + 已观测终态才能对账；interactive 驻留纳入原对账循环，父预写 marker 不足以解除 unknown。
- RETAINED-IDENTITY：claim/reread/ACK 前验证 archive 自身 agent/run/event、正整数 sequence；无 text 的 done 必须能 JSON.parse structured。历史 run/sequence 不与 current 相等；有合法 text 时不要求无关 structured 可解析。旧 identity-review 分支继续只治理不新 claim。
- UNPUBLISHED-ARCHIVE：current accepted failure 的 eventId 路由到与 name 相同恢复门禁；存在 owner registry 时验证其已发布同 accepted identity 且无存储错误，不把可解析的旧 [] 当发布证明。无关 current 故障不阻断合法历史；ownerless 且无 registry 的既存 immutable 可纯读，不制造 owner。
- Opus 顾问复核指出两项额外窄持久化缺口（best-effort 预写仍联系 executor、合法旧 registry 不代表发布）；先分别 red 后补严格门禁，未机械重构其他发布/四入口事务。

## 真实执行命令与证据
前缀 `R=/Users/rolex/Documents/Codes/githubProject/MyProject/pi-herdr.spec43-pr56-jj-review-fix-r2`、`E=/tmp/pi-herdr-pr56-r2-evidence`、`H=$E/host`，所有实际执行使用绝对路径。
- 建 host：`node --experimental-import-meta-resolve /tmp/pi-herdr-pr56-fix-context/prepare-sdk-host.mjs $R $R $H 5563d43d445094fda57a801cb181607aae9f8f4e`。复制完整源码（不 symlink src），独立 node_modules overlay；coding-agent/core/AI 均 1.0.4，fixture parity=true。host manifest 中 revision 是建副本基线，不冒充修改后冻结 SHA；交付另保存 source manifest。
- 首三项 red 使用 handoff `/tmp/pi-herdr-pr56-offline.WyKbMI/run.mjs $H tests/<entry>.mjs [selector]`；`unknown-red.log`（lifecycle）、`retained-red.log`（delivery-fixes RETAINED-IDENTITY）、`unpublished-red.log`（delivery-fixes UNPUBLISHED-ARCHIVE）均 exit1 且为业务断言。随后原 `unknown-green.log` / `retained-green.log` / `unpublished-green.log` 均 exit0。
- 主代理指出旧 policy 未包含 r2 写禁后，在 `$E/profile.sb` 只新增独占 policy，不改共享旧工具；新 `$E/run.mjs` 继承原清环境、ENOENT PATH、离线、禁网络/真实 Herdr/原现场/共享依赖策略，另禁止 r2 与旧证据写入，npmcache 私有。`policy-preflight.log` 实测 r2/旧证据写入 EPERM。早期旧 wrapper 日志不声称当时已有 r2 policy。
- 两顾问缺口 red：`node $E/run.mjs $H tests/spec43-pr56-lifecycle.mjs 'UNKNOWN-RETRY registry'` → `unknown-persistence-red.log` exit1；`node $E/run.mjs $H tests/spec43-pr56-delivery-fixes.mjs UNPUBLISHED-ARCHIVE` → `unpublished-stale-red.log` exit1。
- 驻留终态恢复：早期 `unknown-reconcile-red.log` / `unknown-reconcile-corrected-red.log` 混入 fixture none-notification 的旧回收行为，不作该修复有效红证。改为手写 archive + seed terminal observation 后，仅独立 host 恢复原 `!paneId` 条件进行敏感性验证，`unknown-reconcile-control-red.log` exit1；不冒充冻结原始业务红。
- 最终回归：`node $E/run.mjs $H $E/retain-run.mjs tests/spec43-pr56-lifecycle.mjs` → `lifecycle-final5-green.log` exit0；`node $E/run.mjs $H $E/retain-run.mjs tests/spec43-pr56-delivery-fixes.mjs` → `delivery-final-green.log` exit0。新增 selectors：lifecycle `UNKNOWN-RETRY` 前缀（4项，unknown/reload、terminal reconciliation、registry failure、ownerless contact=0）；delivery-fixes `RETAINED-IDENTITY`、`UNPUBLISHED-ARCHIVE`。
- `node $E/run.mjs $H node_modules/typescript/bin/tsc --noEmit` → `typecheck-final2.log` exit0。
- 四独立 SDK入口：`node $E/run.mjs $H $E/retain-run.mjs tests/<entry>.mjs`。spec43-pr56-delivery-sdk、pr56-parent-wait、pr56-parent-sdk exit0。前者包含默认 PRODUCTION NO-TICK SP3、conflicting owner 与 R11，parent 包含跨进程 queued 恢复/unknown 不解锁及自然/mixed/terminate/quiet。
- 原 child SDK `spec43-pr56-child-sdk.log` 在 R2:128 false!=true exit1；独立 baseline-host 同脚本 `child-sdk-baseline.log` 七场景 exit0，故不能称基线同失败。mandatory pre-submit 持久化发现 R2 原 fixture 缺 parentSession/lineage，ownerless dispatch 不合法。经主代理明确同意，仅在 r2 已跟踪 tests/spec43-pr56-child-sdk.mjs 增加父会话/owner substrate，不改 child 生产逻辑；复制同输入至 host 后 `NODE_OPTIONS='--import=$E/retain-preload.mjs' node $E/run.mjs $H tests/spec43-pr56-child-sdk.mjs` → `child-sdk-owner-green.log` 七场景 exit0。另增加 ownerless contact=0 负例，避免仅补 fixture 掩盖门禁。原失败与 baseline 七绿仍原样保留。
- 全量 `node $E/run.mjs $H /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js test` → `npm-test.log` exit1，spec43-t2:143 治理通知 dedup 2!=1。独立 baseline-host 从 integration 5563d43 完整复制，`t2-baseline.log` 同断言 exit1；不越三 P2 范围改旧测试或涂绿。
- `$E/retain-run.mjs` 仅外部证据 lever，拦截 fixture 最后 rmSync 前复制原件；`$E/raw/` 保存 lifecycle/delivery fixture，以及真实 SDK SP3 和 parent SessionManager JSONL。日志的原 hostFile 路径已由 fixture 清理；对应完整目录保留在 raw 同 basename，必须看原件，不用 summary 代替磁盘证明。原 child 失败子进程未继承 retention lever，失败现场无原始 JSONL 留存承诺；合法 fixture 最终 child 七绿使用继承 preload 保存各子进程完整会话原件。

## 未覆盖与偏离
- 模拟 submit、手写 archive/terminal marker 只证明 public entry 控制流与文件门禁，不证明实际远端重复执行已消除。abort 子场景是模拟 TIMEOUT，不是实际 transport AbortSignal。没有真实 Herdr/CLI拒绝映射、live/TUI、最低 Node22.19、Windows、多机或 stress 验收，不承诺跨崩溃 exactly-once。
- Node24.19.0，SDK104 匹配 host；本组不重复 SDK102 全矩阵，留给主代理同 SHA 验收。全量 T2 仍阻塞最终门禁；child 原失败、baseline绿、合法fixture复验绿分开保留，不涂改历史红报告。
- 用户本轮模型要求覆盖旧全 Opus 合同；不调用 dynamic workflow。不移动 integration、不 push/ready/关闭 issue、不清理旧现场。
