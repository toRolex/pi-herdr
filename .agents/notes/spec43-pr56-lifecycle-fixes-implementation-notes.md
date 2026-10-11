# spec43 PR56 lifecycle fixes

## Scope / seams
- 仅 R1/R3/R4/R6；基点 9943142，工作树 spec43-fix-lifecycle。
- 主代理确认生产 seams：triggerTurn/resumeAgent、drainQueueOnce、deliverOnce、独立 recycle-worker；临时磁盘 + fake Herdr，无真实 pane。
- delivery.ts 仅关闭授权/close 及旧 close 返回后的 pane 清理段；不碰交付/通知正文。

## Decisions
- R1：关闭与 followup/resume/drain 共用现有 agent execution claim；另固定授权目标并在 await 后复核，避免旧调用结果修改新 run。
- R3：接受恢复时清历史 startBeganAt，不删除当前启动中的排除保护。
- R4：驻留 interactive executor 的 idle/done 队列提交需与即时 followup 共用生产分派路径，且不受新 pane 容量限制。
- R6：旧 worker 只允许更新其读取的 intent，异步返回后重读身份；错误路径不得把旧错误写入新 intent。

## Red / green evidence
- 原组 R1/R3/R4/R6 红绿与 typecheck 已由 RESUME 记录，本次保留既有实现，不重做；原全套在暂停时中止，`/tmp/spec43-pr56-lifecycle-npm-test.log` 与已有 evidence 全保留，不能标全套通过。
- 2026-10-08 接续 R4 失败恢复切片：经生产 `triggerTurn` 接受两个 busy followup，`drainQueueOnce` 在 idle 提交队首明确拒绝；恢复持久 registry 后第二次 drain 必须再次尝试同一队首。旧实现真实红灯：submit 次数实际 1、期望 2；`/tmp/spec43-pr56-lifecycle-R4-retry-red.log`，退出 1。
- 最小修复：新增持久诊断 `followupSubmitError`，明确拒绝时不再写会永久排除队首的终态 `startError`；成功提交清诊断后才移除队首。不放宽真正启动失败的 `queuedRecords` 过滤。
- 绿灯：`/tmp/spec43-pr56-lifecycle-R4-retry-green.log`；随后扩充诊断持久恢复/成功清理断言，全组复验同样绿。轨迹为首次拒绝 → reload → 再拒绝 → 同一 head 成功 → 第二项成功，正文 envelope 与 FIFO 不变，失败不换 run/pane，后项不得趁前项 working 越过。
- 增补已有关闭竞态测试：`resumeAgent` 在旧 close 正 await fake Herdr 的 fleetList 时必须拒绝，不能查询/启动新 executor，也不能修改旧身份和已接受队列。
- 增补 autonomous settled 负例：idle/done 即使另有空闲 pane 容量也不提交到旧 autonomous executor；已交付但 retirement pending 同样不能越过。不新增生产行为。
- `env -u HERDR_BIN_PATH node tests/spec43-pr56-lifecycle.mjs`：6 项测试全部通过（含 R3 followup/resume reload、R1 真实 fake transport 关闭竞态、R4 FIFO/容量、autonomous 负例、失败恢复、R6 独立 worker 两故障时序）。日志 `/tmp/spec43-pr56-lifecycle-resume-green.log`。
- `env -u HERDR_BIN_PATH npm --prefix /Users/rolex/Documents/Codes/githubProject/MyProject/pi-herdr.spec43-fix-lifecycle run typecheck`：通过，日志 `/tmp/spec43-pr56-lifecycle-resume-typecheck.log`。
- 额外旧组内脚本：`lifecycle.mjs` 71/71、`spawn.mjs` 307/307、`spec43-t5.mjs` 27/27，各脚本均退出 0。使用先清外部 HERDR_BIN_PATH、再注入临时 fail-closed fake Herdr 的 wrapper；fake 记录并拒绝所有默认 transport 请求，不可能落到真实 Herdr。wrapper 的额外“零默认 transport 调用”断言失败（旧脚本确有 version/pane current/agent get/send-keys 回退），因此整个 wrapper 退出 1，不能把它称为完全绿的 wrapper 验收。脚本断言结果和所有 fake 请求完整保留于 `/tmp/spec43-pr56-lifecycle-resume-legacy.log`；fake evidence 位于 `/var/folders/d9/_0gbv97x6332wsrqhr4fcyj80000gn/T/spec43-lifecycle-guard-m9LGsp/`。不扩大本轮写域修旧 harness。
- `strong-model-consultant`（显式 model=opus）交付前只读局部复核：本次 R4 修复最小完整，无必须修问题；确认 diagnostic 与 terminal failure 分离、reload/FIFO、finally 锁释放和两个负例。仅静态复核，不冒称顾问运行测试。

## Deviations / limits
- 本次仅新增修改 `src/spawn.ts`、`tests/spec43-pr56-lifecycle.mjs`、本 notes；保留已有 `src/tools/lifecycle.ts`、`src/delivery.ts` 关闭段、`src/recycle-worker.mjs` 的改动。未触碰 delivery 事件/告警写域或其他组文件。
- 原 worktree 阶段按接续用户约束未执行版本控制。后续 coordinator 明确交接已由其创建的新 jj workspace `/Users/rolex/Documents/Codes/githubProject/MyProject/pi-herdr.spec43-pr56-jj-lifecycle`，授权仅迁移六个限定文件、jj 合并当前 integration 与建立本组 bookmark；原 worktree 和 evidence 不动。
- 新 workspace 首次 snapshot 前安全门通过：无实际敏感文件，`.env`/`.env.local`/node_modules 已 ignore；Git 与 jj 有效身份及 change 作者一致为 rolex <torolex@163.com>。四个已有目标文件逐字节匹配 9943142，新测试及 notes 原不存在，核验后才复制。首次 status/diff 仅上述六个文件。
- 合并前本组六项回归及 typecheck 通过，日志 `/tmp/spec43-pr56-jj-lifecycle-premerge-tests.log`、`/tmp/spec43-pr56-jj-lifecycle-premerge-typecheck.log`；差异存 `/tmp/spec43-pr56-jj-lifecycle-premerge.diff`。
- 执行授权的 `jj new @ spec43-pr56-jj-integration`：父修复 pvrkqmvv / 4213ac7b，整合父 mlsrwwwy / 20d73c8e，无冲突。合并后同组六项与 typecheck 复验日志 `/tmp/spec43-pr56-jj-lifecycle-postmerge-tests.log`、`/tmp/spec43-pr56-jj-lifecycle-postmerge-typecheck.log`。
- 不 push，不移动其他 workspace/bookmark，不清理。package.json 新测试接入与最终全量验收仍留 integration。
- 不跑改写大量旧 evidence 的全套；集成合并、全套与最终 15 项闭环待 integration。没有真实 Herdr 修改命令，没有 live/TUI/Windows/最低 Node 或掉电 exactly-once 验证。
- 本切片只验证明确拒绝的恢复；不把超时/进程退出等未知提交结果当作 exactly-once 证明，亦未扩展进程崩溃中的提交事务协议。
