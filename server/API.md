# FlareTune 宿主 HTTP 接口

面向官方客户端及其他应用开发者的项目接口文档。覆盖宿主已接线的系统能力，不按某个客户端当前页面裁切。插件私有业务接口（小爱、助手、漫游、在线音源、工作台内部接口等）不在此合同内；宿主统一歌词入口、插件能力发现和安装/来源/构建管理仍在范围内。

核对基线：2026-11-12，宿主 `1.3.0` 开发代码，HEAD `3d0076d8431e8cb9501c5029d1af55bddb40ac9a` 加本轮本地完善。文档说明本地代码合同，不等于生产/Demo或任一目标实例已部署相同能力。后端字段名、大小写、响应信封按各章保留，未统一改写旧 API；客户端应容忍新增字段。

## 阅读入口与完整范围

| 文档 | 接口范围 |
| --- | --- |
| [歌词接入（优先交付）](api/lyrics.md) | 统一取词、逐行/逐词时间轴、译文状态/重试、resultRef、来源顺序、错误与原生播放器接入 |
| [实例、认证与个人账号](api/authentication.md) | status/health、setup/maintenance、Cookie会话、改密、Google、资料/语言、Subsonic开关、个人图片/封面 |
| [音乐与个人歌单](api/music.md) | 曲库/搜索/发现、专辑/歌手、现代歌单CRUD/架排序/喜欢、兼容读取、播放统计、媒体Range |
| [管理员与入库](api/administration.md) | 账户/角色/重置密码、实例设置/迁移、后台系统更新及专用构建通道、共享曲库CRUD/删除预检/批删、原始媒体上传、设备扫描/任务/进度/重试 |
| [宿主插件管理框架](api/plugin-management.md) | 能力发现、安装标记、来源/选择/CAS、部署状态及专用机器构建通道；不包含插件业务 |
| [Subsonic兼容附录](api/subsonic.md) | 实际支持的方法、协议认证、XML/JSON、原文件媒体与限制；不是完整OpenSubsonic实现 |

每章列方法和路径、参数/正文、响应、权限、限制、错误及副作用。先读下面的通用约定，再按接口章实现。管理接口完整列出以便复用，但普通成员不会因此获得管理权限。

## 接入顺序

1. 使用实例根 HTTPS 地址，例如 `https://music.example.com`，不要填写 `/api` 或 `/rest` 作为根地址。
2. `GET /api/instance/status` 检查 `state`；只有 `ready` 可使用正常账号业务。初始化/维护属于管理流程，见认证章。
3. `POST /api/auth/login` 提交账号密码并接受 Cookie；读取响应 `authenticated/mustChangePassword/user/csrfToken`。必要时完成改密再登录。已有加密 Cookie 也应经 `GET /api/auth/session` 核验。
4. 后续请求保留当前实例会话。写请求带可信 Origin、请求标记及 CSRF；已认证读写均建议带当前账号上下文头。
5. 歌单、喜欢、歌词、统计等直接使用对应宿主接口，不需要经 Subsonic 转接。所有 ID、revision、version、resultRef 从相应响应取得，不以标题、列表下标或本机猜测值替代。

## 鉴权、实例与请求头

### 普通宿主 API

认证方式为 `__Host-ft_session` Cookie，没有通用 Bearer 登录令牌或原生 refresh-token API。Cookie 的值不应进入 URL 或日志；密码仅用于当前提交。原生客户端可用受控 CookieJar，并对持久凭据加密。

| Header | 使用条件 |
| --- | --- |
| `Accept: application/json` | JSON API 推荐 |
| `Content-Type: application/json` | JSON正文；允许合法charset参数，部分原始二进制接口要求精确MIME，见各章 |
| `Origin: https://music.example.com` | 所有非GET普通API请求必须；原生客户端也发送实例精确origin。管理员配置的跨域origin可被允许 |
| `X-Requested-With: FlareTune` | 所有非GET普通API请求必须 |
| `X-CSRF-Token: <当前会话csrfToken>` | 已认证的普通写请求必须；登录/setup/维护验证等少数认证入口有各自例外，见认证章 |
| `X-FlareTune-Expected-Account: <user.accountId>` | 已认证请求建议携带；账号不一致返回409，避免切换账号后的旧请求落到新身份 |
| `Accept-Language` | 可用于服务端安全提示/新装插件语言，不改变账号权限 |

业务接口要求实例ready、有效账号、会话mode为normal。受限改密会话不能访问正常音乐业务。`/api/admin/*`、`/api/manage/*` 的外层策略要求正常管理员，但没有列出的 `/api/manage` 路径不能当作存在的 API。

