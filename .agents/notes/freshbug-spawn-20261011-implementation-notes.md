# Fresh isolated spawn fixture diagnosis

- 基线：正式 integration a03f893fe48d51a925fa1b04610dbb192499f48e；仅 owned JJ workspace，未修改旧 root/worktrees、旧 proof 或共享 bookmark。
- 原正式 spawn 在 owned HOME、双 CLI alias failclosed pin、无网络沙箱、JITI_MODULE_CACHE=true 下复现 tests/spawn.mjs:1234 held undefined，actual exit 1。
- source 注册仍是 handle → record，工具 acceptance 同步返回 identity；用返回 name lookup 仍 RED，registry 为空，排除新 logical lookup 契约。
- 新 public seam guard 验证 spawnFromTool acceptance 的 agentId/runId/sequence 与 spawnRecords 中一致；先记录 guard RED，不跳过 case，也不把 undefined 当成功。
- tryNative:false 单变量控制仍 RED，弃用该改动。将三个初始 source imports 统一为 realpath(src) 后 GREEN 308/308，证明 runner 的 symlink alias 与 transitive .js imports 导致 Jiti 模块实例分裂。产品 source 无需改动。
- 原 semantic assertions、工具 cap/queue 场景保留；继续使用默认 loader，不引入私有接口。只 canonicalize source，ROOT 仍指向 owned fixture 文件。
- CLI alias HERDR_BIN_PATH/HERDR_BIN 按本地 src/herdr-transport.mjs resolver 查证；均指 owned exit-97 guard，不默认返回伪成功、不访问真实 daemon。已有 makeGridDeps 仍用其 controlled fixture。

## Deviations

- jj workspace add 携带 --ignore-working-copy 创建目录后无法更新工作副本；仅在新 owned workspace 使用 jj new a03 修正，未恢复其他 workspace 或 refs。
- 用户禁止网络，未请求外部 SDK/CLI 文档；本任务只依据本地 source/安装版类型定义作行为诊断，不声明真实 host 或 SDK actual runtime 已验证。
