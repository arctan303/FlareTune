# 诊断脚本范围

这些脚本不是日常开发、部署或用户安装入口。常用命令见根 package.json 与公开本地开发指南。

- `album-query-cost.py`：使用内存 SQLite，对比当前 HEAD 与工作树中的专辑查询；不会连接 D1。
- `sync-d1.mjs`：从本地 SQL 导出替换本地 D1，含 DROP；必须显式传入 `--replace-local-data`。状态目录与 `dev:worker` 相同，仅针对 `worker/.wrangler/state`，不执行远程同步；失败以非零状态退出。执行前自行保留本地备份。
- 本目录的 Phase 命名脚本是当时版本的诊断/验收辅助，不证明当前 UI 或 API 行为。尤其旧助手 session 路由与 auth 事件脚本不能用作当前验收；需要核验现行契约时使用当前测试与真实操作。

旧工具 `tooling/batch-ingest/server.mjs` 是手动启动的浏览器/本机工具；当前 `npm run ingest` 入口是 `tooling/ingest-agent/cli.mjs`。两者不互相替代运行状态。
