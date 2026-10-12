# 部署与初始化

[简体中文](deployment.md) · [English](deployment.en.md)

## 免费额度与费用

FlareTune 的核心只需 Workers、D1 和私有 R2，无需 VPS。以下为 2026-10-12 核对的 Cloudflare 公开额度，按账号汇总，其他应用也会占用：

| 服务 | 免费范围与边界 |
| --- | --- |
| [R2 Standard](https://developers.cloudflare.com/r2/pricing/) | 每月 10 GB-month、100 万 Class A、1000 万 Class B 操作；直接 R2 出网不收流量费。存储按月内每天峰值的平均计算，封面和歌词等也占空间；超额操作/存储收费，Infrequent Access 不适用这些免费额度 |
| [Workers Free](https://developers.cloudflare.com/workers/platform/pricing/) | 动态请求每天 10 万次、每次 10 ms CPU 限制；大批入库等任务仍可能触及限制 |
| [D1 Free](https://developers.cloudflare.com/d1/platform/pricing/) | 每天读取 500 万行、写入 10 万行，账号合计 5 GB 存储；单库另有限制 |
| [Static Assets](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) | 静态资源请求免费；私有音乐需要认证并经过正常实例 Worker，不能把所有播放算成免费静态请求 |

这里的“免费起步”是条件性的。R2 需先开通订阅并完成平台结算流程，实际账号可能需要补充支付资料；免费额度不是预算上限。监控用量并设置可用的告警，升级付费套餐前核对计价。AI 模型、可选域名及其他外部服务可能单独收费。

公开模板及隔离本地初始化/权限流程已验证；全新 Cloudflare 账号从部署按钮到建库的完整向导仍需按实际账号提示核验，不将开发账号部署当作新账号实测。

## 部署方式

公开模板在仓库根目录的 `wrangler.toml` 声明 Worker、静态资源、D1 和 R2；Cloudflare 的部署向导会创建并绑定资源，并依据 `.dev.vars.example` 提示填写 `SETUP_SECRET`。

[一键部署到 Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/arctan303/FlareTune)。根 `wrangler.toml` 中的 D1/R2 名称和空数据库 ID 是部署按钮使用的默认值；向导会为部署者创建资源并写入自己的绑定。不要为新安装执行 `wrangler d1 migrations apply`。首次初始化由应用内置迁移事务完成。直接在源码目录运行 `npm run deploy` 是真实远程部署命令，须先把配置绑定到自己已有的 D1/R2。

## 首次安装

1. 从公开仓库发起 Cloudflare 部署，使用自己账号创建并绑定 Worker、空 D1、私有 R2 和静态资源。部署时填写至少 32 字符的高熵 `SETUP_SECRET`。
2. 首次访问打开初始化向导。先验证初始化密钥；此步不写入 D1，验证凭证仅保留在当前页面内存，十分钟后失效。
3. 填写首个管理员用户名和至少 8 个字符的密码。最终提交在 D1 事务中建立当前内置 schema，再创建唯一初始管理员；完成后登录。

`SETUP_SECRET` 不会成为日常登录密码。它还用于已知、阻断登录的数据库升级，以及以不同用途的派生密钥加密 AI 模型密钥、可选 Google Client Secret 和用户自愿开启的 Subsonic 密码副本。轮换后需重新录入模型密钥与 Google Secret，并由用户验证当前密码重新开启 Subsonic；密钥不能用于重置管理员账号。Google 配置见[接入指南](google-login.md)。

## 已有实例与升级

管理员在后台「实例设置」的运行概况查看基础结构版本及逐项功能迁移；有待更新项时可启动内置兼容升级。若升级未能在当前管理员请求中完成，或已知旧版需要暂停业务，实例会进入维护页；部署者验证 `SETUP_SECRET` 后分批继续。维护期间不能登录或使用既有管理员会话升级。未知版本、账本不一致或损坏结构保持关闭，需依据备份在应用外处理。

现有实例的数据库和媒体数据不要用全新安装流程覆盖。升级前确认目标 Cloudflare 账号、Worker、D1、R2，并保留可恢复的 D1 备份。若旧共享歌单中有数据，普通管理员升级会停止并提示备份；备份后在维护页用初始化密钥确认可能删除旧共享歌单的迁移。初始化密钥不能修复未知或损坏数据库。

## 备份与恢复

1. 保存当前代码版本、资源绑定及 `SETUP_SECRET`，停止入库、编辑和客户端写入，取得同一时间窗口的数据库与媒体副本。
2. 按 [D1 导入/导出](https://developers.cloudflare.com/d1/best-practices/import-export-data/)导出完整 SQL，例如 `npx wrangler d1 export YOUR_DATABASE --remote --output=backup.sql`。核对账号与数据库名称，备份文件包含私人账号和配置，不放进公开仓库。
3. 通过 [R2 S3 兼容接口](https://developers.cloudflare.com/r2/api/s3/api/)复制桶内对象，保留原对象键、内容和类型，包括音频、歌词、封面及 `users/` 私人图片。只有 D1 副本不能恢复音频。
4. 先在独立空 D1/私有 R2 演练：将 SQL 导入新库，恢复对象，以同一代码版本和原密钥部署到这些新绑定。恢复已有数据库后直接登录，勿重新初始化；核对收藏、歌单、播放、歌词和私人图片后，再安排实际切换。

这是恢复步骤说明，本项目不提供一键整库备份或跨 D1/R2 原子快照；当前未完成部署者全新账号的云端恢复演练。
