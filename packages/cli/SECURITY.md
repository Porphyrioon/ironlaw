# Security

## 本地数据

Sidecar 状态只写本机：

- Windows：`%LOCALAPPDATA%\IronLaw\`
- 其它：`~/.cache/ironlaw/`

事件在插件进程内脱敏后再落盘。账本不是完整命令抄本。不要提交缓存、manifest 或智能体编程框架的凭据。

IronLaw 不上传源码、提示词或密钥。若以后增加联网导出，必须默认关闭，并先改本文件。

## 不做的事

- 按进程名批量结束智能体编程框架的二进制
- 在 `npm install` 的 `postinstall` 里拉起框架或 sidecar
- 默认开启会挡住普通编辑的强制模式

某一智能体编程框架自己的进程管理，由该框架负责。

## 报告漏洞

走仓库的私密 Security Advisory，或联系仓库资料里的维护者。下列问题不要开公开 Issue：

- 日志 / 报告泄露密钥
- 在没有独立证据时把任务标成 `VERIFIED`
- 供应链问题（被替换的 sidecar、被投毒的包）

请带智能体编程框架名称、版本，以及脱敏后的 `doctor` 输出。先去掉 API Key、token 和本机绝对路径。

## 首次公开发布前

- MIT `LICENSE`、本文件、`NOTICE`
- Release 附 SHA-256
- 发布 npm 时使用 `npm publish --provenance`
- 无必要不增加运行时依赖
