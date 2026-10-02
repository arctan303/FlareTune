# 参与贡献

[简体中文](CONTRIBUTING.md) · [English](CONTRIBUTING.en.md)

感谢帮助完善 FlareTune。Node.js 入库设备工具已有可用版本，欢迎在更多设备、操作系统与曲库规模下验证，也欢迎一起推进第三方播放器兼容和界面多语言。

## 适合参与的方向

- 在自己的测试实例中验证多首歌曲预检、重复识别、失败重试与恢复；反馈可复现的问题。
- 验证不同操作系统、浏览器和音乐文件格式下的入库体验。
- 帮助验证 Cloudflare R2 直传、分片上传和目标 bucket 核对，或改进相应测试与说明。
- 研究 [Subsonic／OpenSubsonic API](https://opensubsonic.netlify.app/docs/) 的基础接口，并用音流等客户端做互通测试；FlareTune 已提供该兼容接口，支持范围见[第三方客户端指南](guide/subsonic.md)。
- 设计界面与公开文档的多语言方案，帮助整理术语、翻译和校对；歌曲语言分类与界面国际化是两项不同工作。
- 改进播放器、歌词、助手、无障碍和中文使用文档。

Node.js 工具的安装、首次配置和后台操作见[本地入库设备使用指南](tooling/ingest-agent/README.md)（Windows PowerShell 使用 `npm.cmd`）。参与代码开发可阅读[本地开发指南](guide/local-development.md)；验证新功能时建议先使用自己的隔离实例与少量可重建的样本。

## 提交问题和修改

反馈时请说明操作系统、Node.js 版本、浏览器、操作步骤、预期结果与实际结果。只提交复现所需的脱敏日志；不要公开账号密码、会话 Cookie、Cloudflare/R2 密钥、个人音乐文件或他人数据。

`main` 保留已验收、面向使用者部署的版本；`dev` 汇集日常开发和开发 Worker 验证中的改动。功能分支从 `dev` 创建，经测试和 Pull Request 合入 `dev`；准备新版本时，再把通过验收的 `dev` 变更经 Pull Request 合入 `main`。提交前运行与你修改相关的测试与构建。

Git 分支不会自动创建或绑定 Cloudflare D1/R2。开发 Worker 必须使用独立的开发资源与私有 Wrangler 配置；不要把个人资源 ID、初始化密钥或生产绑定提交到仓库。详见[本地开发指南](guide/local-development.md)。开发计划和验收记录保留在维护者的内部工作仓库，不属于公开用户文档。

根目录 `/docs/` 是被 Git 忽略的内部工作资料。请勿强制添加该目录，也不要移除 `.gitignore` 中的排除规则；供使用者阅读的文档请写入 `guide/`。

## 发布版本

1. 在 `dev` 同步 `package.json`、锁文件顶层及根包版本，并在中英 `CHANGELOG` 顶部记录同一版本和日期。完成测试、构建、产物冒烟及对应审查后，确认开发 Worker 自动构建成功。
2. 通过 Pull Request 将 `dev` 合入 `main`；确认生产自动构建成功，并回验健康、协议版本、匿名权限和前端产物。生产数据库升级仍由管理员显式执行，不随发版自动迁移。
3. 在已验收的 `main` 发布提交上创建并推送注释标签 `X.Y.Z`（不加 `v`）。既有标签不可改写。

面向 `main` 的 PR 会先运行只读发布验证。标签推送会触发 [Publish release](.github/workflows/release.yml)：核对标签来自 `main`、版本一致和完整双语日志，运行测试、构建及隔离 Worker 冒烟后，创建正式 GitHub Release。正文来自当版中英日志，沿用 GitHub 自动源码 ZIP/TAR 归档，不上传内部文档、日志、凭据或 `dist`。失败后修复原因再重跑该工作流；重跑保留已有 Release，不改写标签。GitHub Release 与 Cloudflare 分支部署是独立流程。
