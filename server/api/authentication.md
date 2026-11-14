# 认证、实例与个人设置 API

本文是宿主现有接口的调用合同，供原生客户端与其他消费端直接实现。通用 HTTP 规则及其他模块见 [API 索引](../API.md)。本页覆盖实例状态、首次认领、维护升级、本站会话、Google 登录/绑定、本人资料/语言/Subsonic 设置及私人图片；不包含插件业务、管理员账号管理或共享目录管理。

真实入口为 [`flaretune.js`](../src/flaretune.js) → [`httpRouter.js`](../src/instance/httpRouter.js)。下列每一项均有真实 METHOD/path 接线；源码导出的工具函数不等于公开端点。认证、个人设置响应使用裸 JSON 对象，不套音乐目录的 `code/data` 包装。

## 1. 公共调用规则

- 生产环境使用实例 HTTPS origin，例如 `https://music.example`。认证只使用本站 `__Host-ft_session` Cookie，没有 Bearer、refresh token 或用户名密码换取持久 API token 的接口。
- 非 GET 请求必须带 `Origin: https://music.example` 与 `X-Requested-With: FlareTune`。原生 HTTP 客户端也必须显式发送这些头；只发送 Cookie 不够。已配置的受信跨域 origin 按通用协议处理。
- 已有有效会话的写入还需当前 `X-CSRF-Token`。例外是本站 login、setup、verify-maintenance、upgrade；匿名 Google start 无会话 CSRF，但带有效 Cookie 调用它时仍需 CSRF。logout、改密、个人设置、上传与删除均不豁免。
- 可发送 `X-FlareTune-Expected-Account: <accountId>` 防止账号切换后提交旧请求。通过统一门禁的请求若与当前账号不符返回 409 `account_changed`；`GET /api/auth/session` 是提前返回的会话探测，不应用此检查。
- JSON 正文必须是 UTF-8 对象，`Content-Type: application/json`（允许参数），最大 8192 字节；数组、null、坏编码/JSON、缺失正文、错误 Content-Type 或超限均为 400 `invalid_input`。logout、Google start 和图片 DELETE 不解析 JSON 正文；上传使用独立二进制协议。
- 除公开探测、首次认领和维护专用流程外，实例须为 `ready`。个人业务要求正常会话；强制改密会话不能访问个人资料、图片或 Subsonic 设置。
- JSON 错误为 `{"error":"稳定错误码"}`。常见门禁错误：401 `authentication_required`、403 `forbidden` / `csrf_rejected`、409 `account_changed`、503 `setup_required` / `maintenance` / `recovery_required` / `service_unavailable`。同一路径不同状态下可能先命中门禁，因此不得仅按某个处理器的业务错误推断身份。

来源：[`accessPolicy.js`](../src/instance/accessPolicy.js)、[`httpSecurity.js`](../src/instance/httpSecurity.js)、[`httpRouter.js`](../src/instance/httpRouter.js)。

## 2. METHOD/path 总表

`正常账号`包含 member/admin，但均只能访问本人的私人数据；管理员身份不授予他人图片或偏好的读取权。

