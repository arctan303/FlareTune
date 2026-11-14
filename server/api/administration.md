# 实例、管理员、曲库与入库设备 API

源码盘点基线：`3d0076d8431e8cb9501c5029d1af55bddb40ac9a`（2026-11-12），第2.1节及维护原因补充为2026-11-14系统更新实现合同。这不代表任一目标实例已部署或通过线上验收。入口为 [Worker](../src/flaretune.js) → [HTTP router](../src/instance/httpRouter.js)。公共认证规则见 [API 索引](../API.md)；插件框架另见 [plugin-management.md](plugin-management.md)。本页不包含 Google 管理、个人图片和插件私有业务。

## 1. 公共请求与返回规则

除表中明确公开的状态、初始化及维护证明接口外，本页接口需要实例 `ready`、正常本地 Cookie 会话；`/api/admin/**` 仅管理员可用。`must_change_password` 会话不能管理曲库、设备或账号。管理员身份不赋予读取他人私人业务数据的一般权限。

非 GET 请求发送：

```http
Origin: https://music.example.com
X-Requested-With: FlareTune
X-CSRF-Token: <当前会话 csrfToken>
X-FlareTune-Expected-Account: <当前 accountId>
Content-Type: application/json
Cookie: __Host-ft_session=<会话值>
```

`Origin` 必须匹配实例来源或既有允许来源；初始化/维护证明等无会话路径不要求 CSRF token，但仍要求 Origin 与 X-Requested-With。Expected-Account 为可选的身份意图校验，客户端应发送；不匹配时返回 HTTP409 `{"error":"account_changed"}`。

外层可能先返回 `401 authentication_required`、`403 forbidden/csrf_rejected`、`503 {error:实例状态}`。外层错误为 `{error:string}`，不一定使用下述业务外壳。未知业务路径当前可能落入 HTTP503 `phase_not_ready`，不能据此推断接口存在。

返回外壳必须按接口族处理：

| 接口族 | 成功 | 业务错误 |
| --- | --- | --- |
| 账号、设置、迁移 | 直接 DTO | `{error:string}` |
| 单曲 CRUD、上传 | `{ok:true,data:...}` | `{ok:false,error:string,message:string,data?:object}` |
| 批量删除 | `{code:number,data:...}` | `{code:number,message:string,data?:object,details?:object}` |
| 入库设备 | `{ok:true,data:...}` | `{ok:false,message:string}` |

默认 JSON parser 要求对象、`application/json`、最多8192字节；单曲 CRUD 和批删单独限制64KiB，设备普通请求64KiB、manifest 2MiB。批删JSON边界按本轮源码完善后的实现记录，不沿用基线中的无界读取。所有时间戳除明确说明外为 Unix 毫秒。

## 2. 实例状态、初始化和迁移

实现：[httpRouter.js](../src/instance/httpRouter.js)、[accessPolicy.js](../src/instance/accessPolicy.js)、[setupProof.js](../src/instance/setupProof.js)、[upgradeDatabase.js](../src/instance/upgradeDatabase.js)、[migrationStatus.js](../src/instance/migrationStatus.js)。

| METHOD + path | 可用条件 | 请求 | 成功响应 |
| --- | --- | --- | --- |
| `GET /api/instance/status` | 无需登录 | 无 | `{state,schemaVersion,targetVersion}` |
| `GET /api/health` | 无需登录 | 无 | `{ok:boolean,state}`；recovery_required 为 HTTP503，其余200 |
| `POST /api/auth/verify-setup` | 仅 setup_required | `{setupSecret:string}` | `{proof:string,expiresInSeconds:600}` |
| `POST /api/auth/setup` | 仅 setup_required | `{proof:string,username:string,password:string}` | HTTP201 `{ok:true}` |
| `POST /api/instance/verify-maintenance` | 仅 maintenance | `{setupSecret:string}` | `{proof:string,expiresInSeconds:600}` |
| `POST /api/instance/upgrade` | 仅 maintenance | `{proof:string,backupConfirmed?:boolean}` | `MigrationResult` |
| `GET /api/admin/system/migration` | ready + 正常管理员 | 无 | `MigrationStatus` |
| `POST /api/admin/system/migration` | ready + 正常管理员 | JSON对象，通常 `{}` | `MigrationResult` |

`state` 当前状态机包括 `setup_required`、`ready`、`maintenance`、`recovery_required`；客户端按返回值处理，不能只看 HTTP200。当前 `targetVersion=2`。`schemaVersion` 未识别时可能为 null。

