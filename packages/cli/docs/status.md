# 模块

| 路径 | 作用 |
|---|---|
| `src/cli.js` | 安装、探测、状态、卸载 |
| `src/plugin.js` | 智能体编程框架侧插件入口 |
| `sidecar.js` | 本地 NDJSON sidecar：任务状态与证据 |
| `src/redact.js` | 落盘前脱敏 |
| `src/fallback-policy.js` | 保守的前置规则 |
| `tests/` | 策略、脱敏与 sidecar 握手 |

数据目录在本机缓存下，不进 Git。智能体编程框架自身的进程管理不在本仓库。