| METHOD | Path | 权限/实例状态 | 成功响应 |
| --- | --- | --- | --- |
| GET | `/api/instance/status` | 公开，任何实例状态 | 200，状态/版本 |
| GET | `/api/health` | 公开，任何实例状态 | 200 或 503，健康摘要 |
| GET | `/api/auth/session` | 公开探测；有效 Cookie 才返回用户 | 200，会话摘要 |
| POST | `/api/auth/verify-setup` | `setup_required`，初始化 Secret | 200，setup proof |
| POST | `/api/auth/setup` | `setup_required`，setup proof | 201，`{ok:true}` |
| POST | `/api/auth/login` | `ready`，本站用户名密码 | 200，会话摘要及 Cookie |
| POST | `/api/auth/logout` | `ready`；匿名也可清 Cookie | 200，`{ok:true}` |
| POST | `/api/auth/change-password` | `ready`，正常或强制改密会话 | 200，`{ok:true}`，清 Cookie |
| POST | `/api/instance/verify-maintenance` | `maintenance`，初始化 Secret | 200，maintenance proof |
| POST | `/api/instance/upgrade` | `maintenance`，maintenance proof | 200，升级状态 |
| GET | `/api/admin/system/migration` | `ready`，正常 admin | 200，主版本与补充迁移状态 |
| POST | `/api/admin/system/migration` | `ready`，正常 admin | 200，升级状态 |
| GET | `/api/auth/google/status` | `ready`，无需登录 | 200，`{enabled}` |
| POST | `/api/auth/google/start` | `ready`，无需登录 | 200，`{url}` 与交易 Cookie |
| GET | `/auth/google/callback` | `ready`，有效浏览器交易 | 303，浏览器重定向 |
| GET | `/api/account/google` | `ready`，正常账号 | 200，本人绑定状态 |
| POST | `/api/account/google/bind` | `ready`，正常账号及本人密码 | 200，`{url}` 与交易 Cookie |
| POST | `/api/account/google/unbind` | `ready`，正常账号及本人密码 | 200，`{ok:true}`，清 Cookie |
| GET | `/api/admin/google` | `ready`，正常 admin | 200，安全配置摘要 |
| PUT | `/api/admin/google` | `ready`，正常 admin | 200，更新后的安全配置摘要 |
| PATCH | `/api/account/profile` | `ready`，正常账号 | 200，`{user}` |
| PATCH | `/api/account/ui-language` | `ready`，正常账号 | 200，`{uiLanguage}` |
| GET | `/api/account/subsonic` | `ready`，正常账号 | 200，`{enabled,revision}` |
| PUT | `/api/account/subsonic` | `ready`，正常账号 | 200，`{enabled,revision}` |
| POST | `/api/account/images/upload/avatar` | `ready`，正常账号 | 201，图片 DTO |
| POST | `/api/account/images/upload/playlist` | `ready`，正常账号 | 201，图片 DTO |
| GET | `/api/account/images/slots/avatar/avatar` | `ready`，正常账号 | 200，引用槽 DTO |
| PUT | `/api/account/images/slots/avatar/avatar` | `ready`，正常账号 | 200，引用槽 DTO |
| GET | `/api/account/images/slots/playlist/{targetId}` | `ready`，正常账号 | 200，引用槽 DTO |
| PUT | `/api/account/images/slots/playlist/{targetId}` | `ready`，正常账号 | 200，引用槽 DTO |
| GET | `/api/account/images/{id}` | `ready`，正常账号且本人图片 | 200，`image/webp` 字节 |
| DELETE | `/api/account/images/{id}` | `ready`，正常账号且本人未引用图片 | 200，`{ok:true}` |

共 32 种调用组合。统一 OPTIONS 预检不另计为业务接口。已移除的 `/api/auth/recovery` 对所有方法返回 404 `not_found`，不是管理员重置通道。不存在 `GET /api/account/profile` 或 `GET /api/account/ui-language`；读取本人这两项使用 session 响应。

## 3. 实例探测与首次认领

### GET /api/instance/status

无请求正文。响应：

```json
{"state":"ready","schemaVersion":2,"targetVersion":2}
```

- `state`: `setup_required | ready | maintenance | recovery_required`。
- `schemaVersion`: 已识别主 schema 版本，通常 0/1/2；控制面不可用或不可信时为 `null`。
- `targetVersion`: 当前宿主主 schema 版本，目前为 2；不是 D1 SQL 文件总数，也不是应用版本号。
- 不返回内部 `reason`、初始化 Secret 或数据库错误详情。

### GET /api/health

```json
{"ok":true,"state":"maintenance"}
```

只有 `recovery_required` 返回 HTTP 503 且 `ok:false`。`setup_required` 和 `maintenance` 仍可返回 200/`ok:true`，因此判断是否能登录/消费音乐必须检查 `state === "ready"`。

来源：[`state.js`](../src/instance/state.js)、[`schemaManifest.js`](../src/instance/schemaManifest.js)、[`httpRouter.js`](../src/instance/httpRouter.js)。

### POST /api/auth/verify-setup

仅实例 `setup_required` 时开放。JSON：

```json
{"setupSecret":"<部署者配置的 SETUP_SECRET>"}
```

成功 200：

```json
{"proof":"<不透明签名证明>","expiresInSeconds":600}
```

proof 绑定当前 origin、`setup` purpose，最长有效 10 分钟；它不是登录会话。服务端配置的 Secret 至少 32 个字符串单元，部署者应使用高熵随机值。错误 Secret 或不可签发 proof 返回 403 `invalid_setup`。验证入口有 isolate 内 15 分钟限流：可识别 IP 5 次、未知 IP 共用 3 次，超限 429 `rate_limited`，带 `Retry-After`；这不是跨所有 Worker 节点的全局限流保证。

### POST /api/auth/setup

JSON：

```json
{"proof":"<verify-setup 返回值>","username":"owner","password":"a-long-example-password"}
```

