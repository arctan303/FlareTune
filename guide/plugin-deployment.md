# 插件来源与部署

本指南介绍插件目录、专用构建通道及安装后的应用和恢复流程。工具需要部署者实际配置后才能连接Cloudflare；官方目录和业务插件包须分别发布，不能仅凭仓库存在或触发链接已保存就视为安装通道可用。

## 在哪里管理

打开设置侧栏的“插件”分组：

- **插件列表**：查看已安装插件；管理员还可发现、安装、更新和卸载，进入各插件提供的设置。
- **来源与部署**：仅管理员可见，管理源目录、构建通道、重建模式、待应用变更和最近构建记录。

成员只能使用站点已安装且向自己角色开放的插件，并管理本人配置。管理员安装作用于整个站点。进入单个插件才切换到它自己的侧栏。

## 添加插件源

官方源由系统预置，但官方仓库存在不代表JSON和插件包已发布；目录尚未发布时会显示未就绪。管理员可在“来源与部署”添加公共HTTPS的第三方JSON目录地址，添加时获取并校验，之后可以刷新或移除第三方源。

目录协议为`schemaVersion: 1`，包含`id`、`name`及`plugins`数组；每个插件条目声明`manifest`和`artifact: { url, sha256 }`。manifest至少声明稳定`id`、三段版本`version`、`hostApiVersion`、`apiVersion`、名称、介绍、图标及`pages`/`entries`数组。源只用于发现和锁定版本：刷新不会自动更新站点，移除源不会连带卸载已运行插件。

