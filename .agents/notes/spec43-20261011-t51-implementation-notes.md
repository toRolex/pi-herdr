# #51 completion body 最小修复

## Scope / Decisions
- 用户已确认公开 seam：`registerResultTool` 注册后的 `herdr_get_agent_result.execute`。只修 Pull error / 无 final done 的自动 session 路径；完整 final、真实交付物、metadata、isError 不变。
- 已读 GLOSSARY 与 ADR-0001；使用真实 completion sidecar / archive / delivery ledger，仅注入 registry 与禁止 live I/O 的 deps。
- 将四类正式回归加入已有 `tests/completion-body.mjs`，自动纳入现有 npm test，不把 scratch patch 当交付。
- JJ/Git identity 均 rolex <torolex@163.com>；实际无敏感文件，.env/.env.* 与 node_modules ignore 生效。

## Deviations
- 从 integration 使用 `workspace add --ignore-working-copy` 创建 owned workspace 后，JJ 拒绝 materialize，遗留 owned root 空 child。仅在新 owned workspace 将该空 child rebase 到已确认的 integration tip 57589e29；materialize 后确认 empty、正确父提交与 describe-first。未修改其他 checkout 或 bookmark。

## Verification
- 正式 `node tests/completion-body.mjs` RED exit 1：四类均执行，error-final / done-empty / legacy identity-review 无正文各两项泄露断言失败，共 6；其他断言均保留且通过。
- 最小生产修复删除 `where` 定义与两处插值；同一正式测试 GREEN exit 0。`node --check tests/completion-body.mjs`、`npm run typecheck`、`node tests/substrate.mjs`、`node tests/delivery-render.mjs` 均 exit 0。
- `node tests/spec43-t3-result.mjs` exit 1，:140 预期 pending、实际 delivered。仅在 owned 树暂时恢复 integration 原版 result.ts 重跑，仍同位置同原因 exit 1；随后恢复固定版本。不扩大本 bug-fix 范围。
- 执行环境：owned `.scratch/t51/home`，关闭 JITI FS / module cache，链接现有只读 node_modules。未运行完整测试套件。
- 完成前 fresh 读取 integration bookmark，tip 已推进至 rklyxktu / 88be1fe40da93970287232d5ce2f582f5b6e71fb。以 JJ `new <owned fix> <integration tip>` 创建双父 merge change；无 conflict，未推进 integration bookmark。合并后正式 completion-body GREEN exit 0。
- 此单元不覆盖真实 TUI/SDK 接收全文验收，不宣称 #51 整票 PASS。
