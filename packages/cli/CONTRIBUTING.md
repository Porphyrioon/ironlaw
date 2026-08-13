# 参与贡献

本仓库是效率工程组件 **IronLaw** 的产品树。研究对象是非科研、非金融、非医疗、非教育行业的效率范式。

## 开发

```bash
git clone <this-repo>
cd ironlaw-cli
npm test
```

需要 Node.js 20+。本组件没有运行时依赖。

## 为智能体编程框架增加适配器

1. 该框架需要有可验证的 hooks（能观察或阻断真实的工具 / 会话事件）。只有 MCP 的框架走用户自助 Prompt。
2. 按 [docs/framework-matrix.md](docs/framework-matrix.md) 实现契约。
3. 提交时附上对该框架的探测记录，而不是只比较事件名称。
4. 先写 manifest，再改框架配置；卸载只删除本组件写入的条目。

未知版本时保持观察模式。不要用模型自述或单条测试绿灯当作完成证据。

## Pull request

写明智能体编程框架名称与版本，并附脱敏后的 `doctor` 输出。
