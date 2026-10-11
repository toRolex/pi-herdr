# #45 fresh TDD unit

## Scope / seams
- Base: #44 ready `vtlnuupl / 0ca25bb150ccbd52104f011e885abc54d5e15b90`。
- 用户已确认公共 seam：真实 `registerChildExtension(pi)` 注册的生命周期 callbacks 与 `agent_done.execute`；仅 fs/process/UI 外部边界注入。
- Slice 1：autonomous settle completion 与 diagnostic sidecar 双失败仍有可见错误，不 recycle/shutdown；interactive 自然 settle 保持 resident，done 显式返回 error。
- Slice 2：completion / legacy bridge / recycle intent 发布后目录 fsync 在成功回执、spawn worker、shutdown 前；sync 失败不正常回收，同 run 重试不造新 event/final。
- 不改 #53 grace/retry/终态语义；不声称真实 Herdr/TUI 或 crash/power-loss 矩阵通过。

## Decisions
- 创建 workspace 时 `--ignore-working-copy` 导致初始 checkout 未完成；仅对新空 owned change rebase 到 ready SHA，确认 parent 和 clean status 后才开始修改，旧 workspace 无改动。
- 复用现有 `tests/spec43-t2.mjs` 公共注册 seam；不重写业务算法。

- Slice 1 正式 RED：两故障计数均为 1，但 public callback 无 error UI notice，`node tests/spec43-t2.mjs` exit1；仅向 `writeSidecar` 增加错误报告 callback 并在两个 autonomous settle 路径通知，保持 done 的显式 error 回执。GREEN 同命令 exit0；typecheck exit0。
- 最初 fault 未命中属 harness 问题，不计 RED：Jiti 在 import 时捕获 builtin exports。改为 import 前安装 fs/process forwarding hooks，之后只切换外部 I/O 函数；清理恢复原导出。未 mock 内部业务 collaborator。
- Slice 2 RED：实际 trace 为 completion/legacy/recycle 发布后立即启动 worker，无目录 sync，exit1。最小 helper 对父目录 open/fsync/close；completion 发布后，以及既有 writeDurable 的 rename 后调用，涵盖 legacy/recycle 两点。GREEN 三处目录 EIO 均阻止 done 成功、shutdown 和 worker；恢复后同 run 保留已发布 event 原 bytes、完整 final 与唯一 event。
- GREEN 实际执行：`node tests/spec43-t2.mjs`、`node tests/spec43-pr56-child-sdk.mjs`（7 cases，真实 @earendil-works SDK/SessionManager）、`npm run typecheck` 均 exit0。
- diagnostic sidecar 是 best-effort 治理信息，不声称其 crash durable；UI notice / done error 独立于诊断文件成功与否。未改 grace timer 与 retry/终态语义。

- 交付前 fresh integration：rebase owned change 到 `oozxzmro / 30cb746d6acb1c47c3c61aa54b262dd20579af6b`（#51 + result ACK fixture），无冲突；重跑 t2、真实 child SDK 7 cases、completion-body、t3-result 与 typecheck，全部实际 exit0。

- 协调器要求交付保留两个 parent：在已 rebase 的 owned fix 上再创建 `@ + fresh integration tip` merge change，bookmark 指向该 merge；其后重跑 public child 回归与 typecheck。
- `t3-result` 会改写 owned checkout 内的 11 个 tracked evidence 输出；只将这 11 个测试生成物还原到 integration parent bytes，不交付历史证据噪音；旧 workspace / external sealed proof 未修改。

## Deviations / evidence limits
- 未执行真实 Herdr/TUI 故障矩阵、掉电/崩溃恢复或整票 AC 验收；不能报 #45 全票 PASS。
- 依赖只在 owned workspace 建 ignored node_modules symlink，引用既有只读依赖，不安装/改依赖。
