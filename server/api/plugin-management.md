# 宿主插件管理与构建交付 API

源码盘点基线：`3d0076d8431e8cb9501c5029d1af55bddb40ac9a`（2026-11-12）。本页覆盖宿主安装、来源、选包、构建交付和机器构建通道，不展开插件私有业务或设备输出业务。公共认证见 [API索引](../API.md)，管理接口另见 [administration.md](administration.md)。未在本次重新执行测试或部署。

真实接线：[Worker](../src/flaretune.js) → [httpRouter](../src/instance/httpRouter.js) → [plugins路由](../src/routes/plugins.js) / [pluginDelivery路由](../src/routes/pluginDelivery.js)。实现为 [registry](../src/plugins/registry.js)、[delivery](../src/plugins/delivery.js) 和 [共享目录合同](../../shared/plugins/delivery.js)。

## 1. 权限、CAS与错误

`/api/admin/**` 需要ready实例、正常管理员会话；`GET /api/account/plugins` 需要本人正常会话。管理写请求需Origin、`X-Requested-With: FlareTune`、`X-CSRF-Token`，建议带Expected-Account；JSON对象≤8192字节。服务会在存储提交时重新校验真实会话/角色，不能仅靠页面可见性授权。

响应直接是DTO，不使用统一ok/data包装。错误通常 `{error:string,...publicDetails}`，外层可能先返回401、403、409 account_changed或503实例状态。revision为非负安全整数，且revision+1仍须为安全整数；从最新GET取得，不要与安装记录revision混用。多数管理写入只允许所列字段及revision，未知字段400 `invalid_input`。

安装记录revision与delivery revision是两套CAS。前者用于第2节PUT单插件安装；后者用于第3节所有来源、选包、构建配置与动作。构建机器端点不使用Cookie认证，见第6节。

## 2. 已编译插件与安装记录

| METHOD + path | 请求 | 响应/权限 |
| --- | --- | --- |
| `GET /api/account/plugins` | 无body | `{plugins:PluginStatus[],dependencyInstalledIds?:string[]}`，本人正常会话 |
| `GET /api/admin/plugins` | 无body | 同结构，管理员可看编译目录 |
| `PUT /api/admin/plugins/{pluginId}` | `{installed:boolean,revision:number}` | `{plugin:PluginStatus}`，管理员 |

pluginId路径匹配 `[a-z][a-z0-9-]*`，且必须存在于实际编译目录。账户列表只含已安装且角色可见的插件；dependencyInstalledIds只用于必要依赖解析，不授予读取依赖私有配置的能力。管理员能管理安装，不因此得到仅成员业务权限。

```ts
type PluginStatus = {
  id:string;
  version:string;
  installed:boolean;
  revision:number;
  manifestDigest:string; // 64位lowercase SHA-256
  buildDigest:string|null;
  availability:Availability;
};
type Availability = {
  available:boolean;
  reason:string|null;
  issues:{code:string;pluginId?:string;dependencyId?:string;[key:string]:unknown}[];
  optionalFeatures:Record<string,{available:boolean;reason:string|null;dependencyId:string}>;
};
```

`installed=true`不保证availability.available。依赖、宿主API、数据迁移和部署确认都可能阻止可用性。reason包括依赖/循环/版本兼容，以及 `deployment_pending,data_version_incompatible,data_migration_required,dependency_unavailable` 等；应展示解释，不能忽略问题强行调用。

PUT只作用于已编译代码的安装状态，不下载远程代码。启用时验证依赖及数据版本、应用插件增量迁移并原子提交；禁用被其他插件必需的依赖会409 `PLUGIN_REQUIRED_BY`附dependents。安装重新取得epoch使旧调用失效；卸载保留插件数据/私人配置。新安装UI语言从Accept-Language取首选，支持zh/zh-Hant/en/ja/ko，其他回退en；同安装的更新保留原语言。不提供从body任意覆盖安装语言的字段。

```http
PUT /api/admin/plugins/example-plugin
Origin: https://music.example.com
X-Requested-With: FlareTune
X-CSRF-Token: <csrfToken>
X-FlareTune-Expected-Account: <accountId>
Cookie: __Host-ft_session=<session>
Accept-Language: zh-CN
Content-Type: application/json

{"installed":true,"revision":0}
```