系统更新迁移窗口由实际持久任务决定，status/health保留真实schema信息并附加 `state:"maintenance",reason:"system_update_running"`；`recovery_required`优先，不伪造为正常维护。此窗口普通业务API、媒体及`/rest`返回HTTP503；静态页面、专用系统更新构建协议，以及精确的`GET /api/auth/session`、`POST /api/auth/login`、`POST /api/auth/logout`继续经原路由处理。认证仍使用实际数据库状态、会话、CSRF和限流；未知结构或基础maintenance不因reason放开认证。正常管理员可在等待页查看更新面板并续接可恢复任务，匿名可显式本地登录，成员/需改密会话仅等待或退出；不加载业务App、Google登录或索取`SETUP_SECRET`/`backupConfirmed`。普通旧数据库维护流程仍按下文执行。

```ts
type MigrationStatus = {
  schemaVersion: number | null;
  targetVersion: number;
  state: string;
  supplementalPending: boolean;
  supplementalMigrations: { id: string; ready: boolean }[];
};
type MigrationResult = {
  status: "current" | "in_progress" | "completed" | "already_completed" | "lease_busy";
  schemaVersion: number | null;
  phase?: string;
  processed?: number;
  cursor?: string | null;
};
```

补充迁移 ID 为 `ai_protocols`、`user_images`、`ai_feature_models`、`google_login`、`hotpath_counts`、`external_music`。`supplementalPending` 不等同于 schemaVersion 落后。

初始化先验证部署秘密获得绑定来源、purpose=setup、有效10分钟的 proof，再执行当前 Worker 内置迁移并认领第一个管理员；成功后仍需登录。无任意SQL、任意版本或任意迁移文件参数。用户名、密码限制同第3节。

维护证明绑定 purpose=maintenance，不与 setup proof 互换。验证按 isolate 局部IP计数，15分钟内已知IP至多5次，unknown至多3次；429 `{error:"rate_limited"}` 带 Retry-After。秘密无效403 `invalid_setup`。

管理员 POST 迁移最多连续推进20个 `in_progress` 步骤；它不从 body 接收 backupConfirmed。普通数据库升级进入维护状态后，管理员会话路径不能继续，需维护证明路径；第2.1节系统更新的受限迁移通道不使用该证明流程。`backupConfirmed===true` 只在维护 upgrade 中允许既定破坏性清理，不代表服务器替用户完成了备份。

迁移结果可能为 lease_busy，不能认作完成；失败可能返回409 `backup_required/invalid_state`，或503 `migration_schema_inconsistent/migration_expand_failed/migration_supplemental_failed/migration_step_failed/service_unavailable`。迁移使用内置账本与互斥租约，不应并发启动多组迁移。

示例（仅演示请求，不应把 SETUP_SECRET 放进移动客户端配置）：

```http
POST /api/instance/verify-maintenance
Content-Type: application/json
Origin: https://music.example.com
X-Requested-With: FlareTune

{"setupSecret":"<管理员本次输入的部署秘密>"}
```

```http
POST /api/instance/upgrade
Content-Type: application/json
Origin: https://music.example.com
X-Requested-With: FlareTune

{"proof":"<上一步返回的 proof>","backupConfirmed":true}
```

`/api/auth/recovery` 明确404，不是已实现恢复入口。测试：[flaretune.test.js](../src/flaretune.test.js)、[upgradeDatabase.test.js](../src/instance/upgradeDatabase.test.js)、[migrationControl.test.js](../src/instance/migrationControl.test.js)、[migrationStatus.test.js](../src/instance/migrationStatus.test.js)。

### 2.1 后台系统更新

