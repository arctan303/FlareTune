# 数据库目录用途

- `migrations-flaretune/`：当前 FlareTune schema 与功能迁移。Wrangler 配置和 schema bundle 生成器使用此目录；不得更改已执行迁移来修改已有实例。
- `migrations/`、`migrations-v5/`、`schema.sql`、`seed.sql`：历史结构、迁移与诊断输入，不是当前新安装步骤。部分历史测试仍显式引用它们；保留用于追溯，不将其应用于当前实例。

全新实例通过应用初始化事务建立数据库，已有实例通过受控升级入口处理兼容迁移。目录整理不代表允许重建、删除或迁移部署者数据。