官方目录入口为[`FlareTune-Plugins/repository.json`](https://raw.githubusercontent.com/arctan303/FlareTune-Plugins/main/repository.json)。目录地址可以更新；其中每个包的URL固定到一个完整Git提交及内容摘要，构建不会自行改用最新版。官方业务源码、锁定依赖和发布工具由独立的[`FlareTune-Plugins`](https://github.com/arctan303/FlareTune-Plugins)仓库持有。

### 包协议与SDK

当前官方包使用UTF-8 JSON **schema2**，由SDK2宿主识别，`manifest.hostApiVersion`至少为2；manifest须与目录中所选版本完全一致。宿主仍接受schema1及SDK1基本合同，旧包不因此自动获得新增接口。

```json
{
  "schemaVersion": 2,
  "manifest": { "id": "example", "version": "1.0.0", "hostApiVersion": 2 },
  "entries": { "client": "client/index.js", "server": "server/index.js" },
  "files": { "client/index.js": "客户端模块文本", "server/index.js": "服务端模块文本" },
  "exports": { "client/index.js": "client/index.js", "server/index.js": "server/index.js" },
  "assets": {}
}
```

上例仅展示包结构，实际manifest还须包含`apiVersion`、名称、介绍、图标、`pages`/`entries`等完整字段。插件应声明支持语言、默认语言及对应名称/介绍/页面文字，角色使用`admin`/`member`。服务页面与设置页面分别声明；只有设置页面的插件不必增加服务侧栏。

漫游保留宿主原有的`/roam`主导航及分类浏览页面。未安装插件时分类仍可用；安装后由插件的可撤销`browse-header`贡献补入私人电台，`queue-controls`贡献提供队列补充/续播，沿用原外观和主侧栏。旧`/plugins/roam/browse`兼容回到同页；漫游概览仍从插件列表进入。插件的安装/角色/构建门禁只控制这些插件能力，不取消普通分类浏览。

日常服务侧栏只放插件的功能页和相关动作；概览、站点配置保留在后台插件管理。返回按钮按实际来源和页面层级返回，不固定跳插件列表。

贡献式组件的事件、快照和订阅必须绑定到注册它的运行实例与页面会话。卸载或切换账号后，仅从界面移除组件还不够；旧回调必须拒绝，旧快照不可读取新账号状态。避免让留存回调经全局可变控制器转发到下一会话。

`files`保存JS/MJS/JSX/JSON/CSS文本，路径以`client/`、`server/`或`shared/`开头；相对导入只能留在当前执行侧及`shared`，`shared`只能导入`shared`。客户端可导入React、Lucide及宿主精确允许的SDK接口，服务端使用明确的`@flaretune/plugin-sdk/server/...`接口；不能相对读取宿主私有源码。完整白名单见宿主的`shared/plugins/sdkImports.js`，不是任意`@flaretune/plugin-sdk/*`均可用。

`exports`将稳定公开路径映射到包内实际文件，JSX可映射到预打包后的JS。跨插件代码调用须在manifest声明必需或可选依赖，再使用例如`@flaretune/plugin-service/ai-gateway/server/client.js`的公开JS模块；装配器解析实际选中的提供者。CSS/JSON可作为包内文件及公开数据清单保留，当前跨插件service导入只支持JS/MJS/JSX。缺少可选提供者时功能须按声明不可用，不能绕回宿主旧副本。

`assets`只接受`server/*.wasm`，每项为`{ encoding: "base64", data, size, sha256 }`；校验解码后的大小及SHA后交由Worker编译为Wasm模块，不允许客户端二进制或任意文件读取。每个Wasm和schema2单个文本文件最多2MiB，schema1单文本仍限512KiB；文件与资产合计最多256项，整个包下载最多4MiB，单次组合最多32插件/32MiB下载。依赖只在发布端按锁文件预打包并保留许可，安装端不执行包安装脚本或额外npm安装。

schema1保留结构`{ schemaVersion: 1, manifest, entries, files }`及原有导入限制，不支持`exports`/`assets`新增字段。公开插件仓通过`.gitattributes`固定LF，确保Windows与云端干净检出的许可摘要及产物一致。

### 首次构建与缓存恢复

宿主发行快照中的`plugins.seed.lock.json`声明默认编译包的不可变URL、manifest和SHA。显式`npm run plugins:seed`生成首次目录、静态入口和兼容桥，`pluginDeployment`为`null`；编译进程序不等于安装，不会为任何实例自动开启插件，也不会伪造构建任务或改变原安装代次。

日常`build`、`test`和开发入口会先执行`plugins:hydrate`，只校验并恢复忽略的不可变包缓存，保留当前选择、部署描述及D1安装状态；已移除的包不会因此重新加入。样式扫描只读取当前组合中选中的客户端/共享源，缓存中其它插件与服务端vendor不贡献样式。干净专用CI先恢复发行快照缓存，核对宿主与锁后，再按本站已冻结的计划重新装配。发行快照的生成描述、桥及组合锁须提交，`.delivery`和原始下载缓存不进入Git。

安装第三方插件前须核对来源并明确确认信任其代码。插件将作为本站Worker/同源前端代码运行；当前不提供不可信代码沙箱，摘要校验不能代替信任发布者。地址校验失败、目录不可用或包不兼容时不会因此改变当前运行组合。

## 配置构建通道

单独填入触发链接只能启动构建；构建流程还必须读取本站锁定目标、装配插件并报告结果。需要部署者在站点和构建环境两端完成配置。

这是**专用插件构建通道**，须固定与当前运行宿主相同的源码基线和目标绑定。不要把`plugins:prepare`无条件替换现有dev/main常规推送构建：没有活动插件计划时它会拒绝，新宿主源码摘要不符时也应拒绝。日常宿主发布继续沿用现有流程；宿主升级时如何继承远程插件组合尚需单独实现和验收，本轮没有覆盖该升级路径。

1. 将目标Worker连接到Git仓库，确认该构建分支与当前宿主基线相符。在Cloudflare目标Worker的 **Settings → Builds → Deploy Hooks** 创建Hook，选择正确分支并复制URL。[Cloudflare官方步骤](https://developers.cloudflare.com/workers/ci-cd/builds/deploy-hooks/)
2. 在本站“来源与部署”保存该**部署触发链接**，并生成/填写独立的**构建访问密钥**。密钥使用32至256个URL安全字符（字母、数字、`_`、`-`）；复制到构建环境后妥善保管。两个字段只写入密文并脱敏显示，保存不会触发部署；省略字段保留旧值，明确清空才移除。
3. 在专用通道的**构建环境**配置下列变量，而非把值写入Git或前端：

| 构建环境变量 | 值 |
| --- | --- |
| `FLARETUNE_PLUGIN_SITE_URL` | 本站的HTTPS纯origin（不带路径/查询），对应当前目标Worker |
| `FLARETUNE_PLUGIN_BUILD_TOKEN` | 上一步保存到本站的同一构建访问密钥，作为秘密变量保存 |
| `FLARETUNE_PLUGIN_WORKER_NAME` | 本次通道对应的真实目标Worker名 |
| `CLOUDFLARE_ACCOUNT_ID` | 目标Worker所属Cloudflare账号ID |
| `CLOUDFLARE_API_TOKEN` | 可读取/上传/部署该目标Worker的API token，作为秘密变量保存 |
| `FLARETUNE_PLUGIN_WRANGLER_CONFIG` | 可选，默认`wrangler.toml`；须与当前运行宿主/目标绑定一致 |
| `FLARETUNE_PLUGIN_WRANGLER_ENV` | 可选，默认空值使用base配置；环境名须与真实目标相符 |

4. 接入下节的计划读取、装配、校验和报告步骤，并保留原有部署绑定/权限。构建访问密钥只用于该通道的快照读取及状态回传，不能当作管理员登录凭据。
5. 保持默认**手动**模式完成接入检查，再按需要切换自动。手动是工程初始默认；自动模式要求Hook和构建访问密钥均已配置。保存配置、切换模式和刷新源都不会自行开始构建。

Hook URL本身带有触发权限，任何持有者都可触发对应构建，应当像密钥一样保存；不要放进插件源JSON、截图、公开仓库或日志。[Cloudflare凭据说明](https://developers.cloudflare.com/workers/ci-cd/builds/deploy-hooks/)

## 构建端接入顺序

构建脚本读取`GET /api/plugin-build/snapshot`，使用`Authorization: Bearer <构建访问密钥>`；返回的是本站已保存任务的固定计划，而不是任意当前目录最新版。报告使用`POST /api/plugin-build/report`，包含`buildId`、`planDigest`及`status`（`building/deploying/activation_pending/rolling_back/failed/rolled_back/deployed`），使用同一认证方式。此凭据不开放源管理、目标改写或用户配置读取。

流程顺序为：读取固定计划并校验宿主基线 → 校验并装配指定插件包 → 更新组合锁并构建前后端 → 受控部署工具记录原流量、上传未启用版本 → 再次check-plan → 报告deploying → 再核对目标未被其它部署改变后提升流量 → 核对实际新Worker和D1激活结果。`deployed`报告须由实际提供API的新部署核对组合指纹，报告受理或HTTP成功不等于插件已激活。恢复阶段另使用`activation_pending`、`rolling_back`及`rolled_back`状态，不把发布后的失败归为普通构建失败。

构建环境先按项目锁文件安装依赖，再依次运行：

```sh
npm run plugins:prepare
npm run plugins:lock
npm run build
npm run plugins:deploy
```

`prepare`认证读取快照、验证当前宿主/锁文件、下载校验包并生成静态绑定；成功自动报告`building`，失败尽力报告`failed`。`plugins:lock`记录该组合，`build`构建正式前端资源；`plugins:deploy`内部执行目标核对、check-plan、上传、流量提升及状态回传，旧任务已作废时停止，不使用裸`wrangler deploy`代替这个流程。

提升流量前，工具读取新上传版本与所有当前运行版本的实际`resources.bindings`并逐项比较；D1、KV、R2、service、Durable Object、变量及秘密绑定的身份/类型等发生变化都会拒绝。v1插件任务不负责新增或切换云资源；同一Worker名称和合法资源ID不足以证明绑定正确。原部署多版本的绑定不同也会拒绝，不从中任选一版作为基准。绑定内容和其摘要不写入恢复收据或日志。

仅在已隔离的插件通道**构建命令**中，使用`&&`连接以便任一步失败就停止：

```sh
npm run plugins:prepare && npm run plugins:lock && npm run build
```

该专用通道的**部署命令**为：

```sh
npm run plugins:deploy
```

这是会更新目标Worker的真实部署命令；配置指南不自动授权为当前开发/生产实例执行。工具读取锁定版本Wrangler的实际配置，核对name/account/main及D1/KV真实绑定ID；空值或占位绑定不允许通过插件安装自动建资源。不要误用其他环境，也不要改写现有日常dev/main发布命令。

上传/提升流量之前的已确认构建失败，可用`npm run plugins:report -- failed`报告；可接入专用通道的失败处理步骤。进入deploying之后不能凭失败报告假定旧代码仍在，工具须先核实D1是否已经激活：回传丢失可能发生在D1提交之后，此时通过同一任务可重复读取的snapshot/buildStatus和幂等deployed回传确认，不能重跑prepare或盲目回旧代码。无法确认时保留activation_pending冻结，按下节恢复。

宿主版本/源码摘要与计划不符须停止，不能装插件时顺带升级主程序。插件包不执行安装脚本、不安装额外npm依赖；第三方包处理阶段不能获取部署凭据。官方插件业务拆分和产物发布仍分别验收，不因通用装配工具存在就视为已完成。

完成配置后仍需在自己的隔离环境验证完整链路；文档步骤不代表已在某个Cloudflare实例执行成功。

## 安装后何时生效

管理员在插件列表确认安装、更新或卸载时，会显示影响范围、依赖检查及本次应用方式。保存后先出现**待应用变更**，当前运行组合保持不变。

- **手动**：可以连续选择多个插件，最后在“来源与部署”一次“构建并部署”。未配置通道也可保存目标，配置齐全后再执行。
- **自动**：每次明确确认代码组合变更后触发构建。刷新源、第三方发布新版本、修改密钥或个人设置不会自动安装更新。

构建中绑定固定目标，暂时不能编辑或撤销该目标。只有新部署的宿主/插件组合指纹匹配、必要数据更新完成，才显示已安装/已更新并向成员开放；尚未确认的新部署拒绝插件业务，不能宣称始终由旧代码服务。普通插件配置无需重建；旧前端与新Worker构建不一致时按提示刷新，不能绕过兼容校验。

## 失败、重试和撤销

- **源不可用**：检查公共HTTPS地址和目录格式后刷新；既有运行插件继续保留。官方JSON未发布时等待真实发布，反复触发部署不能补出目录。
- **构建被拒绝**：检查Hook/token配置、宿主基线、包摘要及依赖。目标仍待应用，当前运行组合不因此更换。
- **已确认构建失败**：查看安全错误与构建平台记录；修复后重试同一目标，或撤销待应用变更。用户配置和插件数据不会因失败被删除。
- **触发结果未知**：网络超时不证明构建没有启动。界面保留原快照并锁定编辑/撤销，按同一目标恢复或重试；等待真实失败/已部署报告解除锁定。若报告无法到达，先在构建服务确认任务已经停止，再明确确认“解除本地冻结”；该操作使旧任务ID失效，不会远程取消任务，也不证明远端停止。
- **部署后仍未激活**：检查任务ID、计划摘要、实际Worker组合指纹和必要数据更新结果；仅触发成功或仅报告`deployed`不足以通过激活。

已进入发布阶段时使用受控恢复命令`npm run plugins:deploy -- recover`，保留相同工作目录和`tooling/plugins/.delivery-recovery/<buildId>.json`收据。收据不含秘密，但包含真实原版本/流量；CI跨会话恢复须用受保护artifact保留，缺少收据不得猜测旧版本。只有确认D1未激活时才先取得站内rolling_back原子意图锁，阻止并发激活，再核验当前流量仅属本任务的新/旧版本后恢复精确原流量；核对原身份/源码摘要后才报告rolled_back。D1可能已经提交、原部署不明或恢复结果不明时保持冻结，不能盲目回代码；插件数据也不会自动回退。

撤销尚未执行或已确认失败的目标只恢复待应用选择，不卸载当前运行插件。卸载按既有约定保留数据并撤销旧安装代次；回退代码不会自动恢复数据库schema或迁移前数据。

发布前的管理员恢复接口为`POST /api/admin/plugin-delivery/build/resolve`，请求`{ revision, confirmedStopped: true }`。它要求管理员再次确认已在远端核实/停止任务，保留目标选择供修改或重试，并使旧任务的snapshot/report失效；构建流程部署前的check-plan亦须验证任务有效。这是本地任务恢复，不能代替远端停止操作，也不能用于跳过deploying/activation_pending/rolling_back阶段的部署及D1结果核实。