安装特定错误：404 `PLUGIN_NOT_FOUND`；409 `PLUGIN_REVISION_MISMATCH/PLUGIN_REQUIRED_BY/PLUGIN_DEPENDENCY_CYCLE/PLUGIN_HOST_INCOMPATIBLE/PLUGIN_DEPENDENCY_INCOMPATIBLE/PLUGIN_DEPENDENCY_MISSING/PLUGIN_DEPENDENCY_UNAVAILABLE/PLUGIN_DATA_VERSION_UNSUPPORTED/PLUGIN_MIGRATION_FAILED`；403 forbidden。错误可能附availability、dependents。冲突应刷新目录/安装状态。

## 3. 来源与交付管理方法表

本节全部管理员Cookie认证，响应均为 `DeliveryState`。除GET外每个请求都要求delivery revision。

| METHOD + path | 精确JSON字段 | 行为 |
| --- | --- | --- |
| `GET /api/admin/plugin-delivery` | 无 | 读取来源、目录、实际运行/待应用及构建状态 |
| `PUT /api/admin/plugin-delivery` | `{revision,mode?,deployHookUrl?,buildToken?}` | 配置manual/auto及加密构建连接 |
| `POST /api/admin/plugin-delivery/sources` | `{revision,url}` | 获取并验证公开目录后新增来源 |
| `POST /api/admin/plugin-delivery/sources/{sourceId}/refresh` | `{revision}` | 刷新来源；失败状态也可能以HTTP200返回 |
| `DELETE /api/admin/plugin-delivery/sources/{sourceId}` | `{revision}` | 移除来源；不能删除official |
| `PUT /api/admin/plugin-delivery/selection` | `{revision,pluginId,installed,sourceId?,version?,trustCode?}` | 修改待应用精确目标；auto模式可能触发构建 |
| `POST /api/admin/plugin-delivery/build` | `{revision}` | 对待应用组合创建冻结计划并触发外部构建 |
| `POST /api/admin/plugin-delivery/build/resolve` | `{revision,confirmedStopped:true}` | 解决尚未部署的超时/未知结果；不向外部提供商发取消请求 |
| `POST /api/admin/plugin-delivery/discard` | `{revision}` | 清除待应用选择，保留当前运行 |

sourceId路径为 `[a-zA-Z0-9-]{1,80}`。mode可选 `manual|auto`；deployHookUrl、buildToken为string，省略保留、空串清除；不要传null。

selection字段：pluginId string、installed boolean必需；sourceId/version为可选string，客户端应发送用户选择的精确来源和版本。选中artifact时trustCode必须严格true。installed=false移除待应用组合中的插件，若不存在则404；依赖不完整时拒绝。版本为严格三段非负安全整数，不含预发布/构建后缀。字段未给时服务端会按当前归属/编译目录推断，不应依赖这种推断实现跨来源选择。

## 4. 交付、来源和目录 DTO

```ts
type DeliveryState = {
  revision:number;
  settings:{
    mode:"manual"|"auto";
    hookConfigured:boolean;
    buildTokenConfigured:boolean;
    needsReconnect?:true;
  };
  sources:SourceSummary[];
  catalog:PluginRow[];
  running:PluginRow[];
  desired:PluginRow[];
  pending:{id:string;operation:"install"|"uninstall"|"update";fromVersion:string|null;toVersion:string|null}[];
  build:null|BuildSummary;
};
type SourceSummary = {
  id:string;name:string;url:string;official:boolean;
  status:"unpublished"|"ready"|"error";
  error:string|null;updatedAt:number|null;
};
type PluginRow = {
  id:string;version:string;manifest:PluginManifest;
  sourceId:string;sourceName:string;source:PluginSource;
};
type PluginSource =
  | {type:"artifact";id:string;url:string;sha256:string}
  | {type:"workspace";id:string;sourceDigest:string|null};
type BuildSummary = {
  id:string;planDigest:string;
  status:"triggering"|"queued"|"building"|"deploying"|"rolling_back"|"activation_pending"|"failed"|"deployed"|"cancelled";
  createdAt:number;updatedAt:number;error:string|null;
  resultUnknown:boolean;deploymentStarted:boolean;providerBuildId:string|null;
};
```

时间均毫秒。catalog是可发现的精确版本行，不是“一插件一运行记录”；相同id可能有多个版本/来源。running为实际已安装组合；内部desired=null时，公开desired以running补齐，因此判断待应用用pending，不靠数组是否存在。sources响应不内嵌catalog；目录行集中在catalog。

目录远程JSON格式：

```ts
type PluginDirectory = {
  schemaVersion:1;
  id:string; // [a-z][a-z0-9-]{0,79}
  name:string; // trim后非空，输入length<=120
  plugins:{manifest:PluginManifest;artifact:{url:string;sha256:string}}[];
};
```

