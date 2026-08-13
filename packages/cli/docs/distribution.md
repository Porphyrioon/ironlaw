# 分发与安装

GitHub 放源码、Issue、CI 和 Release。日常安装走 npm 包，不要求把 GitHub URL 填进智能体编程框架的配置。

```text
GitHub   源码 / 审计 / Release
   │
   └── npm  @ironlaw/cli
              ├── 自动探测已安装框架，接入对应适配器
              ├── sidecar
              └── install-manifest.json
```

把 `github:org/repo` 写进框架配置只适合临时试用：版本不钉死，分支一变行为就变，离线环境也不可用。

## 安装完成意味着什么

```text
框架可执行文件可用
hooks 或插件已注册
适配器已被框架加载
sidecar 握手成功
事件能写能读
回滚清单已生成
```

## 本仓库

单 npm 包：CLI、适配器与 sidecar。
