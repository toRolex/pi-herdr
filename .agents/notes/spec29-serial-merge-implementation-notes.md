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

## Deviations
- 使用 --ignore-working-copy 改历史后工作树 stale；仅在 integration 执行 workspace update-stale，使合入文件落盘。未对其他工作树运行 snapshot。
