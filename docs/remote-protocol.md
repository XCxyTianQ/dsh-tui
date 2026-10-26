# DSH 0.2.x Remote 协议适配说明

本分支把 dsh-tui 从「apiproxy 时代」的 wire 契约迁到 DSH 0.2.x 的 Typert Remote 契约。
两个契约的差异不是配置问题：端点名、payload 形状、流传输、认证方式四处同时变了。

## 1. 认证（browser-auth）

host 对每个 `/api/*` 请求都先认证（连 loopback 也不例外），未认证一律 401，且**路由不存在也返回 401**。客户端必须：

```text
GET /connect?token=<launch token>&interactions=answer
  302 → location: ./api/remote.mux
  set-cookie: dsh-auth-<b64url(sha256(authority))>=v2.<payload>.<hmac>
```

- launch token 来自 `dsh web` 启动时打印的 `http://127.0.0.1:<port>/?token=…`；
- cookie 与 authority（`host:port`）绑定，默认 30 天，但对应的 peer 会被回收 → 客户端在 401 时重新 `/connect` 一次；
- `interactions=answer` 声明本客户端可以应答 approval/question（M2 使用）。

用法：`DSH_URL='http://127.0.0.1:3090/?token=…' dsh-tui`，或单独给 `DSH_TOKEN`。

## 2. Unary Remote

```text
POST /api/<namespace>/<method>
{ "type": "client-request", "rpcId": "rpc-…", "method": "<namespace>/<method>", "payload": { "args": … } }
→ { "type": "server-response", "rpcId": "…", "result": { "ok": true, "value": … } }
```

| 客户端方法（旧） | 新端点 | args 键 |
|---|---|---|
| `session.list` | `session/list` | `_request: {}` |
| `session.create` | `session/create` | `request: { cwd?, sessionId?, agentPreset?, workspaceId? }` |
| `session.prompt` | `session/prompt` | `request: { requestId, sessionId, mode, content }`（requestId 必填） |
| `session.cancel` | `session/cancel` | `request: { sessionId }` |
| `session.history` | `session/page` | `request: { address: { kind: "session", sessionId }, throughSeq: -1, maxMessages? }`，返回 `records[]`（每条 `{type:"event", event}`） |
| `session.modelCatalog` | `session/modelCatalog` | `{}` |
| `subagent.list` | 不存在 | M1 本地返回 `{ items: [] }` |

注意：body 的 `method` 字段必须与端点同名（`session/list`），否则 gateway 报 `method "session.list" does not match endpoint "session/list"`。

## 3. 流：`/api/remote.mux`（WebSocket）

旧 `GET /api/events.mux`（SSE）已删除（404）。新传输：

```text
ws://host/api/remote.mux   (cookie 走 headers)
→ { type: "open", streamId, endpoint: "session/follow", payload: { args: { request: { address: {...}, maxMessages } } } }
← { type: "item", streamId, value: { type: "snapshot" | "event" | "assistant-stream", ... } }
← { type: "error", streamId, error } / { type: "end", streamId }
```

**关键行为**：follow 流同时是会话激活开关。只发 prompt 而不订阅 follow 时，prompt 只进 Agent inbox、**不产生任何事件**（实测：`session/page` 恒为空）；打开 follow 后立刻产生事件并走完回合。因此：

- 交互 TUI：`LiveConversation` 常驻 follow；
- `dsh-tui run`：`Session.converse` 在回合期间后台订阅 follow，结束后关闭。

## 4. 应答通道（M2）

旧 `POST /api/respond` 已删除；新应答通道是 `POST /api/$events/result`（`{type:"client-response", rpcId, result}`）。
M1 只做了端点迁移 + 返回 JSON，approval/question 的帧交互尚未接。

## 5. 兼容性说明

- 本适配针对 DSH 0.2.0+ 的 Remote 契约，**不兼容 0.1.x 的 apiproxy era**；
- 上游 issue #1 记录了同一问题的端点表（0.1.5-rc.1 / 0.2.0-rc.2 两次实测），本分支结论与之一致；
- `lib/client.js` 保留旧方法名作为客户端词汇，翻译集中在 `WIRE` 表；`toWireRequest()` 可直接用于排查。


## 6. 历史读取的切点（throughSeq）

`session/page` 的 `throughSeq` 是必填的 durable 游标，传 `-1` 会得到**空页**（`paginate` 里 `end = throughSeq + 1 = 0`）。
客户端取法：`session/projections({ request: { sessionId } })` → `{ kind: "sequenced", asOfSeq }`，把 `asOfSeq` 当 `throughSeq`。

实测（隔离 host 0.2.1-rc.2）：

```text
projections → asOfSeq 21
session/page { address:{kind:"session",sessionId}, throughSeq:21, maxMessages:30 } → records 22 条
```

M1 每次 history() 都先问一次 projections（本地开销可接受）；M2 接 follow 快照后可直接用 snapshot.cursor，省掉这一步。