服务端支持既定跨域配置；原生应用不必建立新的跨域服务。API请求禁止将会话转发给其他scheme/host/port或重定向目标。歌曲可能包含外部HTTPS媒体URL：可以按应用策略读取，但不得附带本实例Cookie。私人图片走 `/api/account/images/...`，不能改成公开R2地址。

`/media`、Subsonic、Google浏览器callback和专用 `/api/plugin-build/*` 有单独协议，不能把普通JSON写请求模板直接套用。构建Bearer只供受控机器通道，不进入移动应用。

### 实例状态

`state` 来自实例检查，客户端必须接受并展示服务端实际状态，不能把所有非ready当密码错误。常见状态包括 `setup_required`、`ready`、`maintenance`、`recovery_required`；其他配置/结构异常状态亦不可进入业务。`schemaVersion/targetVersion` 是数据库版本，不是客户端功能版本，也不是宿主插件API版本。

实例/账号/会话撤销仍在请求时验证，不能凭一次status或本地Cookie长期跳过。外层部署门还可能返回503；部署门凭据属于运维流程，普通客户端不索取该密钥。

## 响应与错误

### 响应外形

| 类型 | 成功示例 | 典型范围 |
| --- | --- | --- |
| 裸 DTO | `{"authenticated":true,"user":{},"csrfToken":"…"}` | 认证、个人资料、来源顺序、管理账号/设置、插件框架 |
| 音乐信封 | `{"code":200,"data":{}}` | 兼容曲库/专辑/歌词、批量目录删除 |
| 个人/管理信封 | `{"ok":true,"data":{}}` | 现代歌单/统计、单曲管理、媒体上传、入库设备 |
| 特定兼容成功码 | `{"code":0,"data":{}}` | 艺人图片 |
| 二进制 | 音频/图片响应体 | media、个人图片、Subsonic媒体 |

先看HTTP状态，再按目标接口解析信封与结果。HTTP200也可能是批量部分失败、插件构建failed状态或Subsonic协议失败；批量操作须检查逐项结果，状态机接口须检查业务状态。字段命名有 `audio_url` 与 `coverUrl` 等差异，不做盲目统一转换。

| HTTP状态 | 常见语义与处理 |
| --- | --- |
| 400 | 参数、JSON、字段、版本输入错误；保留用户输入并修正，不自动重试 |
| 401 | 登录失败或会话失效，按所在入口区分；旧身份业务失效时停止旧媒体并清理旧账号状态 |
| 403 | 权限不足、改密限制、Origin/CSRF拒绝；不要用重复登录掩盖协议错误 |
| 404 | 不存在/不属于当前账号的资源、无歌词等；按响应error/reason区分 |
| 409 | 账号变化、CAS版本冲突、资源引用/重复、歌词结果变化、插件指纹变化等；回读相关状态后处理，不盲重放覆盖 |
| 411/413/415/416 | 缺媒体长度、过大、格式不支持、Range不满足，详见对应接口 |
| 429 | 额度或节流；有Retry-After时遵循；不要丢弃尚未被确认的播放事件 |
| 500/502/503 | 内部错误、上游/存储异常、实例非ready或当前阶段未开放；删除等操作可能已部分发生，应按响应回读确认 |

常见外层错误为 `{"error":"authentication_required|forbidden|csrf_rejected|account_changed|…"}`。模块错误可能为 `{ok:false,error,message,data?}`、`{code,message,reason?,error?}` 或入库设备的 `{ok:false,message}`。大小写按接口保留，例如歌单 `REVISION_CONFLICT` 和管理员账号 `revision_conflict` 不同。显示安全消息，保留机器码供程序分支，不依赖中文或英文message字符串判错。

当前未匹配业务路由的兼容fallback为503 `phase_not_ready`，并非所有未知路径都404；不要用探测任意路径得到503来推断用户密码失效。`/api/auth/recovery` 和已退役管理员歌单路径另有明确拒绝。

## 分页、时间、并发与重试

