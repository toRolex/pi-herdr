# Spec29 串行合入记录

## 约束与决策
- 唯一 integration 写入者；不改主 checkout、不 push、不关 issue。
- 所有命令 env -i，仅传 PATH/HOME；不 snapshot 其他工作树。
- 每票先确认完成 commit 及 integration 祖先关系；缺当前 tip 时请 worker 补合。
- jj 操作修改历史；wt 仅用于工作树管理。integration 的 `.jj/` 为本地元数据，不入库。

## 第一票：completion
- 输入：d5f3864907e234fdab625a51358f248479beb48c；基线 fd5f668c1ae7d42294282c3e7e5a23b3e2dc62de。
- 双父合入；无冲突。保留新增 completion-body 测试及 package test script。
- completion-body / substrate / delivery 全通过，日志 `/tmp/pi-herdr-spec29/merge-completion-tests.log`；delivery 151 passed。
- typecheck 通过，日志 `/tmp/pi-herdr-spec29/merge-completion-tsc.log`。
- node_modules 无跟踪文件。

## 后续票：收尾 implementer → merger
- recovery 输入 15c42053；worker 同步 abd1b064（父 ff179b6e），integration merge 0f25acaa。body/substrate/delivery156 + tsc 通过；日志 `recovery-sync.log`、`recovery-sync-tsc.log`、`merge-recovery.log`。
- recovery 工作树缺 pi-tui，本地 ignored node_modules 补 integration 包的 symlink，不改依赖清单、不入库。
- t38 输入 331fac92；worker 同步 c3ef033d（父 0f25acaa），integration merge 176c9846。body/channel/substrate/delivery169 + tsc 通过；日志 `t38-sync.log`、`merge-t38.log`。
- t38 冲突保留 runStart、event reset、latestMessages clear、正文与 event 字段；测试脚本同时保 body/channel。channel fixture 在 agent_start 后追加当前 run 正文，旧写法预先写正文导致新 boundary 正确拒绝完成。
- inbox 输入 c5eea511；worker 同步 1d5138da（父 176c9846），integration merge 948e7e8f。inbox/message/body/channel/substrate/delivery169 + tsc 通过；日志 `inbox-sync.log`、`merge-inbox.log`。
- inbox 保留 receiver admission，移除旧 sender limiter，同时保留 completion event；index 仅注册 registerReceiverInbox(parseAgentMessage, handleAgentMessageInput)，不双注册。
- 三票在返回 integration 前均 git merge-base --is-ancestor 验证当前 integration tip 已包含。
- 全部日志目录 `/tmp/pi-herdr-spec29/`。

## Deviations
- 使用 --ignore-working-copy 改历史后工作树 stale；仅在 integration 执行 workspace update-stale，使合入文件落盘。未对其他工作树运行 snapshot。