- `proof`: 上一步返回值，目的和 origin 必须匹配。
- `username`: 字符串，转为小写后匹配 `[a-z0-9_.-]{3,64}`；不自动 trim。此处是首次认领规则，不可套用管理员创建其他账号的不同用户名规则。
- `password`: 字符串，至少 8 个 Unicode code point，UTF-8 最多 1024 字节，没有大小写/数字组成要求。

成功 201 `{"ok":true}`。先初始化受支持的空数据库，再原子创建唯一首个 admin、本站凭据和默认实例设置，并永久关闭认领。**成功不会登录，也不返回 Cookie/accountId**；随后调用 login。

proof 错误 403 `invalid_setup`；账号/密码格式 400 `invalid_input`；认领竞争或事务失败 409 `claim_failed`；并发状态变化可能为 409 `invalid_state`。初始化失败为 503 `bootstrap_failed` / `migration_bundle_invalid` / `service_unavailable`。有效 proof 后的 setup 另有数据库限流：15 分钟每 IP 5 次，未知 IP 共用最多 3 次，429 带 `Retry-After`。

来源：[`setupProof.js`](../src/instance/setupProof.js)、[`bootstrap.js`](../src/instance/bootstrap.js)、[`local/index.js`](../src/auth/local/index.js)、[`crypto.js`](../src/auth/local/crypto.js)、[`rateLimit.js`](../src/auth/local/rateLimit.js)。

## 4. 本站会话与密码

### POST /api/auth/login

```json
{"username":"listener","password":"example-password"}
```

用户名按上述格式转小写查找；无效/未知用户名、错误密码和已禁用账号统一 401 `invalid_credentials`，不泄露账号是否存在。成功 200：

```json
{
  "authenticated":true,
  "mustChangePassword":false,
  "user":{"accountId":"<账号ID>","username":"listener","displayName":"Listener","role":"member"},
  "csrfToken":"<当前会话的 CSRF token>"
}
```

响应同时设置 `__Host-ft_session=<opaque>; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=...`。已配置的跨 origin 登录使用 `SameSite=None`。正常会话最长 7 天，强制改密会话最长 15 分钟；客户端保存 Cookie，不能把 CSRF token 当登录 token。登录 DTO 的 user 不含头像/界面语言，需 session 探测取得扩展字段。

登录限流使用 15 分钟窗口：每可识别 IP 10 次、每规范用户名 8 次；无可信 IP 时共用最多 3 次。429 `rate_limited` 带 `Retry-After`；存储失败为 503 `service_unavailable`。成功尝试也占限流窗口。

### GET /api/auth/session

无效、过期、撤销、禁用或没有 Cookie，以及实例未 ready 时，通常为 200：

```json
{"authenticated":false,"mustChangePassword":false}
```

正常会话示例：

```json
{
  "authenticated":true,
  "mustChangePassword":false,
  "user":{
    "accountId":"<账号ID>","username":"listener","displayName":"Listener","role":"member",
    "uiLanguage":"auto",
    "avatar":{"imageId":null,"url":null,"revision":0}
  },
  "csrfToken":"<当前会话的 CSRF token>"
}
```

`role` 为 `admin | member`。强制改密会话的 `mustChangePassword:true`，包含 user/uiLanguage/csrfToken，但不包含 avatar。有效 Cookie 的存储读取失败可返回 503 `service_unavailable`。此接口不隐式续期，也不保证在未认证响应中发送清 Cookie 头。

### POST /api/auth/logout

无需正文。撤销当前 Cookie 对应会话，200 `{"ok":true}`，并发送 Max-Age=0 清 Cookie。无会话也可清 Cookie；有会话时必须发送其 CSRF。此操作不等同于撤销本人所有设备会话。

### POST /api/auth/change-password

正常会话 JSON：

```json
{"currentPassword":"old-example-password","newPassword":"new-example-password"}
```

`newPassword` 遵循 8 code point/1024 UTF-8 字节规则，且不能与当前密码相同。正常会话校验 currentPassword；**强制改密模式由受限登录会话证明身份，不要求 currentPassword，可仅提交 newPassword**。

成功 200 `{"ok":true}`，清 Cookie；撤销本人全部本站 Cookie 会话，关闭本人 Subsonic 兼容凭据，并使相关在途 Google 登录失效。客户端应清本地会话并用新密码重新登录。Google 绑定记录不会因此删除。

新密码无效或等于旧密码为 400 `invalid_input`；当前密码/凭据无效为 401 `invalid_credentials`；并发变化或原子改密失败为 409 `password_change_failed`；其他存储失败为 503 `service_unavailable`。

