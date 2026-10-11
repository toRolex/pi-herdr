# Spec43 最终交付实现记录

## 执行边界与原因
- 本轮在新 owned JJ workspace `pi-herdr.spec43-20261011-integration` 续作，基点 `57589e29c9a4cca76dca6dfcf819f35cd24434da`。不修改原主目录、旧 dirty integration checkout、旧 workspace、stash 或旧验证工件。
- 用户取消 auto mode 并明确授权继续后，实际执行保护核验通过；不将文字授权直接等同于工具执行成功。
- 新 workspace 复用已有 ignored `node_modules`，避免安装动作修改旧依赖；验证缓存仅写 owned 路径。
- 现有 PR #56 继续作为 spec43 的 integration PR，不自动 merge、不手动关闭 tickets。旧 PR 完成声明与受限证据不一致，最终正文须使用当前版本的实际验收事实。

## 已确认缺陷与修复选择
- #44：公开 list 在读取 unread 时调用 persistent reconcile，使 queued ledger 转为 delivered/available。保留同一投影判断，给 list 使用只读投影，避免复制状态机；默认 reconcile 仍负责可靠性修复。正式回归必须同时覆盖真实非空 ledger、host body proof、withdrawn receipt、重复 list、registry 不变及默认 reconcile 的立即落盘结果。
- #51：失败完成及无 final done 正文自动附加绝对 session 路径。最小修复仅删除正文来源路径壳；内部身份、路径、交付信息继续保留在 metadata，失败语义与完整 final/真实交付物引用不变。
- #45：完成发布的目录持久化及 autonomous 保存/诊断双失败可见性需要真实公开 child seam 验证。用户已确认 `registerChildExtension(pi)` 生命周期回调与 `agent_done.execute`，不重写完成逻辑作为测试替代。
- #53：grace timer 导致提前终态的静态候选不能直接升级为 confirmed bug；先核对当前实际加载 SDK 的 retry/settle 顺序。当前生产包为 `@earendil-works/pi-coding-agent`，不以缺失的旧包路径或注释替代运行证据。

## 验收原则
- 实际 tickets 为 #44–#55，共 12 票。OPEN 不表示零实现，隔离测试或静态符合也不等于 full AC。
- 每个修复遵循正式 RED→GREEN，独立 workspace；merge 前对齐 integration tip。
- 当前 SHA 全量离线、类型检查、SDK 故障矩阵与真实 CLI/TUI 验收分别记录。真实 holder 必须捕获 argv、topology、session 及 owned cleanup receipt。
- provider fixture 可验证真实 SDK/宿主边界，但须明确替代范围，不据此外推模型授权或历史版本通过。
- 保留既有 RED/失败证据。脚本 preflight 失败、SDK timeout、pane busy、未执行均不得标 PASS。

## Deviations
- 旧四片验证及旧 SHA full green 不重标为新版本通过；本轮使用 current-source 验证，正式修复与隔离候选分开记录。
