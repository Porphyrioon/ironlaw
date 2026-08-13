# 智能体编程框架

适配器挂在智能体编程框架共享的扩展点上（hooks 或等价的插件 API）。同一框架的 GUI / TUI / CLI 共用一块适配器。

## 契约

```ts
interface FrameworkAdapter {
  framework: string
  capability(): Promise<CapabilityFingerprint>
  install(ctx): Promise<InstallResult>
  uninstall(ctx): Promise<void>
  doctor(ctx): Promise<DoctorReport>
  translate(frameworkEvent): UnifiedEvent | null
  apply(decision): Promise<void>
}
```

`capability()` 报告版本、hook 名称、可阻断的事件、idle 语义、子代理是否覆盖、以及能否注入短文本。

## 接入方式

| 类型 | 例子 | 做法 |
|---|---|---|
| 具备 hooks 的智能体编程框架 | Claude、Grok、Zcode、Codex、Qoder 及同类工具 | 适配器 + sidecar |
| 仅有 MCP 或规则入口 | 部分 IDE / 工作台 | 用户自行粘贴 Prompt |
| 无公开扩展点 | — | 不接入 |

## 给不具备 hooks 的框架

```text
本次任务请使用 IronLaw MCP 最小工具集：
1. il_status：读取当前任务阶段、目标和风险；
2. il_check：在宣称完成前检查 spec、变更和可复现实据；
3. il_report：输出事实、证据、未完成项和阻塞原因。
不要把测试通过、模型自述或手工摘要单独当作完成证据。
```
