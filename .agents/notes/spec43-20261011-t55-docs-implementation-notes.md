# #55 限定 docs 修复

## 范围与基点

- owned JJ workspace/bookmark：`pi-herdr.spec43-20261011-t55-docs`，基于 `spec43-20261011-integration` 的 `30cb746d`；身份与 Git 有效配置一致，secret/node_modules ignore gate 已通过，describe-first 已执行。
- 仅修改 `docs/tools/orchestration.md` 与本独立 notes；不改 runtime、测试、GLOSSARY、ADR、AGENTS、CLAUDE、其他 notes 或研究成果。
- 已调用 tdd、pre-implement。没有新增或确认新测试 seam；本次静态文档审查不属于 RED/GREEN，不声明 #55 runtime 依赖已全验收。

## 决策与原因

- 本地未找到名为 `cached55.md` 的文件；读取现有 `/private/tmp/pi-herdr-spec43-cached-bodies-20261010-NxrTH0ty/55.md` 与 `/private/tmp/pi-herdr-pr56-fix-context/ticket-55.md` 的 #55 缓存正文，不访问 GitHub。
- 以 README 和实际注册函数的必要 excerpt 校准七职责：spawn/list/send/followup/wait/result/interrupt；followup 的真实注册名为 `herdr_trigger_turn`，result 保留 `herdr_get_agent_result`。
- 删除“两工具/9注册工具”总数口径，保留原页 result/list/历史迁移结构，避免未来工具注册增减造成漂移。
- legacy message 明确保留唤醒/注入，不等于 QueueOnly，不恢复 takeover、不绕过完成事件仲裁；resume 是维护入口，常规 followup 自动恢复。
- 替换 result 持续 poll 承诺为单次快照：retry 中仅当前非终态状态，无草稿/消费/ACK；等待交给 `herdr_wait_agent_event`。记录正常重复只返回引用、显式 reread 例外。
- 顺带校准同页旧 list `details.agents` 为实际 `details.rows`、状态词汇、历史替代入口和 README 相对链接；均为本页契约修正，不扩大文件范围。

## 验证

- 实际运行 `node tests/t12-migration.mjs`：exit 0，23 passed / 0 failed。
- 实际运行 `node tests/smoke.mjs`：exit 1，184 passed / 9 failed；工具注册检查通过，失败集中于 missing binary、envelope/error mapping、timeout、version probe 等 CLI 路径；未据此推断根因或宣称 runtime 已验收。
- 实际运行 `node tests/spec43-t3-result.mjs`：exit 0；注册消费与真实离线 ExtensionRunner/provider 的 push-first、pull-first、queued-stale、parallel-pulls、concurrent-push-pull 检查通过。
- result 测试额外生成本 workspace 的 11 个已有 `.agents/evidence/spec43-t3` 文件；发现后仅将这些测试生成内容恢复为本 workspace 基点，最终无 old proof 差异。其他 workspace 与旧证据未写入。
- 不跑 full suite、不新增 tests、不做 CLI/TUI scene 操作；静态 doc 审查不标记 RED/GREEN。
- 依赖可通过 ignored node_modules symlink 只读复用旧 integration；不 install、不修改旧 target。
- `spec43-t12-migration-verify.mjs` 会写已存在的 `.agents/evidence` 旧证据，故不在本工作区运行该 harness，避免改动 old proof；选用不写该证据目录的现有 `t12-migration.mjs`。

## 最终整合

- 完成前重新读取 fresh integration bookmark，仍为 `30cb746d`，以 JJ merge 纳入本 owned workspace；未移动 integration 或其他旧 bookmark，合并无冲突。
- 合并后复跑 `node tests/t12-migration.mjs`：exit 0，23 passed / 0 failed。runtime 树未因 merge 改变，smoke/result 上述 actual exit 仍按实报告，未冒充全量验收。
- 最终静态审查确认保持原 doc 章节，七职责工具名与实际注册一致，无硬编码注册工具总数；result 单次快照与 wait 分离，legacy/maintenance 边界明确。交付仅两文件，远低于 600 行限制。

## Deviations

- 无 runtime 或测试范围偏离；缓存文件名与请求简称不同，使用已有 #55 正文校准。
