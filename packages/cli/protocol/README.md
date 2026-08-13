# 协议 v1

传输：sidecar stdio 上的 UTF-8 NDJSON，一行一个 JSON。

## 信封

```json
{
  "v": 1,
  "id": "msg-001",
  "type": "event|request|response|decision",
  "ts": "2026-08-13T00:00:00Z",
  "framework": "claude",
  "sessionID": "<会话 id>",
  "projectKey": "<项目路径 sha256 前缀>",
  "payload": {}
}
```

树上的 `sidecar.js` 使用 `{ id, method, params }` 请求形。新适配器沿用同一套信封，不要另起方言。破坏性变更必须提高 `v`。

## 统一事件

| 统一事件 | Claude 式 hooks | 插件式 hooks |
|---|---|---|
| `session.start` / `session.end` | SessionStart / SessionEnd | session created / deleted |
| `message.user` | UserPromptSubmit | chat.message |
| `tool.before` | PreToolUse | tool.execute.before |
| `tool.after` / `tool.failed` | PostToolUse / PostToolUseFailure | tool.execute.after |
| `permission.ask` | PermissionRequest | permission.ask |
| `session.compacting` | PreCompact | session.compacting |
| `session.idle` | Stop | session.idle |

可阻断 Stop 的框架上，完成闸门可以走前置拦截；只有事后 idle 的框架上，走审计与有限续写。闸门同一套，触发点按框架能力选择。

## 决策

```json
{
  "type": "decision",
  "payload": {
    "verdict": "allow|block|warn|repair|inject",
    "code": "BLOCK_DESTRUCTIVE_RM",
    "reason": "human readable",
    "budget_ms": 25
  }
}
```

同步决策默认不超过 25 ms。
