# 本地开发

[简体中文](local-development.md) · [English](local-development.en.md)

## 前置条件

- Node.js 22.18+（22.x）或 24.11+及 npm。
- 本地开发使用 Wrangler 的 D1/R2 模拟绑定；不要求连接维护者的 Cloudflare 资源。
- 自行准备高强度的 `SETUP_SECRET`，仅写入未跟踪的 `server/.dev.vars`。

在仓库根目录运行：

```powershell
npm.cmd ci
Copy-Item .dev.vars.example server/.dev.vars
```

编辑 `server/.dev.vars`，为 `SETUP_SECRET` 填入自己的随机值，不要提交此文件。本地 D1 保持空库；首次访问时由应用创建结构和管理员。不要为新库先执行 Wrangler migration 命令。

分别在两个终端启动 Worker 和前端：

```powershell
npm.cmd run dev:worker
```

```powershell
npm.cmd run dev
```

前端地址是 `http://127.0.0.1:3000`，本地 Worker 默认在 `http://127.0.0.1:8789`。前端同源 `/api`、`/auth` 和 `/media` 请求默认代理到本机 Worker。需要连接自己管理的其他隔离 Worker 时，可显式设置 `FLARETUNE_DEV_WORKER_ORIGIN`；不要把陌生实例用于本地测试。

只开发前端并连接本项目线上**开发** Worker 时，先停止已经占用 3000 端口的本地前端，再在仓库根目录运行 `npm.cmd run dev:cloud`，打开 `http://127.0.0.1:3000`。此命令将 `/api`、`/auth`、`/media` 代理至 `https://flaretune-dev.arctan.workers.dev`，无需启动本地 Wrangler；登录使用开发实例的管理员账号。默认 `npm.cmd run dev` 仍连接本地模拟 Worker，避免无意中修改开发云数据。需要更换端口可设置 `FLARETUNE_DEV_CLIENT_PORT` 后启动 `dev:cloud`。

首次访问先验证 `SETUP_SECRET`，再填写管理员用户名和密码。密钥验证不写 D1；最终提交会安装当前内置数据库结构。

## 分支与开发 Worker

日常改动提交到 `dev`，经过开发环境验证后再进入 `main`。本地 `npm.cmd run dev:worker` 使用模拟 D1/R2；切换 Git 分支不会改变这些绑定。

维护者已有独立的 `flaretune-dev` Worker、开发 D1 和开发 R2。云端开发的手动部署配置保存在被 Git 忽略的 `server/dev/wrangler.toml`；Cloudflare Builds 则使用根目录 `wrangler.toml` 的 `dev` 环境和仅限 `dev` 分支的部署脚本。构建变量 `FLARETUNE_DEV_D1_ID` 只在 Cloudflare 设置，不提交资源 ID；其他贡献者应绑定自己的隔离资源。不要将开发资源 ID、密钥或个人配置写入仓库根 `wrangler.toml`，该文件供使用者一键部署。

Cloudflare 的分支 Preview 也需要单独配置变量及 D1/R2 绑定，不会继承生产 Worker 的资源；见[官方 Preview 配置说明](https://developers.cloudflare.com/workers/previews/configuration/)。

## 验证

```powershell
npm.cmd test
npm.cmd run build
npm.cmd run verify:worker
```

`verify:worker` 使用标准配置做 dry run，不执行线上发布。`npm.cmd run preview:worker` 可运行本地整站预览。开发脚本和本地 D1 状态不会替代全新 Cloudflare 实例的安装验收。
