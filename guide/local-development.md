# 本地开发

## 前置条件

- Node.js 22.12.0 或更高版本及 npm。
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

首次访问先验证 `SETUP_SECRET`，再填写管理员用户名和密码。密钥验证不写 D1；最终提交会安装当前内置数据库结构。

## 验证

```powershell
npm.cmd test
npm.cmd run build
npm.cmd run verify:worker
```

`verify:worker` 使用标准配置做 dry run，不执行线上发布。`npm.cmd run preview:worker` 可运行本地整站预览。开发脚本和本地 D1 状态不会替代全新 Cloudflare 实例的安装验收。