- 接口各自定义分页。曲库以page/limit，专辑/歌手/搜索以offset/limit；不要把管理员limit100、Subsoniclimit500套到普通曲库limit50。
- 本地歌曲搜索现返回 `limit/offset/hasMore/nextOffset/capped`；nextOffset为null即不再自动请求。capped=true表示还有结果但达到offset2000的既定上限，应缩小搜索条件，而不是声称已展示全库。旧部署仅有songs/query时需兼容退化，不能宣称旧实例已具备新字段。
- 秒：歌曲duration、歌词行/词时间；毫秒：账号/事件等时间戳，具体字段见各章。Media3 position以毫秒表示，歌词换算一次；歌词偏移已由服务端应用。
- 乐观锁字段不是通用可互换值：歌单 expectedRevision、图片 revision、配置 expectedRevision、账号 expectedUpdatedAt、目录歌曲 expectedVersion、插件 delivery revision 分属不同对象。每次写入使用当前响应值，409回读后合并/重新确认。
- DELETE也可能要求JSON正文。不要按“有body就是POST”构造请求；显式设置HTTP method，并允许DELETE正文。
- 幂等性由接口合同定义。创建歌单可传idempotencyKey；播放上报复用event_id并只移除acceptedEventIds；未知结果时不要换ID重复执行。删除确认摘要变更后重新预检与确认；部署状态未知不是构建已取消。
- 写操作有副作用：读个人歌单列表可能确保收藏容器存在；艺人图片读取可能刷新缓存；歌词读取可能触发来源取词/翻译任务。不能把所有GET都理解为零服务端写入或零外部成本。

## 核心消费接入示例

以下为请求形状，示例ID、Cookie、CSRF和版本值均需取自当前会话，不是可直接重放的真实凭据。

```http
POST /api/auth/login HTTP/1.1
Origin: https://music.example.com
X-Requested-With: FlareTune
Content-Type: application/json

{"username":"listener","password":"<本次输入>"}
```

创建歌单：

```http
POST /api/account/playlists HTTP/1.1
Cookie: __Host-ft_session=<当前cookie>
Origin: https://music.example.com
X-Requested-With: FlareTune
X-CSRF-Token: <当前csrfToken>
X-FlareTune-Expected-Account: <当前accountId>
Content-Type: application/json

{"name":"晚间散步","description":"","songIds":["<songId>"],"idempotencyKey":"<本次创建稳定ID>"}
```

修改歌曲顺序：`PUT /api/account/playlists/{id}/songs`，正文 `{"expectedRevision":3,"songIds":["<songB>","<songA>"]}`；提交完整成员排列。取消喜欢：先在现代列表识别kind=favorite的真实ID，再 `DELETE /api/account/playlists/{favoriteId}/songs/{songId}`，正文 `{"expectedRevision":3}`。两者仍需上述写请求头。

歌词：`GET /api/lyrics?songId={编码ID}`，根据version2结构化lines及syncMode渲染。翻译仅在响应声明支持时，`POST /api/lyrics/translation` 正文 `{"resultRef":"<当前歌词引用>"}`。pending轮询保留该引用；切歌/换账号/会话失效应取消旧任务并丢弃旧结果。

## 与插件、旧接口和客户端的关系

- 现代个人歌单接口与兼容 `/api/playlists/favorite` 同属宿主。兼容别名只用于读取，新写入必须拿真实ID/revision。普通成员可管理自己数据，管理员不能借这些接口管理他人的私人歌单。
- 宿主统一歌词协议会从可用来源读取；没有安装工作台/音源或配置服务时，在线歌词/翻译可不可用。文档列入口不代表实例具备每个来源。普通成员不能把全局歌词来源顺序作为个人设置修改。
- 宿主发布版本、数据库schema、插件manifest hostApiVersion、插件buildDigest是不同版本维度；使用目标接口和实际返回判断，不硬编码“schema2必有某插件”。
- 原生Google登录当前只有浏览器交易/callback合同，没有原生code/token换会话或深链交还端点；不能把浏览器打开URL等同应用已经登录。
- Subsonic协议ID、认证及歌词字段与宿主REST不同。官方客户端优先本合同，不能混用album/artist ID。
- 函数导出、SDK内部工具、旧单文件handler、测试fixture或静态Demo并不是公开HTTP接口。本目录只列从真实入口可达的宿主路径，不复活已退役功能。

本轮未给系统新增离线下载、跨设备队列、公开分享、原生OAuth交换、完整时间线历史或个性化推荐合同。完整列出现有能力与任意新产品功能无界扩张是不同范围；后续新增系统能力时在此增补稳定合同，不再按某个前端页面另裁一套接口。

## 维护与代码依据

实际入口：[flaretune.js](src/flaretune.js)、[HTTP路由](src/instance/httpRouter.js)、[访问策略](src/instance/accessPolicy.js)、[请求安全](src/instance/httpSecurity.js)。文档按模块连接到实际处理器；内部执行/验证记录不进入这份公开合同。

修改宿主外部行为时同步相应章节，保留兼容字段并更新针对性测试。新建路由需在真实dispatcher接线并验证权限；仅增加文档或导出函数不算实现。客户端功能设计及迭代记录由各客户端仓库维护。
