# 部署与初始化

[简体中文](deployment.md) · [English](deployment.en.md)

## 当前状态

维护者已在生产实例测试主要功能，反馈运行正常。公开模板在仓库根目录的 `wrangler.toml` 声明 Worker、静态资源、D1 和 R2；Cloudflare 的部署向导会创建并绑定资源，并依据 `.dev.vars.example` 提示填写 `SETUP_SECRET`。空 D1 的初始化及已知旧版升级已通过本地 Worker/D1 端到端演练。**全新 Cloudflare 账号的实际一键部署尚未验收**。

[一键部署到 Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/arctan303/FlareTune)（仓库公开后可供所有用户使用）。根 `wrangler.toml` 中的 D1/R2 名称和空数据库 ID 是部署按钮使用的默认值；向导会为部署者创建资源并写入自己的绑定。不要为新安装执行 `wrangler d1 migrations apply`。首次初始化由应用内置迁移事务完成。直接在源码目录运行 `npm run deploy` 是真实远程部署命令，须先把配置绑定到自己已有的 D1/R2。

## 首次安装

1. 从公开仓库发起 Cloudflare 部署，使用自己账号创建并绑定 Worker、空 D1、私有 R2 和静态资源。部署时填写至少 32 字符的高熵 `SETUP_SECRET`。
2. 首次访问打开初始化向导。先验证初始化密钥；此步不写入 D1，验证凭证仅保留在当前页面内存，十分钟后失效。
3. 填写首个管理员用户名和至少 8 个字符的密码。最终提交在 D1 事务中建立当前内置 schema，再创建唯一初始管理员；完成后登录。

`SETUP_SECRET` 不会成为日常登录密码。它还用于已知、阻断登录的数据库升级，以及以不同用途的派生密钥加密 AI 模型密钥、可选 Google Client Secret 和用户自愿开启的 Subsonic 密码副本。轮换后需重新录入模型密钥与 Google Secret，并由用户验证当前密码重新开启 Subsonic；密钥不能用于重置管理员账号。Google 配置见[接入指南](google-login.md)。

## 已有实例与升级

管理员在后台「系统状态」查看当前和目标 schema 版本；有可执行的兼容升级时可启动内置迁移。若升级未能在当前管理员请求中完成，或已知旧版需要暂停业务，实例会进入维护页；部署者验证 `SETUP_SECRET` 后分批继续。维护期间不能登录或使用既有管理员会话升级。未知版本、账本不一致或损坏结构保持关闭，需依据备份在应用外处理。

现有实例的数据库和媒体数据不要用全新安装流程覆盖。升级前确认目标 Cloudflare 账号、Worker、D1、R2，并保留可恢复的 D1 备份。若旧共享歌单中有数据，普通管理员升级会停止并提示备份；备份后在维护页用初始化密钥确认可能删除旧共享歌单的迁移。初始化密钥不能修复未知或损坏数据库。

如果自动构建使用独立的私有 Wrangler 配置，升级时还需同步根模板的 `assets.run_worker_first`，否则新增接口可能返回网页。维护者的生产构建使用 `node tooling/deploy/production-ci.mjs`：从加密构建变量 `FLARETUNE_PRODUCTION_CONFIG_B64` 恢复已核对的实例配置，再同步当前仓库的后端路由；保留实例绑定并要求 `keep_vars = true`。该脚本仅允许 Cloudflare 的 `main` 构建、Worker 名称为 `flaretune`；其他部署者应按自己的实例配置调整。标准一键安装使用根模板，无需配置这个维护者脚本。
