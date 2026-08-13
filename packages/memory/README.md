# @ironlaw/memory

效率工程组件之一。把跨会话记忆做成一个可被任何智能体编程框架接住的 MCP 组件。

记忆**跟着用户走，不跟着设备走**。它是 IronLaw 的互补：IronLaw 治"这一会话里别造假"，记忆治"下一个会话还记得"。

## 多宿主特色

一台机器装多个编程智能体时，本组件真正的价值不是"共享"，而是：

- **不互相污染**：写入自动记录 `source`（哪个宿主写的），检索/注入可按 `source` 过滤；
- **不怕共享**：该共享的（全局偏好、踩坑结论）默认全库可查，一次写入、处处复用。

默认同步，按需隔离。

## 术语

| 术语 | 含义 |
|---|---|
| Memory Graph | 记忆图：跨会话记忆的结构 |
| ACI | 记忆主动注入：按当前任务查图，把相关记忆注入上下文 |
| `scope` | 作用域：`session`（临时）/ `user`（持久） |
| `key` | 记忆节点标识 |
| `tags` | 分类标签，检索过滤用 |

## 记忆骨架：tag + scope

- **scope 两级**：
  - `session` → 临时记忆，会话结束即释放；
  - `user` → 持久记忆，本地 + Gitea 同步。
- **tags**：分类标签，检索时过滤用。
- **节点结构**：`{ key, value, scope, tags, source, ttl_seconds, updated_ts }`，检索返回 `score`。

## 原语

| 工具 | 语义 | 注解 |
|---|---|---|
| `memory.write` | 写入记忆 `(key, value, scope, tags, ttl)`；**写入前强制脱敏** | destructiveHint |
| `memory.search` | 查 Memory Graph `(query, scope, limit, source?)` → `[{key, value, score, updated_ts}]` | readOnlyHint |
| `memory.forget` | 遗忘 `(key)` | destructiveHint |
| `memory.recall` | 按 `key` 读单条全文 | readOnlyHint |
| `memory.inject` | ACI：按任务查图，返回格式化记忆块供注入上下文 | readOnlyHint |
| `memory.sync` | git 后端拉取/推送状态 | readOnlyHint |

## 协议基线

- 按 **legacy MCP（2024-10-07 ~ 2025-06-18）** 实现：`initialize` / `tools/list` / `tools/call`，JSON Schema、Tool annotations；不实现 2026-07-28 modern（`server/discover` + 每请求元数据）；
- `initialize` 只接受 legacy 协议线 `2024-10-07` / `2024-11-05` / `2025-03-26` / `2025-06-18`，2026-07-28 及虚构版本明确拒绝，不 echo 冒充支持；
- 传输：本地 `stdio`（已实现）；Streamable HTTP 是 roadmap，未实现；
- 不用已废弃的 Roots / Sampling / Logging。

## 存储

本地 git 仓库 + 可选 Gitea 远端（单节点，不做多节点/星网）。记忆节点按 `scope` 分目录，`key` 命名文件，内容为 value + 元数据。`memory.sync` 做拉取/推送。

## 与宿主自带记忆的关系

Claude / Grok / Codex 各有本地记忆（CLAUDE.md、auto memory 等），那是"本机、单宿主、自动加载"的笔记。本组件存的是"跨宿主、明确要共享、按需注入"的事实——两者定位不同。

`memory.inject` 只返回记忆块、不触发任何工具调用，避免与宿主自动加载的记忆重复、或与其它治理注入（如 IronLaw 锚点）互相触发造成循环。

## 边界

- 开源的是**组件代码**，不是记忆数据（数据含凭证，永不进 public 仓）；
- `memory.write` 的脱敏是前置硬门槛，不是事后补救。