最多16来源（含official），单个目录≤524288字节、≤128项，同一目录id@version不可重复。来源URL是管理员提供的地址，不由目录id决定；新增sourceId由URL摘要生成。official来源当前固定为公开官方repository.json，初始化可能unpublished，不是空目录加载成功的同义词。

`PluginManifest`是宿主原样保留的声明元数据，不包含插件配置/凭据，移动端不能把页面声明当作原生运行代码。完整验证来源为 [manifest.js](../../shared/plugins/manifest.js)，客户端至少应保留下列字段：

```ts
type Role = "admin"|"member";
type Declaration = {roles?:Role[];access?:"admin"|"authenticated"};
type PluginManifest = {
  id:string;version:string;hostApiVersion:number;apiVersion:number;dataVersion?:number;
  name:string;description:string;introduction?:string[];icon:string;
  pages:PluginPage[];entries:PluginEntry[];
  capabilityRoles?:Role[];
  supportedLocales?:string[];defaultLocale?:string;
  metadata?:Record<string,{name:string;description:string;introduction?:string[]}>;
  messages?:Record<string,Record<string,string>>;
  dependencies?:Record<string,Dependency>;
  optionalDependencies?:Record<string,Dependency>;
  serviceConfigurations?:Record<string,string[]>;
  [key:string]:unknown;
};
type PluginPage = Declaration & {
  id:string;kind:"settings"|"service";label?:string;labelKey?:string;icon:string;
  scope?:"account"|"instance";
  playerPlacement?:"inherit"|"sidebar";presentation?:"standard"|"workspace";
  group?:string;groupLabel?:string;
};
type PluginEntry = Declaration & {
  id:string;slot:"sidebar.primary"|"sidebar.settings.admin"|"sidebar.secondary"|"menu.song"|"menu.player";
  label?:string;labelKey?:string;icon:string;order:number;
  page?:string;action?:string; // 严格二选一
  group?:string;when?:("song"|"playing"|"output")[];feature?:string;
};
type Dependency = {apiVersion:number;version?:string;features?:string[]};
```

标识符 `[a-z][a-z0-9]*(?:-[a-z0-9]+)*`、≤80字符；manifest canonical JSON≤65536字符、嵌套深度≤20。hostApiVersion/apiVersion为正安全整数，dataVersion为非负安全整数；当前宿主插件API版本3。name/description/文本标签非空且≤512字符；introduction为1..6段、每段非空≤1500字符。pages/entries需数组且各自ID唯一；page不能使用宿主保留overview。roles为1..2个唯一角色；旧access若同时提供必须与roles一致。instance设置页仅admin。locale仅zh/zh-Hant/en/ja/ko；声明多语言时需完整supportedLocales/defaultLocale/metadata，各语言提供name/description，labelKey需对应messages。依赖版本允许精确、~或^三段版本；可选feature不能重复；serviceConfigurations最多16 provider、每provider1..16槽位、总数≤32且provider须为声明依赖。

### 来源和代码信任边界

来源及artifact URL要求公开HTTPS域名、≤2048字符；禁止凭据、fragment、显式非默认端口、字面IP、localhost/保留内网后缀及已列出的本地解析域名。不跟随redirect，credentials=omit，fetch10秒超时。URL验证不是“插件代码已安全”的证明；artifact SHA256确保固定字节，trustCode代表管理员本次显式信任代码。

添加来源不安装插件；刷新来源不自动更新已运行包；删除来源不等于卸载插件。当前归属来源锁定，不能通过另一来源接管同id；同源普通更新不能降级或以不同artifact替换同版本。已选未应用的新安装目标也受该保护。

### 配置及执行流程

deployHookUrl仅支持 `https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/{16..160位A-Za-z0-9_-}`，无query。buildToken需32..256位 `[A-Za-z0-9_-]`。两项加密保存且只写，GET仅返回configured状态；秘密轮换导致无法解密时needsReconnect=true，同时显式重填两项可修复连接。auto必须同时配置两项。

manual：selection只保存desired，管理员显式build后触发。auto：显式selection形成差异后触发；不会因为来源目录出现新版本就自动选中。一个计划最多32插件，必须满足宿主及依赖版本约束。

build会冻结host、插件manifest及精确artifact来源，调用外部Hook；HTTP200不保证构建成功。例如未配置连接时响应build.status=failed、error=PLUGIN_BUILD_NOT_CONFIGURED。客户端应轮询DeliveryState。真实部署元数据及计划指纹匹配并原子激活前，running不冒充desired。