来源：[`httpRouter.js`](../src/instance/httpRouter.js)、[`local/index.js`](../src/auth/local/index.js)、[`crypto.js`](../src/auth/local/crypto.js)。

## 5. 维护与管理员迁移

### POST /api/instance/verify-maintenance

仅 `maintenance` 状态开放，正文 `{"setupSecret":"<SETUP_SECRET>"}`。成功为 `{"proof":"<维护证明>","expiresInSeconds":600}`，与 setup proof 类似但 purpose 为 `maintenance`，不能互换。错误 403 `invalid_setup`；验证限流与 verify-setup 共用 isolate 内桶，超限 429 并带 `Retry-After`。

### POST /api/instance/upgrade

仅 `maintenance` 状态，正文：

```json
{"proof":"<verify-maintenance 返回值>","backupConfirmed":false}
```

`backupConfirmed` 可省略；只有严格布尔 `true` 才授权内置迁移处理需要备份确认的旧系统歌单。字符串 `"true"` 不等于确认。proof 须在有效期内且匹配 origin/purpose；错误为 403 `invalid_setup`。这个 API 只运行仓库内置已知迁移，不接收 SQL、任意版本或管理员重置动作。

### GET /api/admin/system/migration

正常 admin，在 ready 时读取：

```json
{
  "schemaVersion":2,"targetVersion":2,"state":"ready","supplementalPending":false,
  "supplementalMigrations":[
    {"id":"ai_protocols","ready":true},{"id":"user_images","ready":true},
    {"id":"ai_feature_models","ready":true},{"id":"google_login","ready":true},
    {"id":"hotpath_counts","ready":true},{"id":"external_music","ready":true}
  ]
}
```

补充能力缺失可与主 schemaVersion=2 并存，不能只看主版本判断 Google/图片已经就绪。

### POST /api/admin/system/migration

正常 admin，带 Cookie/CSRF，提交 JSON `{}`。正文会被解析但字段不驱动 SQL；此路径不读取 backupConfirmed。一次最多推进 20 个内置步骤，遇到非 in_progress 状态即返回。若迁移未在这次请求完成，实例可能进入 maintenance；后续使用初始化 Secret 的维护流程，不绕过状态门禁。

两个升级路径的 HTTP 200 响应为下列联合类型，不能把任何 200 都当完成：

```json
{"status":"current","schemaVersion":2}
```

```json
{"status":"in_progress","phase":"backfill","processed":100,"cursor":"<不透明游标>","schemaVersion":1}
```

- `status`: `current | in_progress | completed | already_completed | lease_busy`。
- `schemaVersion`: 当前已识别版本。
- `processed`: 本步处理数量，部分状态没有此字段。
- `phase`: 存在时为 `backfill | verify`；`cursor` 是字符串或 null，部分状态省略。客户端不自行拼接或提交这个游标。
- `lease_busy` 表示迁移租约暂不可取得；`in_progress` 需要继续推进/读取实例状态。

业务错误：409 `backup_required` / `invalid_state`；503 `migration_schema_inconsistent` / `migration_supplemental_failed` / `migration_expand_failed` / `migration_step_failed` / `service_unavailable`。recovery_required 状态没有本页提供的自助恢复/重置接口。

来源：[`upgradeDatabase.js`](../src/instance/upgradeDatabase.js)、[`playlistCountMigration.js`](../src/instance/playlistCountMigration.js)、[`migrationStatus.js`](../src/instance/migrationStatus.js)、[`httpRouter.js`](../src/instance/httpRouter.js)。

## 6. 本人资料、语言与 Subsonic 设置

### PATCH /api/account/profile

只接受 `{"displayName":"新昵称"}`，多余字段为 400 `invalid_input`。displayName 必须是字符串，保存前 trim，长度最多 80 个 UTF-16 code unit；允许空字符串表示清空昵称，禁止 U+0000–001F、U+007F、U+2028、U+2029。缺失或无效字段为 400 `invalid_display_name`。

成功 200：

```json
{"user":{"accountId":"<本人ID>","username":"listener","displayName":"新昵称","role":"member"}}
```

不能修改 username/role/其他账号。无 revision 参数，后写覆盖前写；账号失效为 401 `authentication_required`。

### PATCH /api/account/ui-language

必须且仅有 `uiLanguage`：

```json
{"uiLanguage":"zh-Hant"}
```

