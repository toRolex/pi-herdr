# T5 live demo 运行记录（尚未通过）

`tests/lifecycle-live.mjs` 不是专用 T5 live harness，包含已有 interrupt/resume 场景，不能据其部分 T5 断言宣称验收。

两次运行：

1. `env -u HERDR_ENV -u HERDR_TAB_ID -u HERDR_SOCKET_PATH -u HERDR_BIN_PATH -u HERDR_WORKSPACE_ID -u HERDR_PANE_ID -u PI_SESSION_FILE node tests/lifecycle-live.mjs`
2. 同命令复跑。driver 内会清理继承的 `HERDR_*`、`PI_HERDR_*`、`PI_SESSION_FILE` 环境并建立临时 project。

两次观察一致：
- Child spawn 回执 `status: starting`，但等待 90s 后 Herdr 报 `gone` 而非 `working`。
- busy followup 回执 `queued`；原脚本随后 interrupt/redirect 断言部分不稳定。
- 第二场景 spawn 返回 starting，但未提供可用 pane/session，抛 `part 2 spawn failed`。
- 测试 `finally` 执行 pane/temp-project cleanup；无任何运行完整到 T5 idle/busy/pane-gone 三态及旧 run 结果可寻址断言。

此 README 只记录失败尝试，不是验收证据。专用 `tests/spec43-t5-live.mjs` driver 已存在，但需准备独立 Herdr workspace artifacts 并成功执行；目前没有 artifacts、result.json 或成功 transcript。不要宣称 T5 live demo 通过。
