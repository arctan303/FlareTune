# 数据库目录用途

- `migrations-flaretune/`：当前 FlareTune schema 与功能迁移。Wrangler 配置和 schema bundle 生成器使用此目录；不得更改已执行迁移来修改已有实例。
- `migrations/`、`migrations-v5/`、`schema.sql`、`seed.sql`：历史结构、迁移与诊断输入，不是当前新安装步骤。部分历史测试仍显式引用它们；保留用于追溯，不将其应用于当前实例。

全新实例通过应用初始化事务建立数据库，已有实例通过受控升级入口处理兼容迁移。目录整理不代表允许重建、删除或迁移部署者数据。

Worker 实际执行 `server/src/instance/migrationBundle.generated.js` 中的内置 SQL 与校验值。迁移集合变化后运行 `node tooling/build/generate-migration-bundle.mjs`；同时核对生成器的列表、schema/功能迁移识别与相关测试。普通 Vite 构建不会自动重新生成此文件，不能只修改 SQL 目录就认为运行时已更新。

`db:migrations:*:local` 使用本机 `worker/.wrangler/state`，不连接云端；其中 `apply` 会修改本地 D1，不用于新空库应用初始化。开发和验证入口见[本地开发指南](../../guide/local-development.md)。

`0013_hotpath_indexes_and_counts.sql` 是兼容的性能附加迁移：新增歌单预览、精确匹配与搜索排序索引，回填并增量维护歌单/播放回执计数。基础 schema/账本仍为 v2，旧 v2 可继续服务；管理端附加迁移状态 `hotpath_counts` 指示是否需要受控升级。新装在同一初始化事务执行，已有库通过内置升级器执行；此代码尚未部署，执行前按既有流程备份。0001–0012 内容保持不变。