接受精确值 `auto | zh | en | zh-Hant | ja | ko`；`zh-CN`、`zh-TW` 等浏览器 tag 不能直接作为此字段。成功 200 原样返回 `{"uiLanguage":"zh-Hant"}`。未设置默认 auto；auto 的实际显示语言由客户端选择，不由服务端响应头确定。旧已存退役语言值在读取时可能回退 en，不表示 PATCH 仍接受它们。

字段集合无效为 400 `invalid_input`，值无效为 400 `invalid_ui_language`，账号失效为 401 `authentication_required`。语言按账号跨设备保存，读取用 session.user.uiLanguage。

### GET /api/account/subsonic

```json
{"enabled":false,"revision":0}
```

enabled 表示本人兼容凭据目前可用；Secret 轮换、损坏或账号凭据变更会安全回退 false。revision 是当前个人配置版本，没有配置时为 0；响应不返回任何密码/密文。

### PUT /api/account/subsonic

启用：

```json
{"enabled":true,"currentPassword":"current-example-password","expectedRevision":0}
```

停用：

```json
{"enabled":false,"expectedRevision":1}
```

- enabled 必须是 boolean；expectedRevision 必须是非负安全整数，取 GET 返回值。启用校验本人当前本站密码；停用无需密码。
- 成功 200 `{"enabled":true,"revision":1}`，revision 每次成功写入加 1，包括重复写同一 enabled 值。
- 为支持 Subsonic 的 `t=MD5(password+salt)`，显式启用会保存受 SETUP_SECRET 派生密钥保护的加密密码副本；不会回显。正常官方 REST 消费不需要开启此开关。
- PUT 启用使用本站 login 限流桶；超限为 429 `rate_limited`，此路径当前不附 Retry-After。停用不增加密码尝试桶。
- 格式 400 `invalid_input`；当前密码错误 401 `invalid_credentials`；账号不可用 401 `authentication_required`；版本/在途凭据或会话变化 409 `revision_conflict`；加密/存储不可用 503 `service_unavailable`。
- 本站改密/管理员重置会关闭兼容访问，需新密码重新启用。`SETUP_SECRET` 轮换也会使旧兼容密文不可用。

本页只描述此开关，不是 `/rest/*` 协议参考。来源：[`profile.js`](../src/auth/local/profile.js)、[`uiLanguages.js`](../../shared/uiLanguages.js)、[`credentials.js`](../src/subsonic/credentials.js)。

## 7. Google：浏览器登录、本人绑定和管理员配置

Google 是现有本站账号的可选登录方式，不会按 email 自动创建或合并账号，也不是 YouTube Music 插件授权。Google sub 与本站账号一对一绑定；未绑定、禁用或必须改密的账号不能借 Google 获得正常本站会话。

### 原生客户端边界

当前流程依赖 **同一浏览器 cookie jar**：POST start 设置 10 分钟 HttpOnly 交易 Cookie，浏览器访问返回的 Google URL，Google 再导航到实例 `/auth/google/callback`。callback 同时检查 state、浏览器 Cookie、nonce、PKCE、配置版本及当前凭据，成功后只在该浏览器设置本站 Cookie 并重定向 Web 页面。

当前没有原生 authorization-code 换本站会话、Google ID token 直登、设备码、app deep link 或把浏览器会话安全移交 App 的接口。原生 HTTP 客户端拿到 `{url}` 不代表已登录；把 URL 交给外部浏览器也不会自动把两个 cookie jar 合并。现有纯原生客户端可使用本站用户名密码；若要原生 Google 登录，需要另行设计明确的会话交还合同，不能把 Web callback 当 token API。

### GET /api/auth/google/status

200 `{"enabled":true}`。只有管理员已启用、Secret 可解密且当前 origin 匹配配置 callbackOrigin 才 true；未迁移或未配置通常为 false，不返回客户端密钥。

### POST /api/auth/google/start

无需业务正文，建议发送 `{}` 及标准写头。成功 200：

```json
{"url":"https://accounts.google.com/o/oauth2/v2/auth?..."}
```

同时设置 `__Host-ft_google_transaction`（HTTPS）或 `ft_google_transaction_dev`（HTTP）Cookie，Path=/、HttpOnly、SameSite=Lax、Max-Age=600；HTTPS Cookie 带 Secure。返回 URL 已包含服务端 nonce/state/PKCE，不得改写这些参数。

未启用/缺配置为 409 `google_unavailable`，调用 origin 不匹配为 409 `google_origin_mismatch`，Secret 不可解密为 503 `google_secret_unavailable`，限流 429 `rate_limited`。Google 开始/绑定/解绑复用 login 尝试桶，429 不保证 Retry-After。上游请求失败在 callback 内转为浏览器失败标签。

