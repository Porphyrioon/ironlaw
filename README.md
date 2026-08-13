# IronLaw

IronLaw 是专为 DeepSeek Harness 量身定制的编排插件：基于通用编程工具（hooks / sidecar / MCP）改装，把上万条真实工程记录里踩过的坑、避过的雷，固化成三道自动化关卡——

- **执行前拦截**：危险命令、敏感路径写入，动手前就拦；
- **执行后取证**：工具调用、退出码、文件变更，全程落账可审计；
- **完成前把关**：没有真实验证证据，"done" 一律不认。

框架负责运行 Agent，IronLaw 负责证明它做了什么、是不是真做完了。内核通配多宿主，DSH 是首个完整落地的宿主。

## Packages

| Package | npm | Role |
|---|---|---|
| [`packages/cli`](packages/cli) | `@ironlaw/cli` | Plugin + sidecar + installer (`ironlaw`) |
| [`packages/memory`](packages/memory) | `@ironlaw/memory` | Git-backed, source-scoped shared memory MCP server |
| [`packages/adapter-dsh`](packages/adapter-dsh) | `@ironlaw/adapter-dsh` | DeepSeek Harness native Cordis plugin (evidence + enforcer blocking + completion gate) |

## Quick start

```sh
npm install
npm test
```

See each package's README for install and framework-specific setup.

## Frameworks

| Framework | Adapter status |
|---|---|
| DeepSeek Harness (DSH) | native Cordis plugin implemented (evidence + enforcer blocking + completion gate) |
| OpenCode | hooks + sidecar implemented |
| Claude / Grok / Codex / Qoder / Zcode | detected, adapter planned |

## License

MIT. IronLaw is an independent component; it is not affiliated with any coding
framework or model vendor.
