# 部署与初始化

[简体中文](deployment.md) · [English](deployment.en.md)

先在[在线 Demo](https://flaretune.arcinks.com)体验播放器和完整设置，再部署自己的私人曲库。Demo 使用公开授权音乐；自己的实例需要导入音频，数据与[Demo](demo.md)分别保存。

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

`SETUP_SECRET` 不会成为日常登录密码。它还用于已知、阻断登录的数据库升级，以及以不同用途的派生密钥加密 AI 模型密钥、可选 Google Client Secret、用户自愿开启的 Subsonic 密码副本及开发版可选小米授权。轮换后需重新录入模型密钥与 Google Secret、重新连接小米账号，并由用户验证当前密码重新开启 Subsonic；密钥不能用于重置管理员账号。Google 配置见[接入指南](google-login.md)。

## 已有实例与升级

应用版本升级使用下方「系统更新」；运行概况中的基础结构版本和逐项功能迁移属于当前 Worker 的数据库维护，两者不是同一个操作。仅手动执行旧维护流程时，若升级未能在当前管理员请求中完成，或已知旧版需要暂停业务，部署者在维护页验证 `SETUP_SECRET` 后分批继续。后台系统更新自己的维护窗口自动等待并核实，不要求再次输入初始化密钥。未知版本、账本不一致或损坏结构保持关闭，需依据备份在应用外处理。

现有实例的数据库和媒体数据不要用全新安装流程覆盖。升级前确认目标 Cloudflare 账号、Worker、D1、R2，并保留可恢复的 D1 备份。若旧共享歌单中有数据，普通管理员升级会停止并提示备份；备份后在维护页用初始化密钥确认可能删除旧共享歌单的迁移。初始化密钥不能修复未知或损坏数据库。

## 后台系统更新

此入口要求当前运行版本已包含系统更新协议及可信运行元数据。原版1.2.1没有该入口；部署者须先按实际旧版兼容情况部署一次过渡版本，保留原 Worker、绑定、数据库、媒体及密钥，再使用后台升级。全新安装和过渡部署不是同一流程，也不能把某个测试站的迁移结果当作所有旧站的保全保证。

### 首次配置更新通道

当前没有自动创建仓库或代填 Cloudflare 凭据的应用内向导。首次需要在自己的账号完成以下人工设置；可以使用部署时一次创建的仓库，或一次复制可信的官方引导代码。引导版本须支持稳定Release中的 `flaretune-update.json` 和 `flaretune-source.tar.gz` 两项固定资产；仅支持旧codeload地址的引导入口须先换为兼容版本。日常升级由该入口下载经过校验的官方版本，无需每次复刻或手工同步仓库。

1. 在目标 Worker 的 [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/) 连接引导仓库，固定一个分支（默认 `main`）。**Build command 留空，Deploy command 填 `npm run updates:build`**。此命令已包含下载、构建、上传、核验、切流和状态回传；不能再接默认 `wrangler deploy` 或另一路直接部署。保留仓库锁文件及安装依赖步骤，关闭未授权分支的部署。
2. 为同一分支创建 [Deploy Hook](https://developers.cloudflare.com/workers/ci-cd/builds/deploy-hooks/)。在后台「实例设置 → 系统更新 → 配置更新通道」填写该地址，生成构建访问密钥并复制到 Builds 的秘密变量中。后台只显示是否已配置，编辑留空保留原值；保存通道不会开始升级。
3. 按下表填写构建环境，核对账号、Worker 名及 Worker 实际元数据 `tag`。Cloudflare 部署凭据只授予目标账号所需的 Workers 部署及绑定资源权限；不要使用全局 API Key。必须确认自定义 runner 能读取 `CLOUDFLARE_API_TOKEN`，不能仅凭平台选中了某个部署 token 就假定它已经作为环境变量提供。

| 构建变量 | 值与用途 |
| --- | --- |
| `FLARETUNE_SYSTEM_UPDATE_SITE_URL` | 本站公开 HTTPS origin，不带路径或查询 |
| `FLARETUNE_SYSTEM_UPDATE_BUILD_TOKEN` | 与后台保存的同一构建密钥，32～256位字母、数字、`_`或`-`；存为秘密 |
| `FLARETUNE_SYSTEM_UPDATE_WORKER_NAME` | 真实应用 Worker 名，不是另一个测试或控制 Worker |
| `FLARETUNE_SYSTEM_UPDATE_WORKER_TAG` | 目标 Worker 实际元数据的32位十六进制 `tag`，不是版本ID |
| `CLOUDFLARE_ACCOUNT_ID` | 目标 Cloudflare 账号ID |
| `CLOUDFLARE_API_TOKEN` | runner可读的受限 Cloudflare 部署凭据；存为秘密，与站内构建密钥不同 |
| `FLARETUNE_SYSTEM_UPDATE_BUILD_BRANCH` | 固定引导分支，省略时为 `main`；须与 Builds 和 Hook 一致 |
| `FLARETUNE_SYSTEM_UPDATE_CHANNEL` | 可省略，默认 `stable`；仅受信服务器明确配置候选时才使用匹配的 `candidate` |

Builds 提供的 `WORKERS_CI=1` 和 `WORKERS_CI_BRANCH` 用于核对执行环境，不应伪造；平台附带的 Worker 名／tag约束也必须与应用一致。普通部署使用默认稳定通道，不设置候选覆盖。构建密钥仅授权冻结任务的计划读取、租约、状态和内置兼容迁移，不授予管理员登录、任意 SQL 或读取私人配置的权限。后台密钥依赖 `SETUP_SECRET` 加密，轮换前应准备重新配置通道。

### 日常检查与升级

1. 管理员打开「实例设置 → 系统更新」，点击「检查更新」。检查读取官方稳定Release的 `flaretune-update.json`，并确认同一Release包含固定源码资产 `flaretune-source.tar.gz`，不会部署。只有已正式发布、非预发布且两项资产齐全、清单有效的版本才进入稳定通道；缺失资产或暂时不可访问时会报错，不能据此判断已经更新。
2. 核对当前版本、目标版本及说明，再点击「升级系统 → 确认升级」。受信服务器配置的待发布候选会单独标识，不等于正式稳定版。待应用插件变更、其他活动构建、版本不兼容或运行元数据缺失时，先按提示处理，再重新检查。
3. 页面显示真实构建、发布和迁移阶段。刷新或关闭网页不取消任务，重新进入仍继续读取同一任务。系统升级冻结已安装插件的精确版本、来源、包摘要及安装代次，保留原配置和数据，不顺带更新插件；插件新增、升级或卸载仍在[来源与部署](plugin-deployment.md)单独确认。
4. 进入迁移维护窗口后，音乐、媒体和普通业务暂时不可用，页面持续核实并在完成后恢复。正常管理员仍可查看系统更新面板；会话过期时可从等待页使用本地管理员账号登录，成员仅等待或退出切换账号。已确认失败时使用「重试本次更新」；结果待确认，或后台确认任务已停滞可续接时，使用「继续核实更新」，保持原任务与目标，不重新创建升级或假定旧代码仍在服务。完成后重新加载网页。缺失凭据、目标身份或绑定变化等问题需先修正云端配置。

维护页管理入口要求底层数据库仍可通过原有正常认证；未知结构或实际未完成的基础迁移不会因此放开登录，仍须等待已配置构建继续或联系部署者维护，不能保证任意半迁移都可在网页恢复。

稳定构建使用清单指定的官方Release源码资产，不使用GitHub自动生成的“Source code (zip/tar.gz)”作为长期固定字节输入；[GitHub说明](https://docs.github.com/en/repositories/working-with-files/using-files/downloading-source-code-archives#stability-of-source-code-archives)指出自动归档的压缩字节可能变化。下载后仍严格核对清单SHA256、完整提交及宿主摘要；失败即停止，不以重新计算或改写SHA放行。受信候选通道临时使用固定完整提交的codeload归档，也遵守同样校验，不能代替稳定Release的两项资产。

系统更新只执行目标版本内置的兼容迁移，不自动授权破坏性旧数据清理。切流及数据库结果不确定时保持冻结；受控代码恢复只在尚未进入数据库迁移的安全边界内可用，后台不提供任意降级按钮。**代码恢复不会自动回退数据库、插件配置或媒体；升级前仍需下方备份与恢复准备。**

## 备份与恢复

1. 保存当前代码版本、资源绑定及 `SETUP_SECRET`，停止入库、编辑和客户端写入，取得同一时间窗口的数据库与媒体副本。
2. 按 [D1 导入/导出](https://developers.cloudflare.com/d1/best-practices/import-export-data/)导出完整 SQL，例如 `npx wrangler d1 export YOUR_DATABASE --remote --output=backup.sql`。核对账号与数据库名称，备份文件包含私人账号和配置，不放进公开仓库。
3. 通过 [R2 S3 兼容接口](https://developers.cloudflare.com/r2/api/s3/api/)复制桶内对象，保留原对象键、内容和类型，包括音频、歌词、封面及 `users/` 私人图片。只有 D1 副本不能恢复音频。
4. 先在独立空 D1/私有 R2 演练：将 SQL 导入新库，恢复对象，以同一代码版本和原密钥部署到这些新绑定。恢复已有数据库后直接登录，勿重新初始化；核对收藏、歌单、播放、歌词和私人图片后，再安排实际切换。

这是恢复步骤说明，本项目不提供一键整库备份或跨 D1/R2 原子快照；当前未完成部署者全新账号的云端恢复演练。