### GET /auth/google/callback

Google 浏览器导航入口，无 JSON 正文。正常查询为 `state=<opaque>&code=<opaque>`；state 必须且仅出现一次、43 位 base64url；code 最多出现一次且最长 4096 字符。交易有效期 10 分钟、只消费一次，需对应交易 Cookie。

此处理器返回 303，而不是 JSON 登录 DTO：

- 登录成功：Location `/`，设置正常本站 Cookie并清交易 Cookie。
- 登录未绑定：`/?google=unbound`。
- 绑定成功：`/settings/personal?google=bound`。
- 用户取消：目标页 `?google=cancelled`；失败：`?google=failed` 或绑定冲突 `?google=binding_failed`。目标页取已验证交易 purpose；无法识别交易时按登录首页处理。

同一Google身份已被其他账号绑定，或本人已有不同绑定时，不会隐式替换。绑定时会重新验证启动时的本人密码/会话仍然有效；配置修改、改密、禁用、解绑等会使相关在途登录失效。

### GET /api/account/google

正常本人会话，200：

```json
{"ready":true,"configured":true,"bound":true,"email":"listener@example.test"}
```

- ready：存在 Google 配置记录；不是已启用的同义词。
- configured：Secret 可用、存在 clientId、当前 origin 匹配；即使公共登录 enabled=false 也可为 true。
- bound/email：本人的绑定与已验证 email；无绑定时 email 为空字符串。Google 未配置/缺迁移时可能全部为 false/空值。

### POST /api/account/google/bind

正文 `{"currentPassword":"current-example-password"}`。正常会话 + CSRF + 本人当前密码，返回与 start 相同的 `{url}`/交易 Cookie。配置可以尚未启用公共登录，但仍须有完整可解密配置与匹配 origin。密码错误 401 `invalid_credentials`；其他 start 错误同上。

### POST /api/account/google/unbind

正文同 bind。成功 200 `{"ok":true}`，删除本人绑定、撤销本人全部本站 Cookie 会话、删除本人未完成的 Google 绑定交易，并清本站 Cookie。客户端退出登录；已有 Subsonic opt-in 状态不会仅因解绑而自动关闭。无 Google 配置为 409 `google_unavailable`，密码错误 401 `invalid_credentials`。

### GET /api/admin/google

正常 admin，200 安全摘要：

```json
{
  "ready":true,"enabled":false,"clientId":"","callbackOrigin":"",
  "secretConfigured":false,"secretReady":false,"revision":0,"callbackUrl":""
}
```

secretConfigured 仅表示保存了密文，secretReady 表示当前可解密，两者可不同。未迁移/无配置时 ready=false。响应从不返回 clientSecret、密文或 IV。

### PUT /api/admin/google

完整 JSON 对象，字段只允许以下五项：

```json
{
  "enabled":true,
  "clientId":"123-example.apps.googleusercontent.com",
  "clientSecret":"example-client-secret",
  "callbackOrigin":"https://music.example",
  "revision":0
}
```

| 字段 | 类型与约束 |
| --- | --- |
| enabled | 必须 boolean |
| clientId | 必须 string，总长 ≤255；空字符串或匹配 `[A-Za-z0-9_.-]+.apps.googleusercontent.com` 的 ID，域名前的点为字面点 |
| clientSecret | 必须 string，≤512，禁止任意空白；非空替换保存的加密 Secret；空字符串只在 clientId 未变时保留旧值，没有“回显后原样保存”或 null 清空协议 |
| callbackOrigin | 必须为 ≤255 字符的精确 origin，无末尾 `/`、路径、查询、fragment 或 URL 凭据；HTTPS，或开发用 `http://127.0.0.1[:port]` |
| revision | GET 返回的非负安全整数，用于 CAS |

启用必须有有效 clientId 和可解密 Secret。更改 clientId 时必须提供新的非空 clientSecret。成功 200 返回上述完整安全摘要，revision+1，callbackUrl 自动拼接 `/auth/google/callback`。配置更新使旧版本的在途 Google 交易失效；不会删除既有绑定或撤销所有已建立本站会话。

错误：400 `invalid_input` / `google_secret_required`；409 `google_upgrade_required`（需先补齐迁移）/ `configuration_changed`；503 `google_secret_unavailable` 或通用存储失败。`SETUP_SECRET` 轮换后旧 Google Client Secret 可能不可解密，需要管理员重新输入。

