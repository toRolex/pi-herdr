# Platform pre-review fix

- 复用既有 t45 workspace；新 change 基于正式 a03f893fe48d51a925fa1b04610dbb192499f48e，原 5524 change/bookmark/proof 不改。
- 已授权 seams：public registerChildExtension 的 agent_done/agent_settled；真实 child_process native CLI spawn 边界。TDD 先证明 Windows capability 模拟失败，再最小修复。
- Node 官方 /nodejs/node：Windows fsync 使用 FlushFileBuffers，不能由文件 flush 推断 parent directory 掉电持久性。选显式 file-flushed/process-restart capability，不引入 native/PInvoke，不吞实际 I/O 故障。
- 范围仅 child completion/archive/legacy bridge/recycle intent 的 publication，以及 smoke owned fixture native binary adapter；parent-notify/sessionfile 的现有目录同步问题不在本轮修复范围。

## 实现与验证

- Windows simulation 首次 RED：正常 agent_done 因目录 open EISDIR 返回 isError。最小 GREEN：平台显式选择目录同步能力；仅 Windows 新记录增加 `persistenceCapability: file-flushed/process-restart`，POSIX 字节兼容保持。tempfile fsync、same-directory immutable hard link/no-clobber、EEXIST 比对及实际错误传播不变。
- public child tests 覆盖 done/natural settled、完整 body、同 run retry、Windows/POSIX file-write/file-fsync/link/rename EIO 无 shutdown/recycle；POSIX archive/bridge/intent dirsync EIO 恢复后逐项 publish→sync→worker 完整 trace 断言。
- smoke native binary 契约首次 RED（原为 shebang script）。GREEN：process.execPath + owned.mjs，测试加载产品模块前在真实 spawn 边界仅对 fixture binary prepend script，透传原 options/shell:false；missing path 原生委派。当前 transport 没有 execFile 调用，无须加多余 hook；产品 resolver 完全未改。
- 保留 alias pin、owned missing、版本门禁、schema/envelope、timeout、argv/log guards；额外 native argv 核验空串、空格、引号、反斜线、shell 元字符、中文。日志同时核验 binary 与 owned script。
- README 明确 child publication 的平台能力/掉电限界及剩余 parent-notify/sessionfile 范围；package/GLOSSARY/ADR 无需修改。
- 已实际通过：t2、全部 8 个真实 SDK child cases（含 Windows capability simulation）、smoke-fixture-pin、smoke、5 个 MJS node --check、tsc --noEmit。测试 temp/cache 使用既有 owned .agents/evidence/spec43-t2；本轮生成 scratch/cache 在交付前清理，不改旧 proof。

## Deviations

- 当前 Darwin 无 Windows 实机：平台分支验证只能称 simulation，不能声称 Windows 全系统测试通过。