活跃状态triggering/queued/building/deploying/rolling_back/activation_pending超过30分钟对公开状态显示failed、resultUnknown=true、error=PLUGIN_BUILD_RESULT_UNKNOWN。超时不证明外部任务已停。编辑被锁；未进入部署的未知任务可在管理员真实确认停止后resolve为cancelled。进入部署的不确定任务不能用resolve/discard绕过，需构建通道确认部署/回滚结果。

```http
POST /api/admin/plugin-delivery/sources
<正常管理员Origin/CSRF/Cookie请求头>
Content-Type: application/json

{"revision":2,"url":"https://plugins.example.org/repository.json"}
```

```http
PUT /api/admin/plugin-delivery/selection
<正常管理员Origin/CSRF/Cookie请求头>
Content-Type: application/json

{"revision":3,"pluginId":"example-plugin","installed":true,"sourceId":"source-<URL摘要>","version":"1.2.3","trustCode":true}
```

```http
POST /api/admin/plugin-delivery/build
<正常管理员Origin/CSRF/Cookie请求头>
Content-Type: application/json

{"revision":4}
```

这些revision仅说明流转示例，每一步都须用上一步真实响应的revision。configure示例应由运维端填入Hook/Token，普通移动客户端不应收集这些字段。

## 5. 框架错误与私有业务边界

| HTTP | 典型error及应对 |
| --- | --- |
| 400 | invalid_input、PLUGIN_URL_INVALID、PLUGIN_SOURCE_INVALID、PLUGIN_SOURCE_TOO_LARGE、PLUGIN_SOURCE_LIMIT、PLUGIN_SELECTION_LIMIT、PLUGIN_CODE_TRUST_REQUIRED、PLUGIN_DEPLOY_HOOK_INVALID、PLUGIN_BUILD_NOT_CONFIGURED、PLUGIN_BUILD_RESOLUTION_REQUIRED |
| 403 | forbidden；真实管理员会话已撤销也可能发生 |
| 404 | PLUGIN_NOT_FOUND、PLUGIN_SOURCE_NOT_FOUND、PLUGIN_NOT_SELECTED、not_found |
| 409 | PLUGIN_DELIVERY_CHANGED、PLUGIN_SOURCE_EXISTS、PLUGIN_OFFICIAL_SOURCE_REQUIRED、PLUGIN_SOURCE_CONFLICT、PLUGIN_SELECTION_INCOMPATIBLE、PLUGIN_VERSION_NOT_NEWER、PLUGIN_BUILD_IN_PROGRESS、PLUGIN_BUILD_RESULT_UNKNOWN、PLUGIN_DEPLOYMENT_UNCONFIRMED、PLUGIN_NO_PENDING_CHANGES |
| 502 | PLUGIN_SOURCE_UNPUBLISHED、PLUGIN_SOURCE_UNAVAILABLE；刷新已有来源时可能改为状态字段而非HTTP错误 |
| 503 | service_unavailable、PLUGIN_DELIVERY_STATE_INVALID、PLUGIN_BUILD_HOST_UNKNOWN及加密配置恢复失败等 |

非上述码应保留error并安全展示，不按提示字符串重建错误码。存储秘密不回显，错误中不要记录Hook或Bearer。

`/api/account/plugins/{pluginId}/...`和`/api/admin/plugins/{pluginId}/...`是动态分发命名空间，不是所有子路径都由宿主实现。除名单/安装动作外，业务调用还需插件真实安装、角色可用及构建指纹；有buildDigest时请求必须带 `X-FlareTune-Plugin-Build: <buildDigest>`，不符409 `PLUGIN_BUILD_MISMATCH`。私有业务方法、配置字段和版本合同不在本页，不应从插件目录名称猜测。旧插件别名也不作为新增核心管理能力列出。

## 6. 机器构建通道：不是移动客户端 API

**以下Bearer是部署能力。移动客户端不得保存、内置或向用户索取buildToken，也不能以管理员Cookie替代它。** 这些端点由CI/构建执行器使用，可改变部署与安装生效组合。

`httpRouter`在普通Cookie解析/Origin/CSRF之前分发 `/api/plugin-build/**`：仍要求实例ready；认证唯一为：

```http
Authorization: Bearer <32..256位构建token>
```

POST JSON仍受8192字节对象parser限制。不存在普通会话CSRF头要求。