来源：[`google.js`](../src/auth/google.js)、[`0012_google_login.sql`](../db/migrations-flaretune/0012_google_login.sql)、[`accessPolicy.js`](../src/instance/accessPolicy.js)。

## 8. 本人私人图片

所有路由从会话确定 owner；请求正文、URL 或管理员身份都不能指定其他账号。图片不通过共享 `/media/` 公开，URL 是需要本人 Cookie 的相对 API URL。服务依赖用户图片迁移和 `MEDIA_BUCKET`。

### POST /api/account/images/upload/{avatar|playlist}

**正文是原始 WebP 字节，不是 JSON/base64/multipart。** 请求头使用精确小写媒体类型 `Content-Type: image/webp`（允许 `;...` 参数，不自动 trim 类型尾随空格或进行大小写规范化），并保留 Origin/X-Requested-With/Cookie/CSRF。

| 项 | 限制 |
| --- | --- |
| 单图字节 | 最大 5,242,880 字节（5 MiB），超限 413 `image_too_large` |
| avatar | 必须 512×512 像素 |
| playlist | 必须 1024×1024 像素 |
| 容器 | 静态 WebP；只接受 VP8 / VP8L / VP8X / ALPH 块，拒绝动画及 EXIF/XMP/ICC 等附加块 |
| 像素边界 | WebP 容器尺寸必须有效且不超过2048×2048；此检查是容器/头部检查，不是完整像素解码器 |
| 未引用配额 | 本人所有 purpose 合计最多16个未引用对象，包括 pending/deleting；已引用图片不计入这个配额，也不是“总图片最多16张”或总存储字节配额 |

客户端应先完成解码、裁剪、重编码和元数据剥离，再发送。PNG/JPEG/SVG 原文件不能直接上传。成功 201：

```json
{"id":"<图片ID>","url":"/api/account/images/<图片ID>","width":512,"height":512,"byteSize":12345}
```

上传成功仅创建私有图片对象，**不会自动应用头像或歌单封面**。下一步读取并更新引用槽。

格式/Content-Type/尺寸不符：400 `invalid_image`；配额：429 `image_upload_limit`；迁移缺失：503 `user_images_migration_required`；R2 不可用：503 `image_storage_unavailable`；写入失败：503 `image_upload_failed`。`/upload/chat` 虽复用该宿主存储，但受助手插件/构建/模型能力门禁，属于插件业务，不纳入这两个普通上传入口的权限合同。

二进制请求示例（示例文件应已正确转换成512方形静态WebP）：

```sh
curl 'https://music.example/api/account/images/upload/avatar' \
  --request POST --cookie cookies.txt \
  --header 'Origin: https://music.example' \
  --header 'X-Requested-With: FlareTune' \
  --header 'X-CSRF-Token: <session.csrfToken>' \
  --header 'Content-Type: image/webp' \
  --data-binary '@avatar.webp'
```

### GET /api/account/images/slots/{avatar|playlist}/{targetId}

targetId 路径格式为 `[A-Za-z0-9_-]{1,160}`；头像固定使用 `avatar/avatar`。playlist targetId 使用本人真实 regular 歌单 ID，不能使用 favorite 兼容别名。返回：

```json
{"imageId":null,"url":null,"revision":0}
```

已有引用返回图片 ID、相对 URL 及正整数 revision。尚无记录、未知目标或图片迁移尚未就绪时，读取可回退为空槽/版本0；不能根据空槽就断言歌单存在或有权写入。GET 不替调用者验证歌单写权限。

### PUT /api/account/images/slots/{avatar|playlist}/{targetId}

JSON 必须仅含 imageId 与 revision：

```json
{"imageId":"<upload返回的图片ID>","revision":0}
```

- imageId：`null` 清除引用，或匹配 `[A-Za-z0-9_-]{1,160}` 的非空字符串；空字符串、缺失、URL、带点/斜线、超长或非字符串均 400 `invalid_input`。
- revision：必需的非负安全整数，使用 GET/上次 PUT 返回值，首次为空槽取0。
- avatar 必须写 `avatar/avatar`；playlist 必须是本人已有 `kind:"regular"` 歌单，不能设置 favorite 封面。
- 图片必须为本人、purpose匹配且状态ready；不允许通过图片ID引用他人或待删除对象。

成功 200 返回新槽 DTO，例如 `{"imageId":"<id>","url":"/api/account/images/<id>","revision":1}`。每次成功提交 revision+1，即使提交同一图片或再次清空。旧引用失效后的清理是机会型、容错的：R2/清理查询失败不把已经保存的引用改报失败。

