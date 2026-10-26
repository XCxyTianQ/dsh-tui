# Workstream: remote-protocol

- 状态：in-progress
- 分支：`feat/remote-protocol`（fork: XCxyTianQ/dsh-tui）
- 写入范围：`lib/client.js`、`lib/stream.js`、`lib/session.js`、`lib/live.js`、`bin/tui.js`、`test/client.test.js`、`test/stream.test.js`、`test/session.test.js`、`docs/remote-protocol.md`、`README.md`
- 依赖：DSH host ≥ 0.2.0（Typert Remote 契约）；本机实测 host 0.2.1-rc.2
- Implementer：lead（DSH Agent 会话）
- Reviewer：待指定
- 恢复点：`feat/dsh-tui` @ 56cb5fb

## 目标

让 dsh-tui 能连上 DSH 0.2.x 的 `dsh web`：认证（browser-auth cookie）→ unary Remote（`/api/<ns>/<method>` + `args`）→ follow 流（`/api/remote.mux` WebSocket）。

## 验收

- `npm test` 全绿（本机 211 例）
- 对隔离 host（127.0.0.1:3095）实测：列会话、建会话、发 prompt、回合走完、历史可折
- 不改变 3090 上用户 WebUI 的行为（隔离 home + 独立端口）

## 未覆盖（M2）

- approval/question 交互帧（`/api/$events/result` 应答）
- `session/control` 流（queue/jobs/projection）
- subagents 列表（新 host 无 `subagents/list`，M1 返回空）