| METHOD + path | 请求 | 响应/副作用 |
| --- | --- | --- |
| `GET /api/plugin-build/snapshot` | 无body | BuildSnapshot；要求构建活跃或deployed |
| `GET /api/plugin-build/upgrade` | 无body | UpgradeState；导出当前精确运行组合和CAS指纹 |
| `POST /api/plugin-build/upgrade` | `{revision,registryRevision,fromHost,runningDigest,host}` | 为宿主升级保留当前artifact组合，创建冻结计划，返回BuildSnapshot；本动作不直接调用Hook |
| `POST /api/plugin-build/report` | `{buildId,planDigest,status}` | `{ok:true,status:string}`；推进/激活/确认回滚 |

```ts
type Host = {version:string;sourceDigest:string};
type SnapshotPlugin = {id:string;version:string;manifest:PluginManifest;source:PluginSource};
type BuildSnapshot = {
  schemaVersion:1;buildId:string;planDigest:string;host:Host;plugins:SnapshotPlugin[];
  buildStatus:string;
  baseDeployment:null|{buildId:string;planDigest:string};
  target?:{workerName:string};
};
type UpgradeState = {
  schemaVersion:1;revision:number;registryRevision:number;host:Host;plugins:SnapshotPlugin[];
  runningDigest:string;pending:boolean;
  build:null|{id:string;planDigest:string;status:string;host:Host;resultUnknown:boolean};
};
type UpgradeInput = {
  revision:number;registryRevision:number;fromHost:Host;runningDigest:string;host:Host;
};
type ReportInput = {
  buildId:string;planDigest:string;
  status:"building"|"deploying"|"rolling_back"|"activation_pending"|"failed"|"rolled_back"|"deployed";
};
```

Host只能含version、sourceDigest；version为严格三段非负安全整数，sourceDigest/runningDigest为64位lowercase SHA256。升级revision/registryRevision均非负安全整数，必须与导出状态一致；fromHost必须等于正在服务的宿主，runningDigest也须匹配。目标host不同且不得降版本。不能存在待应用选择、活跃任务或未解决的不确定结果；运行组合必须全部artifact，不能自动把workspace源码当独立包继承。不能在升级请求中修改插件选择。

report的buildId/planDigest必须匹配冻结计划。deployed不是“信任执行器口头成功”：宿主检查当前编译manifest、包来源、宿主与部署指纹，原子提交迁移/安装/delivery状态后才激活。host-upgrade保留原安装记录及epoch，不凭升级重置私人配置。回滚同样核对真实旧部署；deployment_started后的failed可能保持activation_pending/resultUnknown，不被普通失败结果消除。

```http
POST /api/plugin-build/report
Authorization: Bearer <CI专用token>
Content-Type: application/json

{"buildId":"<snapshot.buildId>","planDigest":"<snapshot.planDigest>","status":"building"}
```

机器端错误：403 forbidden；400 invalid_input；409 `PLUGIN_BUILD_CHANGED/PLUGIN_BUILD_NOT_ACTIVE/PLUGIN_DELIVERY_CHANGED/PLUGIN_UPGRADE_PENDING_CHANGES/PLUGIN_HOST_UNCHANGED/PLUGIN_HOST_DOWNGRADE_UNSUPPORTED/PLUGIN_UPGRADE_ARTIFACT_REQUIRED/PLUGIN_DEPLOYMENT_NOT_READY/PLUGIN_ROLLBACK_NOT_CONFIRMED/PLUGIN_BUILD_APPLY_FAILED`以及前述任务锁定错误；503宿主或服务不可用。report重复deployed也仍核验实际部署。

## 7. 本地测试入口与证据范围

- [registry.test.js](../src/plugins/registry.test.js)：列表、安装CAS、角色撤销、语言、真实HTTP调用。
- [registry.bulk.test.js](../src/plugins/registry.bulk.test.js)、[framework.test.js](../src/plugins/framework.test.js)、[context-role.test.js](../src/plugins/context-role.test.js)：框架、依赖及角色隔离。
- [delivery.test.js](../src/plugins/delivery.test.js)：目录、秘密、信任、manual/auto、冻结计划、未知结果与激活。
- [host-upgrade.test.js](../src/plugins/host-upgrade.test.js)：机器Bearer、跨宿主保全、CAS与真实部署确认。
- [共享manifest合同](../../shared/plugins/manifest.js)、[目录合同](../../shared/plugins/delivery.js)为字段与验证实现来源。

这些链接说明已有测试位置，不代表文档编写时重新运行或真实云部署已通过。无路由的legacy helper不列为API；此页不承诺运行时热安装或插件私有业务兼容。