错误：400 `invalid_input`；404 `playlist_not_found` / `image_not_found`；409 `revision_conflict` / `image_save_failed`；503 `user_images_migration_required` 或未预期存储错误。409 后重新 GET，不能自行猜测版本。坏 JSON、超8KiB或错误 JSON Content-Type 都稳定返回400 `invalid_input`，不作为服务故障重试。

清空示例：

```json
{"imageId":null,"revision":1}
```

### GET /api/account/images/{id}

id 路径同上述图片 ID 格式；只有本人 ready 对象可读。成功返回200 WebP 字节，`Content-Type: image/webp`、`Content-Disposition: inline`、`Cache-Control: private, no-store`、`X-Content-Type-Options: nosniff`。无图片、他人图片、正在删除或R2对象缺失为404 `image_not_found`；缺图片迁移为503 `user_images_migration_required`。没有公开分享链接、HEAD、Range或缓存复用合同，不要套用 `/media` 播放资源协议。

### DELETE /api/account/images/{id}

无需正文，但必须标准写头、Cookie/CSRF。只删除本人 ready 或可重试 deleting 对象；不存在、他人或尚未完成上传的 pending 对象为404 `image_not_found`。仍有任意引用为409 `image_in_use`；先用正确槽 revision 清除引用。

显式删除与机会清理分开：服务在 D1 原子确认本人对象无引用后标记 deleting，再删除 R2 字节并确认 D1 图片行已移除，最后才200 `{"ok":true}`。标记后立即不可读，数据库门禁禁止新增引用。缺 R2 delete 能力为503 `image_storage_unavailable`；D1/R2故障或无法确认移除为503 `image_delete_failed`，不会伪报完成。

若故障发生在标记之后，保留 deleting tombstone；可以对同一 ID 重试，重试不会复活图片。R2 已删但 D1 未移除也可安全重试；已完整删除后再次请求为404。后续本人图片写入仍可机会清理未引用超过24小时的对象及 tombstone，每次至多10个；没有定时清理或到点必删保证。

来源：[`routes/userImages.js`](../src/routes/userImages.js)、[`services/userImages.js`](../src/services/userImages.js)、[`0010_user_images.sql`](../db/migrations-flaretune/0010_user_images.sql)。

## 9. 行为验证入口与证据边界

以下是可复用测试入口，测试数量/通过状态应以当前执行回执为准，不以文档存在代替验证：

- [`flaretune.test.js`](../src/flaretune.test.js)：真实 Worker 分发、profile写入、session回读及CSRF。
- [`accessPolicy.test.js`](../src/instance/accessPolicy.test.js)、[`httpSecurity.test.js`](../src/instance/httpSecurity.test.js)：状态/角色/请求头与JSON限制。
- [`local/index.test.js`](../src/auth/local/index.test.js)、[`rateLimit.test.js`](../src/auth/local/rateLimit.test.js)：认领、密码、Cookie/撤销、个人语言和限流。
- [`upgradeDatabase.test.js`](../src/instance/upgradeDatabase.test.js)、[`migrationStatus.test.js`](../src/instance/migrationStatus.test.js)：维护与补充迁移。
- [`google.test.js`](../src/auth/google.test.js)：浏览器cookie绑定、PKCE、取消/重放、解绑、配置CAS及在途撤销。
- [`subsonic.test.js`](../src/subsonic/subsonic.test.js)：个人opt-in、密码证明、CSRF、版本、改密失效。
- [`userImages.test.js`](../src/services/userImages.test.js)：owner隔离、槽CAS、尺寸/格式、JSON错误、ID输入边界、显式删除故障/重试/并发引用以及后台清理容错。
- [`userImages.compat.test.js`](../src/routes/userImages.compat.test.js)、[`userImages.model.test.js`](../src/routes/userImages.model.test.js)：共用图片路由的既有助手插件兼容回归；不把插件测试扩大为本页普通图片上传权限。
- [`worker-auth-http.test.mjs`](../../tooling/verify/worker-auth-http.test.mjs)、[`google-auth-http.test.mjs`](../../tooling/verify/google-auth-http.test.mjs)：独立本地 D1/workerd HTTP验证入口；执行它们需相应本地环境，不能用源码盘点声称已进行线上/Google真实账号联调。

本页没有声称新原生 Google 流程、真实浏览器登录或云端数据库迁移已经完成，也没有给客户端增加管理或插件能力。