实现：[管理/构建路由](../src/routes/systemUpdate.js)、[任务服务](../src/systemUpdate/service.js)、[可信版本发现](../src/systemUpdate/releases.js)、[维护门](../src/systemUpdate/gate.js)。首次云端设置及日常操作见[部署指南](../../guide/deployment.md#后台系统更新)；构建端入口为 `npm run updates:build`，不是普通插件选择构建。

管理接口要求实例基础状态为ready、正常管理员会话；写请求使用本页第1节的Origin、请求标记、CSRF与Expected-Account。成员及匿名不能调用。请求仅接受下表字段，不接受任意仓库、下载地址、命令、SQL、插件名单或目标资源绑定。成功返回同一 `SystemUpdateStatus`，错误为 `{error:string}`。

| METHOD + path | JSON请求 | 行为 |
| --- | --- | --- |
| `GET /api/admin/system-update` | 无 | 读取配置标记、当前/最新版本及最近持久任务 |
| `PUT /api/admin/system-update` | `{revision,deployHookUrl?,buildToken?}` | 只保存通道，不触发构建 |
| `POST /api/admin/system-update/check` | `{revision}` | 获取并校验可信版本，不部署 |
| `POST /api/admin/system-update/start` | `{revision,releaseId}` | 核对本次检查结果及插件基线，冻结任务，再触发Hook |
| `POST /api/admin/system-update/retry` | `{revision,taskId}` | failed/activation_pending或后端确认租约已过期的活动任务；重触同一任务，不更换目标 |
| `POST /api/admin/system-update/recover` | `{revision,taskId}` | 受控运维恢复；仅已有上传版本且未开始数据库迁移的特定状态可用，先记录rolling_back意图；普通后台不提供任意降级入口 |

`revision`从最新响应取得；CAS冲突回读后再确认，不能盲目递增。Hook只接受 `https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/<id>`；构建密钥为32～256位字母、数字、`_`、`-`。凭据加密保存、GET不返回原文；PUT省略字段保留，显式空字符串删除，网页编辑留空时发送省略。活动任务期间不能改通道或开启另一目标。

```ts
type SystemUpdateStatus = {
  revision: number;
  configured: boolean;
  configuration: { hookConfigured: boolean; tokenConfigured: boolean };
  channel: "stable" | "candidate";
  current: null | {
    version: string; sourceDigest: string; commit?: string; hostApiVersion: number;
    plugins: { id: string; version: string; manifest: object; source: object;
      installation: { epoch: string; revision: number } }[];
  };
  latest: null | SystemRelease;
  checkedAt: number | null;
  job: null | {
    taskId: string; planDigest: string; status: string;
    from: object; target: SystemRelease; plugins: object[];
    receipt: object | null; createdAt: number; updatedAt: number;
    error: string | null; providerBuildId?: string; resumable: boolean;
  };
  blockingReason: string | null;
};
type SystemRelease = {
  schemaVersion: 1; id: string; version: string; commit: string;
  host: { version: string; sourceDigest: string }; hostApiVersion: number;
  minVersion: string; notes: { zh: string; en: string };
  source: { url: string; sha256: string };
  migration: { compatible: true }; channel: "stable" | "candidate";
};
```

稳定来源固定为官方 `arctan303/FlareTune` 的最新正式、非预发布Release及其中唯一的 `flaretune-update.json`；版本为三段数字且须更高。清单ID为`version:commit`，源码URL固定到同仓库完整提交，下载后校验SHA256及宿主摘要。受信服务器端 `FLARETUNE_UPDATE_CANDIDATE_JSON` 可提供明确标识的candidate；构建端通道须匹配，允许同版本不同摘要。客户端不能切换到任意来源或把候选当作正式发布。

任务状态为 `queued/building/uploaded/deploying/migrating/deployed/activation_pending/rolling_back/rolled_back/failed`。它们是实际阶段而非百分比；触发响应丢失可进入activation_pending，不能推断构建未启动或原代码仍服务。重试保留taskId、planDigest、目标及持久receipt；确认前不能以另一版本覆盖未知任务。receipt记录实际Worker/原流量/新版本/绑定摘要及迁移边界，不含秘密。代码恢复不会回退D1、配置或媒体；migrationStarted后拒绝恢复旧代码。

`job.resumable`由后端判断：包括可安全重试的失败、activation_pending，以及执行租约过期或尚未claim且三分钟无活动的任务。活动但可续接时，后台也可通过同一`/retry`继续核实；客户端不能仅靠本地计时宣称任务已停滞或开放新目标。维护恢复仅适用于原认证仍可用的数据库状态，不承诺任意未知或半迁移结构都能网页恢复。

冻结组合只包括实际已安装插件的精确版本、来源、包摘要及安装epoch/revision，不采用发行seed或目录最新包，不导出私人配置，不借卸载重装更新安装代次。待应用插件变更、其他活动插件构建、插件API不兼容或运行元数据缺失会阻止新系统任务。

专用构建通道使用 `Authorization: Bearer <FLARETUNE_SYSTEM_UPDATE_BUILD_TOKEN>`，不使用管理员Cookie、CSRF或初始化密钥；仅基础状态ready/maintenance可达，仍逐次验证该构建能力和冻结任务。

| METHOD + path | 请求与响应摘要 |
| --- | --- |
| `GET /api/system-update/plan` | 返回schemaVersion、revision、冻结任务及receipt；无任务404 `SYSTEM_UPDATE_JOB_UNAVAILABLE` |
| `POST /api/system-update/claim` | `{taskId,planDigest,runnerId}` → `{taskId,planDigest,runnerId,leaseExpiresAt,revision}`；180秒租约，过期接管会隔离旧runner |
| `POST /api/system-update/report` | `{taskId,planDigest,runnerId,status,receipt?,error?}` → `{ok,taskId,status,revision}`；核验租约、状态转换、实际宿主及安装组合，不凭报告宣称成功 |
| `POST /api/system-update/migration` | `{taskId,planDigest,runnerId}` → `{taskId,status,migrationCompleted,...}`；仅本任务实际目标部署的内置兼容迁移，禁止任意/破坏性SQL |

构建runner校验固定Cloudflare账号、Worker名、实际Worker tag和Builds分支，完整保留原绑定；租约、目标、绑定或外部部署改变时停止，不越过校验。构建输入与秘密的具体变量见[首次配置](../../guide/deployment.md#首次配置更新通道)，机器协议验证见[protocol.mjs](../../tooling/updates/protocol.mjs)、[deploy.mjs](../../tooling/updates/deploy.mjs)。

常见阻断为 `SYSTEM_UPDATE_IN_PROGRESS/PLUGIN_PENDING/PLUGIN_BUILD_BUSY/PLUGIN_INCOMPATIBLE/RUNTIME_UNAVAILABLE`（每项均有 `SYSTEM_UPDATE_` 前缀）。写冲突/目标变更使用 `SYSTEM_UPDATE_REVISION_MISMATCH/TARGET_CHANGED/JOB_CHANGED`；另有 `SYSTEM_UPDATE_NOT_CONFIGURED/RELEASE_UNAVAILABLE/RELEASE_INVALID/VERSION_UNSUPPORTED/ALREADY_CURRENT/RETRY_UNAVAILABLE/RESULT_UNKNOWN/RECOVERY_UNAVAILABLE`。客户端显示安全、可操作文案，不直接展示不受信的上游错误；网络错误后先读取实际任务再决定重试。

## 3. 管理员账户

实现：[accounts.js](../src/instanceAdmin/accounts.js)、[common.js](../src/instanceAdmin/common.js)、[实际凭据校验](../src/auth/local/crypto.js)。

```ts
type Account = {
  accountId: string;
  username: string;
  displayName: string;
  role: "admin" | "member";
  status: "active" | "disabled";
  createdAt: number;
  updatedAt: number;
};
```

| METHOD + path | 请求字段 | 成功响应 |
| --- | --- | --- |
| `GET /api/admin/accounts` | 无 | `{accounts:Account[]}`，按createdAt、accountId排序，无分页 |
| `POST /api/admin/accounts` | 必需 username、temporaryPassword；可选 displayName、role | HTTP201 `{account:Account}` |
| `PATCH /api/admin/accounts/{accountId}` | 必需 expectedUpdatedAt；可选 role、status、displayName | `{account:Account}` |
| `POST /api/admin/accounts/{accountId}/reset-password` | 必需 temporaryPassword | `{ok:true,accountId:string,mustChangePassword:true}` |

字段约束：

| 字段 | 类型与当前限制 |
| --- | --- |
| accountId 路径参数 | `[A-Za-z0-9_-]{1,128}` |
| username | string，转小写后匹配 `[a-z0-9_.-]{3,64}`；不自动trim；创建后不可通过此PATCH改变 |
| temporaryPassword | string，至少8个Unicode码点，UTF-8编码至多1024字节 |
| displayName | string，JS length≤80；允许空字符串，不自动trim；创建省略时使用规范化username |
| role | admin/member；创建省略默认member；PATCH省略/null保留当前角色 |
| status | active/disabled；创建固定active；PATCH省略/null保留当前状态 |
| expectedUpdatedAt | 正安全整数；必须等于当前账户updatedAt；PATCH必需 |

PATCH未提供的displayName保留原值，提供null不合法。服务只取表列字段，不应依赖未知字段被拒绝。实际 username 校验不是 `common.validUsername` 中未被此创建流程调用的“必须字母开头”规则。

副作用：创建、更新、重置写审计；新建及重置均设置 must_change_password。禁用或角色改变撤销目标现有会话；改显示名不因此撤销。不能禁用或降级最后一个具备可用凭据的active管理员。重置撤销目标全部会话，并关闭其Subsonic兼容访问；响应不返回密码材料。账号不支持DELETE。

```http
POST /api/admin/accounts
<第1节认证及JSON请求头>

{"username":"listener","displayName":"Listener","role":"member","temporaryPassword":"<临时密码>"}
```

```json
{"account":{"accountId":"<新UUID>","username":"listener","displayName":"Listener","role":"member","status":"active","createdAt":1700000000000,"updatedAt":1700000000000}}
```

```http
PATCH /api/admin/accounts/<accountId>
<第1节认证及JSON请求头>

{"expectedUpdatedAt":1700000000000,"status":"disabled"}
```

错误：400 `invalid_input/username/password/display_name/role/status`；404 `account_not_found`；409 `username_taken/revision_conflict/last_admin_required`；503 `storage_unavailable`；角色撤销等403 `forbidden`。冲突应重新读取，不把旧时间戳递增后盲试。

测试：[instanceAdmin.test.js](../src/instanceAdmin/instanceAdmin.test.js)、[Worker接线测试](../src/flaretune.test.js)。

## 4. 核心设置

实现：[settings.js](../src/instanceAdmin/settings.js)。

### GET /api/admin/settings

实际响应仅包含：

```json
{"settings":{"instance.name":{"value":"FlareTune","revision":0},"cors.allowed_origins":{"value":[],"revision":0}}}
```

0表示尚无保存记录，value为默认值。路由不返回内部函数的defaults/secrets，也不返回插件配置。

### PUT /api/admin/settings

```ts
type UpdateSetting = {
  key: "instance.name" | "cors.allowed_origins";
  value: string | string[];
  expectedRevision: number; // 非负安全整数，0表示首次创建
};
// 返回 {key,value,revision:expectedRevision+1}
```

| key | value约束 |
| --- | --- |
| instance.name | string，输入JS length≤80，trim后非空；保存trim后值 |
| cors.allowed_origins | 唯一string[]，最多32项；每项≤2048字符、严格HTTPS origin，无凭据、query、fragment或额外path；如 `https://client.example.com`，不能以 `/` 结尾 |

CAS成功后revision递增并写审计。错误：400 `invalid_revision/unknown_setting/invalid_setting`，409 `revision_conflict`，503 `setting_corrupt/storage_unavailable`。旧插件设置键在前置插件路由中另行分发，不能据此宣称核心设置可任意存储键值。

```http
PUT /api/admin/settings
<第1节认证及JSON请求头>

{"key":"instance.name","value":"My Music","expectedRevision":0}
```

```json
{"key":"instance.name","value":"My Music","revision":1}
```

测试：[settingsStore.test.js](../src/instanceAdmin/settingsStore.test.js)、[instanceAdmin.test.js](../src/instanceAdmin/instanceAdmin.test.js)。

## 5. 共享曲库管理

实现：[localCatalogAdmin.js](../src/routes/localCatalogAdmin.js)。全部管理员限定。列表包括未分类或暂无可播放媒体的管理记录，不能直接视作消费端可播放列表。

### 5.1 单曲 CRUD

```ts
type CatalogSong = {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  duration: number | null; // 秒
  audio_url: string | null;
  cover_url: string | null;
  language: string | null;
  created_at: number | null;
  version: string; // 当前九个存储字段的64位lowercase SHA-256
};
```

| METHOD + path | 请求 | 成功data |
| --- | --- | --- |
| `GET /api/admin/catalog/songs` | page?、limit?、q? | `{total:number,page:number,limit:number,songs:CatalogSong[]}` |
| `POST /api/admin/catalog/songs` | 必需id、title、audio_url；其余可写字段可选 | HTTP201 `{song:CatalogSong}` |
| `GET /api/admin/catalog/songs/{id}` | ID | `{song:CatalogSong}` |
| `PUT /api/admin/catalog/songs/{id}` | expectedVersion和要修改的字段 | `{song:CatalogSong}` |
| `DELETE /api/admin/catalog/songs/{id}` | `{expectedVersion,confirmDelete:true}` | `{deletedSongId:string,mediaRetained:true}` |

GET参数：page默认1，1..100000；limit默认50，1..100；q trim后≤120 Unicode码点，匹配title/artist/album，LIKE通配符被转义。顺序为COALESCE(created_at,0)降序、id升序。

写入只使用 id/title/artist/album/duration/audio_url/cover_url/language，控制字段为expectedVersion、confirmDelete；其他字段拒绝。created_at、version不可写，PUT即使id相同也拒绝提供id。

| 字段 | 类型、限制、缺省行为 |
| --- | --- |
| id | `[A-Za-z0-9][A-Za-z0-9_-]{0,127}`；POST必需 |
| title | string，trim后非空、≤300码点，不含控制字符；POST必需 |
| artist/album | string或null；trim后≤300码点，不含控制字符；空串保存null |
| duration | null或有限number，0..86400秒 |
| audio_url/cover_url | null或trim后≤2048码点的地址；空串保存null；有效HTTPS URL（无凭据、fragment）或媒体对象路径；禁止穿越、反斜杠、无效转义等；相对路径不得带query/fragment |
| language | null或 zh/ja/en/ko/instrumental/ru/es/fr/de/sv/vi/yue/it/th/pt/other |
| expectedVersion | PUT/DELETE必需，64位lowercase SHA-256，从最近GET响应取得 |
| confirmDelete | DELETE必须严格true |

POST要求audio_url键存在，但当前允许null。POST省略可空字段保存null；PUT省略字段保留原值。不要把正文title等以同名显示文本反算version。

单曲DELETE有歌单关系、播放统计、播放事件或歌词翻译引用时409 `SONG_IN_USE`，data包含 `member_playlists,play_stats,play_events,lyric_translations` 计数；成功只删元数据，媒体保留。PUT采用版本保护，歌曲已有引用时仍可修改元数据或切换媒体引用。

```http
POST /api/admin/catalog/songs
<第1节认证及JSON请求头>

{"id":"track_001","title":"Night Walk","artist":"Example Artist","album":"Evening","duration":240.5,"audio_url":"/media/audio/0123456789abcdef.flac","cover_url":null,"language":"instrumental"}
```

```http
PUT /api/admin/catalog/songs/track_001
<第1节认证及JSON请求头>

{"expectedVersion":"<GET返回的64位version>","title":"Night Walk (Live)"}
```

单曲错误外壳为 `{ok:false,error,message,data?}`。400 `INVALID_BODY/INVALID_ID/INVALID_LANGUAGE/INVALID_QUERY/VERSION_REQUIRED/DELETE_CONFIRMATION_REQUIRED`；404 `SONG_NOT_FOUND`；409 `SONG_EXISTS/VERSION_CONFLICT/SONG_IN_USE`；503 `CATALOG_STORAGE_UNAVAILABLE`。JSON无效或超过64KiB返回400 `INVALID_BODY`。

### 5.2 批量删除必须先预检

实现：[adminMusicDeletion.js](../src/services/adminMusicDeletion.js)、[adminMusicContracts.js](../src/utils/adminMusicContracts.js)、[媒体引用复核](../src/services/adminMusicMedia.js)。

| METHOD + path | 精确JSON字段 | 响应 |
| --- | --- | --- |
| `POST /api/admin/catalog/delete-preview` | `{ids:string[]}` | `{code:200,data:DeleteImpact}` |
| `POST /api/admin/catalog/delete` | `{ids:string[],delete_media:boolean,impact_digest:string}` | `{code:200|207|503,data:DeleteResult,message?:string}`，冲突409返回新的DeleteImpact |

ids必须1..50项且唯一；每项非空、trim不变、JS length≤128、不含 `/`。批删不是单曲ID正则校验的同一个parser。impact_digest必须64位lowercase SHA-256，使用预检响应原值。delete_media为必需boolean，不能省略当作false。未知字段拒绝。本轮完善后的共享parser要求application/json、JSON对象，并流式限制64KiB；坏Content-Type、坏JSON或超限在曲库读取/写入之前返回HTTP400，保留 `{code:400,message,details?}` 外壳。

```ts
type DeleteImpact = {
  songs: Omit<CatalogSong,"version">[];
  missing_ids: string[];
  affected_playlists: {id:string;name:string|null;type:string|null;account_id:string;revision:number}[];
  playlist_relations: {playlist_id:string;song_id:string;sort_order:number;name:string;type:string;account_id:string;revision:number}[];
  lyric_translations: {song_id:string;count:number}[];
  play_records: {song_id:string;play_stats:number;play_events:number}[];
  media: ImpactMedia[];
  impact_digest: string;
};
type ImpactMedia = {
  song_id:string; field:"audio_url"|"cover_url"; path:string|null;
  classification:"absent"|"unsafe_absolute"|"unsafe_out_of_prefix"|"managed_shared"|"managed_unique";
  shared:boolean; can_delete:boolean;
  object_key?:string; remaining_reference_ids?:string[];
};
type DeleteResult = {
  deleted_ids:string[]; missing_ids:string[];
  affected_playlists:DeleteImpact["affected_playlists"];
  deleted_relations:{playlist_songs:number;lyric_translations:number};
  media:{
    mode:"delete"|"retain";
    deleted:{path:string;object_key:string}[];
    retained:{path:string;classification:string}[];
    skipped:{path:string|null;reason:string;song_id?:string;field?:string;remaining_reference_ids?:string[]}[];
    failures:{path:string;object_key:string;message:string}[];
  };
  lyric_cleanup:{
    recovered_song_ids:string[];pending_song_ids:string[];
    pending_objects:{song_id:string;object_key:string}[];retryable:boolean;
  };
};
```

实际执行会重新读取歌曲、引用与媒体影响并核对摘要，且在事务中再保护歌曲字段、引用数量和歌单revision。摘要变化返回409 `{code:409,message,data:新的DeleteImpact}`，必须重新展示并确认。

批删会删除歌曲及相关关系、播放和翻译数据、重排受影响歌单并增加其revision，处理歌词资产生命周期；与单曲DELETE“有引用则拒绝”不同。delete_media=false保留媒体；true也只删除16位hex命名、无剩余引用的受管audio/cover对象。外部URL、不安全路径和共享对象不删。

HTTP207表示歌曲删除已完成，但媒体清理部分失败。HTTP503也可能元数据已经删除、歌词marker清理待恢复；错误data中的lyric_cleanup可能只包含 `failed_song_id,object_key,retryable,reason,compensation_failed_song_ids` 或 `recovered_song_ids,pending_song_ids,retryable` 的适用子集，不保证是完整DeleteResult。收到此响应应读取实际data、重新预检，不得一律提示“尚未删除”。即使delete_media=false，此实现仍要求MEDIA_BUCKET以处理歌词生命周期。缺绑定503；无效MEDIA_PREFIX可能500。

```http
POST /api/admin/catalog/delete-preview
<第1节认证及JSON请求头>

{"ids":["track_001","track_002"]}
```

```http
POST /api/admin/catalog/delete
<第1节认证及JSON请求头>

{"ids":["track_001","track_002"],"delete_media":false,"impact_digest":"<用户确认的预检digest>"}
```

`/api/admin/catalog/playlists`及其子路径明确404，不能用于管理个人歌单。旧helper导出 `handlePreview/handleBatch/handleEditSong/handleMediaDelete` 没有真实路由调用者，本页不将它们列为HTTP能力。

测试：[localCatalogAdmin.test.js](../src/routes/localCatalogAdmin.test.js)、[远程管理工具适配](../../tooling/batch-ingest/remote.test.mjs)。

## 6. 原始媒体上传

实现：[localCatalogMedia.js](../src/routes/localCatalogMedia.js)。

`PUT /api/admin/catalog/media/{audio|cover}/{id}.{extension}`：id必须16位小写hex；禁止query。Body是原始文件字节，**不是multipart/form-data**。仍需管理员Cookie、Origin、X-Requested-With、CSRF及建议的Expected-Account头。

| kind | extension | 精确Content-Type |
| --- | --- | --- |
| audio | mp3 | audio/mpeg |
| audio | flac | audio/flac |
| audio | wav | audio/wav |
| audio | ogg | audio/ogg |
| audio | m4a | audio/mp4 |
| audio | aac | audio/aac |
| audio | wma | audio/x-ms-wma |
| cover | jpg/jpeg | image/jpeg |
| cover | png | image/png |
| cover | webp | image/webp |

Content-Type不得附charset；需要Content-Length或 `X-FlareTune-Media-Size`，两者同时出现必须数值一致。大小为非空安全整数、≤104857600字节（100MiB）；实际流字节数还要与声明一致。服务验证文件头签名，按MEDIA_PREFIX流式写R2并原子防覆盖，不能以同ID覆盖旧对象。

成功HTTP201：

```json
{"ok":true,"data":{"path":"audio/0123456789abcdef.flac","url":"/media/audio/0123456789abcdef.flac","objectKey":"<配置前缀>/audio/0123456789abcdef.flac","size":123456,"etag":"<R2 etag>"}}
```

```http
PUT /api/admin/catalog/media/audio/0123456789abcdef.flac
Origin: https://music.example.com
X-Requested-With: FlareTune
X-CSRF-Token: <csrfToken>
X-FlareTune-Expected-Account: <accountId>
Cookie: __Host-ft_session=<会话值>
Content-Type: audio/flac
X-FlareTune-Media-Size: 123456

<123456字节合法FLAC内容>
```

上传不会创建歌曲。保存歌曲时使用返回的url/path；替换先上传新媒体，再携当前version更新歌曲引用，旧媒体不自动删除。

错误：405 `METHOD_NOT_ALLOWED`带Allow:PUT；400 `INVALID_MEDIA_PATH/MEDIA_SIZE_MISMATCH/INVALID_CONTENT_LENGTH/EMPTY_MEDIA_BODY/INVALID_MEDIA_BODY`；411 `MEDIA_SIZE_REQUIRED`；413 `MEDIA_TOO_LARGE`；415 `UNSUPPORTED_MEDIA_TYPE/MEDIA_CONTENT_TYPE_MISMATCH/INVALID_MEDIA_SIGNATURE`；409 `MEDIA_EXISTS`；502 `MEDIA_UPLOAD_FAILED/MEDIA_SIZE_UNVERIFIED`；503 `MEDIA_STORAGE_UNAVAILABLE`。错误外壳同单曲族。

测试：[localCatalogMedia.test.js](../src/routes/localCatalogMedia.test.js)。

## 7. 入库设备和R2任务邮箱

实现：[localIngestDevices.js](../src/routes/localIngestDevices.js)。以下缩写 `D=/api/admin/ingest/devices` 仅为阅读方便，请求须使用完整路径。deviceId、fileId、jobId均32位小写hex。设备程序和浏览器都用现有管理员会话，没有独立设备token。数据按实例MEDIA_PREFIX存放R2邮箱，不是D1任务表。

| METHOD + 完整path | 请求 | 成功data |
| --- | --- | --- |
| `GET /api/admin/ingest/devices` | 无 | `{devices:Device[]}`，最多200个 |
| `POST /api/admin/ingest/devices/{deviceId}/heartbeat` | `{name:string,roots:string[]}` | `Device`，online=true |
| `GET /api/admin/ingest/devices/{deviceId}/manifest` | 无 | `{files?:ManifestFile[],scannedAt?:number,online:boolean,name:string}` |
| `PUT /api/admin/ingest/devices/{deviceId}/manifest` | `{files:ManifestFile[],preserveScanTime?:boolean}` | `{count:number,scannedAt:number}` |
| `GET /api/admin/ingest/devices/{deviceId}/poll` | 无 | `{jobs:Job[]}`，最多100个，不消费任务 |
| `POST /api/admin/ingest/devices/{deviceId}/jobs` | `{kind:"audio"|"cover"|"refresh",fileId?:string}` | HTTP201 `{job:Job}` |
| `GET /api/admin/ingest/devices/{deviceId}/jobs/{jobId}` | 无 | `{job:PendingJob|JobResult}` |
| `PUT /api/admin/ingest/devices/{deviceId}/jobs/{jobId}` | `{status:"done"|"error",url?:string,message?:string}` | `{job:JobResult}` |
| `PUT /api/admin/ingest/devices/{deviceId}/jobs/{jobId}/progress` | `{loaded:number,total:number}` | `{accepted:true}` |
| `POST /api/admin/ingest/devices/{deviceId}/jobs/{jobId}/retry` | 当前handler不读body，可发 `{}` | HTTP201 `{job:Job}` |

```ts
type Device = {id:string;name:string;roots:string[];lastSeenAt:number;scannedAt:number|null;online:boolean};
type ManifestFile = {
  id:string;path:string;name:string;size:number;
  cover?:null|{size:number;name?:string;[key:string]:unknown};
  [key:string]:unknown;
};
type Job = {
  id:string;kind:"audio"|"cover"|"refresh";fileId:string|null;
  createdAt:number;mediaId:string;expectedSize:number|null;expectedExtension:string|null;
};
type PendingJob = Job & {status:"pending";progress:null|{kind:"audio"|"cover";loaded:number;total:number}};
type JobResult = Job & {status:"done"|"error";url:string|null;message:string;completedAt:number};
```

约束及行为：

- heartbeat会注册/覆盖设备；name转string、trim、截80字符，roots最多16项、各转string截100字符；name和roots数组不得空。online为最近heartbeat距当前<60000毫秒。
- manifest最多5000项、请求≤2MiB；path必须string、≤1024字符，name必须string、≤512字符，size正安全整数，cover存在时cover.size同样正安全整数。数组可空。当前不检查fileId唯一性，也不严格验证common/history等附加字段；按原对象保存。cover.name虽未在manifest写入处完整验证，但创建cover任务时需要合法文件名扩展名。
- preserveScanTime严格true时复用旧manifest的scannedAt，否则重新计时；设备registry同步扫描时间。无manifest时GET可能不含files/scannedAt，不能直接当作空数组保证。
- 创建/重试要求设备online。audio/cover必须来自最新manifest，cover要求候选存在封面；扩展名同上传白名单；**设备任务限制100000000字节，与100MiB直接上传上限不同**。refresh不要求fileId，expectedSize/expectedExtension为null。
- progress只接受尚未完成的audio/cover任务：loaded为0..expectedSize安全整数，total严格等于expectedSize。
- done媒体结果必须是精确 `/media/{kind}/{mediaId}.{expectedExtension}`，并确认R2对象存在且size等于expectedSize；不允许任意URL。refresh完成不要求媒体。message转string并截300字符。
- 写完成结果后删除pending/progress；GET先找完成结果。retry仅error任务，保留原jobId/mediaId/createdAt，删除旧result/progress。没有已实现的取消、删除设备或批量清任务接口。
- 上传或完成设备任务不等于保存Songs，仍需管理员显式保存歌曲引用。设备manifest中的真实文件路径属于管理数据，不应用于消费端页面。
- 普通body≤64KiB；设备parser实际不单独检查Content-Type，但客户端统一发送JSON对象。空body、无效JSON、超限一般400。

```http
POST /api/admin/ingest/devices/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/heartbeat
<第1节认证及JSON请求头>

{"name":"Music PC","roots":["music"]}
```

```http
PUT /api/admin/ingest/devices/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/manifest
<第1节认证及JSON请求头>

{"files":[{"id":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","path":"music/Night.flac","name":"Night.flac","size":123456,"common":{"title":"Night"},"cover":null}],"preserveScanTime":false}
```

```http
POST /api/admin/ingest/devices/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/jobs
<第1节认证及JSON请求头>

{"kind":"audio","fileId":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
```

程序poll后，用任务mediaId和expectedExtension调用第6节PUT上传、报告progress，最后PUT结果done。浏览器轮询job结果，再显式保存歌曲。

错误无稳定error code：403管理员限制；404设备/任务不存在；409离线、清单变化、无封面、对象未确认或任务状态不允许；413任务媒体超限；503存储未配置/前缀无效；其他校验400。客户端应依据HTTP状态和message，不解析错误中文文本当机器码。

测试：[localIngestDevices.test.js](../src/routes/localIngestDevices.test.js)、[设备程序测试](../../tooling/ingest-agent/agent.test.mjs)、[历史记录测试](../../tooling/ingest-agent/history.test.mjs)。
