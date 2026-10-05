# 诊断脚本范围

这些脚本不是日常开发、部署或用户安装入口。常用命令见根 package.json 与公开本地开发指南。

- `album-query-cost.py`：使用内存 SQLite，对比当前 HEAD 与工作树中的专辑查询；不会连接 D1。
- `sync-d1.mjs`：从本地 SQL 导出替换本地 D1，含 DROP；必须显式传入 `--replace-local-data`。状态目录与 `dev:worker` 相同，仅针对 `worker/.wrangler/state`，不执行远程同步；失败以非零状态退出。执行前自行保留本地备份。
- `navigation-cache-regression`、`play-stats-preview-regression`、`search-submit-regression` 和 `roam-continuation-regression` 是针对当时页面的隔离诊断场景，须先检查其 fixture 与当前组件是否一致，不能当作完整应用验收。
- `roam-sampler-prototype` 是可行性原型，现行漫游实现位于 `server/src/services/roamSampler.js`；不要将原型结果写成线上 D1/CPU 收益。`artist-photo-test.html` 也不是产品页面。

旧工具 `tooling/batch-ingest/server.mjs` 是手动启动的浏览器/本机工具，`npm run ingest:build` 只构建其页面；当前 `npm run ingest` 入口是 `tooling/ingest-agent/cli.mjs`。旧工具的多实例、R2 直传、并发和本地进度持久化不能当作现行设备能力，现行步骤见[入库设备指南](../ingest-agent/README.md)。
