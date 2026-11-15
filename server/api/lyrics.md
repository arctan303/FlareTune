# 统一歌词 API：客户端接入合同

本文是宿主统一歌词读取、翻译与来源排序的详细合同。客户端直接接入本页四个接口，无需自行调用歌词工作台或 YouTube 插件的私有业务接口。认证登录过程见 [API 总览](../API.md)；实例共享音乐数据见 [音乐接口](music.md)。

核验基线为 `3d0076d` 及本轮本地改动。本文描述当前源码行为，不代表已部署到某个实例。JSON 示例使用合成歌词和文档测试身份，通过当前标准文档/统一来源链代码生成，未访问在线歌词服务；示例引用不可用于真实实例。

## 1. 端点和认证

| METHOD | 路径 | 权限与用途 |
| --- | --- | --- |
| GET | `/api/lyrics?songId={id}&resultRef={optional}` | 普通成员/管理员；首次读取或轮询同一结果 |
| POST | `/api/lyrics/translation` | 普通成员/管理员；对自己已取得的结果请求翻译 |
| GET | `/api/lyrics/sources/order` | 普通成员/管理员；枚举当前有效来源与顺序 |
| PUT | `/api/lyrics/sources/order` | 管理员；修改实例级来源顺序 |

每次请求要求实例 `ready`、有效 Cookie 会话、正常模式和有效账号；强制改密模式拒绝。POST/PUT 按总览带同实例 `Origin`、`X-Requested-With: FlareTune`、`X-CSRF-Token`、`Content-Type: application/json`。建议 GET 和写入均带 `X-FlareTune-Expected-Account`，防止旧页面在切换账号后接收错误上下文。

`Accept-Language` 可影响安全错误文案和来源显示信息；它不是翻译目标选择参数。四个接口均 `Cache-Control: private, no-store`。

实际调用链：

```text
flaretune.js fetch
  → instance/httpRouter.js handleApi / handleApiInternal
    → 实例、Cookie 会话、访问策略、来源/CSRF、Expected-Account
    → lyricSourceRoutes.js: translation / sources/order
    → localMetadataRead.js: GET lyrics
      → resolveLyricSong → readLyricsFromChain
```

源码：[Worker 入口](../src/flaretune.js)、[HTTP 路由](../src/instance/httpRouter.js)、[访问策略](../src/instance/accessPolicy.js)、[歌词读取路由](../src/routes/localMetadataRead.js)、[翻译/排序路由](../src/routes/lyricSourceRoutes.js)、[来源链](../src/services/lyricSourceChain.js)。

## 2. GET /api/lyrics

### 请求

```http
GET /api/lyrics?songId=example-song
Cookie: <实例会话 Cookie>
X-FlareTune-Expected-Account: <当前账号 ID>
Accept-Language: zh
```

| 查询参数 | 约束 |
| --- | --- |
| `songId` | 必填且只出现一次；1–128 个 JS 字符；无首尾空白、斜线、反斜线、控制字符；不能为 `.` / `..` |
| `resultRef` | 可选，最多一次；原样传回上次成功结果中的不透明字符串 |

拒绝额外查询字段和重复字段，返回 400。不带 `resultRef` 按当前来源顺序选择结果；带 ref 只继续该结果，不在原结果失效后悄悄换源。查询值应通过 URL 查询参数构造器编码。

### HTTP 200：普通歌词结果

成功信封为 `{code:200,data:LyricV2}`，不要假设普通结果含 `status:"ready"`：本协议只有下述纯音乐分支带顶层 `status`。

```ts
type LyricV2 = {
  version: 2;
  source: string;
  format: "krc" | "lyricsfile" | "lrc" | "plain";
  syncMode: "word" | "line" | "none";
  lrc: string;
  lines: LyricLine[];
  providerMeta?: ProviderMeta;
  sourceId: string;
  resultRef: string;
  quality: "good" | "weak";
  translation: LyricTranslation;
  translationAvailable: boolean;
  translationState: LyricTranslation["state"];
  translationStartedAt: string | null;
  provenance: Record<string, unknown>;
  updatedAt?: string;
  offsetMs: number;
};
type LyricLine = {
  text: string;
  time?: number;
  endTime?: number;
  tlyric?: string;
  words?: { text: string; startTime: number; endTime: number }[];
};
type ProviderMeta = {
  translationLanguage?: string;
  providerLyricId?: string;
  matchedTitle?: string;
  matchedArtist?: string;
  matchedDuration?: number;
  durationDelta?: number;
  versionMismatch?: boolean;
};
type LyricTranslation = {
  supported: boolean;
  state: "idle" | "pending" | "ready" | "failed" | "unavailable" | "not_needed";
  lines?: string[];
  language?: string;
  targetLanguage?: string;
  source?: string;
  kind?: string;
  error?: { code: string; message: string };
};
```

翻译资格由服务端统一判断：纯音乐不取词；同目标语种返回`not_needed`，未知语种可在当前已获准的AI处理中判断，失败仍为`failed`。工作台缓存成功的无需翻译结论；更换歌词正文、目标、歌曲语言标签或规则后重新评估。混合歌词仅外语部分带译文。客户端只消费`translation.supported/state/lines`，不自行按歌曲标签或字符比例判断，也不因未知/失败推断无需翻译。此行为对应宿主API4及工作台0.3.3本地候选，未表示任一实例已经升级。

字段解释与边界：

| 字段 | 意义与客户端处理 |
| --- | --- |
| `version` | 当前固定 2；未知版本不能按现有结构盲目渲染 |
| `source` | 正文的原始来源，可为 `manual`、`youtube`、`lrclib`、`custom_krc`、`custom_lrc`、具名 `lyric_<32位十六进制>`、`plugin:<id>`；历史资产可能使用 `kugou` / `netease` |
| `sourceId` | 当前提供该结果的来源链提供者，如 `file`、`lyrics-workbench`、`youtube-music`；不等于正文 `source` |
| `format` | 文档原始格式；不能由 `lrc` 字段存在就判定仅逐行 |
| `syncMode` | `word` 逐词、`line` 逐行、`none` 无同步时间；缺词级时间时不伪造逐词 |
| `lrc` | 标准化兼容 LRC 文本；结构化 `lines` 保留更多词级时间信息 |
| `lines[].text` | 原文；可能包含同一时间合并后的换行；无时间字段时显示纯文本 |
| `time/endTime` | 行开始/结束的绝对歌曲时间，**秒**；endTime 可缺省 |
| `words[].startTime/endTime` | 词开始/结束的绝对歌曲时间，**秒**，不是相对该行，也不是毫秒 |
| `tlyric` | 旧格式可能携带的行内译文；统一来源链剥离未声明的内嵌层，完整翻译状态与配对层以 `translation` 为准 |
| `providerMeta` | 可选的安全匹配信息；匹配时长、偏差单位为秒；不要用作认证或稳定歌曲标识 |
| `quality` | 服务端来源选择的 `good` / `weak`；弱结果仍可阅读，不是请求失败 |
| `translationAvailable` | 严格等于 `translation.state === "ready"` |
| `translationState` | 顶层兼容镜像，与 `translation.state` 相同 |
| `translationStartedAt` | pending 时的 ISO 时间字符串，其他状态为 null；不是剩余耗时或完成承诺 |
| `updatedAt` | 可选 ISO 时间字符串；部分直接来源结果没有该字段 |
| `provenance` | 安全来源/评估元信息对象，可为空；已知可选项含 `managedBy/evaluation/originalSource/quality/assessmentKey/providerLyricId/matchedTitle/matchedArtist/matchedDuration`；客户端不依赖内部键完整性 |
| `offsetMs` | 已经应用到返回行/词时间的整数毫秒位移，范围 -5000–5000；**客户端不要再次叠加** |

标准化文档最多 2000 行、20000 词；行文本最长 4000 字符、词文本最长 500，时间范围 0–86400 秒。`words` 仅在时间与文本匹配有效时保留；客户端处理每行实际字段，不假设所有行都有同样同步精度。

### 译文的精确状态

| `state` | 意义与推荐动作 |
| --- | --- |
| `idle` | 当前还没有译文，可在 `supported=true` 时提供请求翻译操作 |
| `pending` | 正在处理，保留原文和结果引用，可有界轮询 GET |
| `ready` | 已有与当前原文配对的译文，使用 `translation.lines` |
| `failed` | 本次翻译失败，可能带安全 `error`；保持原文，可按支持情况显式重试 |
| `unavailable` | 当前来源/配置无法提供；不要把 200 当作翻译成功 |
| `not_needed` | 当前结果不需要译文，例如纯音乐或来源判定无需翻译 |

`supported` 表示该结果的翻译能力；不表示已经有译文。ready 必须 `supported=true`，并返回与原文 `lines` **长度和索引一致**的 `translation.lines`，其中个别条目可为空字符串，但不会全部为空。非 ready 不返回可使用的配对译文数组。译文不带独立时间轴，继承对应原文行时间，不生成译文逐词时间。

`language` 是已有译文语言，`targetLanguage` 是来源当前目标，均可缺省，`zh-CN` 等兼容标签可能出现。`source` 标识译文来源；`kind` 为来源提供的描述，已有资产使用 `machine/ai/manual/provider/unknown`，客户端容忍未知字符串。`error` 只在存在安全错误信息时出现，code 是有界机器码，message 用于显示。

### 完整 JSON 示例：逐词正文、已有译文与已应用偏移

下例由 `createLyricDocument`、`buildReadyLyricArtifact`、`readLyricsFromChain` 的合成 fixture 生成。原始行时间 1 秒，服务端应用 `offsetMs=250` 后返回 1.25 秒；`sourceId:file` 与 `source:manual` 同时出现是正确的。

```json
{
  "code": 200,
  "data": {
    "version": 2,
    "source": "manual",
    "format": "lrc",
    "syncMode": "word",
    "lrc": "[00:01.250]Hello world",
    "lines": [
      {
        "time": 1.25,
        "text": "Hello world",
        "endTime": 3.25,
        "words": [
          {"text": "Hello ", "startTime": 1.25, "endTime": 2.25},
          {"text": "world", "startTime": 2.25, "endTime": 3.25}
        ]
      }
    ],
    "sourceId": "file",
    "resultRef": "eyJzb3VyY2VJZCI6ImZpbGUiLCJzb25nSWQiOiJleGFtcGxlLXNvbmciLCJ0ZXh0SGFzaCI6IjY0ZWM4OGNhMDBiMjY4ZTViYTFhMzU2NzhhMWI1MzE2ZDIxMmY0ZjM2NmIyNDc3MjMyNTM0YThhZWNhMzdmM2MiLCJkb2N1bWVudEhhc2giOiJkNDlkYjIwNTIwMjliMjk5ZTdmZDc4YmQwYTY4OTRkODgyZjMzMDhiZTY3MWU5YjEzNGU5NDVlNzQxNDdmODNiIiwidHJhbnNsYXRpb25UYXJnZXQiOiJ6aCIsImVwb2NoIjoiYnVpbHRpbiIsImJ1aWxkIjoiYnVpbHRpbiIsImFjY291bnRJZCI6ImRvY3VtZW50YXRpb24tYWNjb3VudCIsInNlc3Npb25IYXNoIjoiMTQ1MWFhNjliNmY4ZmI2NTlmNmY4M2E1MTBiMTExZTI4NzgzOWYzMDllZTcyNGJjMmRhMjFjZGUwMzE5YWVhNCIsImV4cGlyZXNBdCI6MTc5NDUzMjM0NTM2M30.5MvgFuL8y__y3nYz574_10zE-gHvXU5XqG_c6rvDNZA",
    "quality": "good",
    "translation": {
      "supported": true,
      "state": "ready",
      "lines": ["你好，世界"],
      "language": "zh",
      "targetLanguage": "zh",
      "source": "manual",
      "kind": "manual"
    },
    "translationAvailable": true,
    "translationState": "ready",
    "translationStartedAt": null,
    "provenance": {},
    "updatedAt": "2026-11-12T00:00:00.000Z",
    "offsetMs": 250
  }
}
```

### 纯音乐与无歌词

纯音乐是 HTTP 200 的**独立联合分支**，完整形状如下。此分支没有 `resultRef/sourceId/quality/lrc/offsetMs/translationStartedAt` 等普通结果字段，也无需调用翻译：

```json
{
  "code": 200,
  "data": {
    "version": 2,
    "status": "not_needed",
    "reason": "instrumental",
    "source": null,
    "format": null,
    "syncMode": "none",
    "lines": [],
    "translation": {"supported": false, "state": "not_needed"},
    "translationAvailable": false,
    "translationState": "not_needed"
  }
}
```

存在歌曲而没有采用到可用歌词，HTTP **404**：

```json
{"code":404,"data":null,"message":"No lyrics found","reason":"lyrics_not_found"}
```

歌曲不存在/已删除为另一种 404：

```json
{"code":404,"message":"Song not found","reason":"song_not_found"}
```

无歌词结果不返回普通成功空数组。来源链会跳过失败/空结果并尝试后续来源；有可用的 `good` 或 `weak` 结果时仍返回正文。最终没有可用结果且存在来源初始化、获取、超时或采用失败时返回 **503**，不会伪装成 `lyrics_not_found`；只有全部正常返回空或不认领时才返回无歌词。5xx 失败不能作为确定无歌词长期缓存。

## 3. resultRef、轮询与恢复

`resultRef` 是服务器签发的不透明短期引用，绑定：当前账号、当前会话、歌曲、提供者 ID、安装 epoch/build、原文摘要、文档/偏移摘要和翻译目标。有效期为签发后 **12 小时**；后续成功读取可能签发更新引用，请保留最近响应的值。

它不是永久歌曲标识，不能跨账号/登录会话复用，不能自行拼接或修改。规范输入最长 8500 字符，形状为两段 base64url 加一个点，但客户端不需解码。请求中不能用引用携带任意待翻译正文。

建议流程：

1. 进入播放器用当前 `songId` GET，不带 ref，记录账号/歌曲/请求代次。
2. 保存返回的 ref 与对应正文；纯音乐、404 等分支按实际状态显示。
3. `translation.state=pending` 时，用同一 `songId` 和当前 ref 有界轮询 GET；离开页面、切歌、退出或切换账号时取消请求并丢弃旧响应。
4. 用户请求翻译时仅 POST 当前 ref；随后按返回状态更新；pending 可继续 GET。
5. 409 `LYRIC_RESULT_RETIRED` / `LYRIC_RESULT_CHANGED` 时丢弃旧 ref，不带 ref 重新 GET；400 `LYRIC_RESULT_INVALID` 不无条件重放同一个错误值。

ref 请求只继续原来源；原来源退役不会自动换源。来源/正文/偏移/译文目标变化都可能要求重新获取。409 也可能是外层 `account_changed`，先处理账号上下文，不能把另一个账号的数据接回旧页面。

GET 可能依据实例自动获取/翻译策略触发来源工作和安全资产保存，并非承诺纯数据库读取。服务端没有固定轮询周期、完成时限或无限自动重试合同；客户端应保留原文、显示当前状态并限制轮询生命周期。

## 4. POST /api/lyrics/translation

```http
POST /api/lyrics/translation
Content-Type: application/json
Origin: https://<实例域名>
X-Requested-With: FlareTune
X-CSRF-Token: <会话 CSRF token>
X-FlareTune-Expected-Account: <当前账号 ID>
Cookie: <实例会话 Cookie>

{"resultRef":"<GET 返回的完整引用>"}
```

JSON 上限 **12288 字节**，必须是对象，**只允许** `resultRef:string`。不接受 `songId`、`text`、目标语言或任意额外字段。翻译目标遵循当前来源/实例配置，普通成员可请求其有效会话结果，不要求管理员。

正常 HTTP 200 返回与 GET 相同的 `{code:200,data:LyricV2}`。不额外使用 202/任务 ID；应检查 `translation.state`，200 不保证 ready。已有 ready/not_needed 结果不重复强制生成，来源不支持时可以仍为 unavailable，实际失败可仍由结果中的 failed 表示。

请求会先验证 ref 归属和时效，再验证原来源与正文仍一致。歌曲已删除为 404；权限/状态/ref 错误见下一节。不能把其他实例/账号/旧会话的引用交给此接口。

## 5. GET /api/lyrics/sources/order

成功直接返回对象，**不是** `code/data` 信封：

```ts
{
  order: string[];
  revision: number;
  sources: {
    id: string;
    name: string;
    metadata?: Record<string, unknown>;
    enabled: true;
  }[];
}
```

`order` 已过滤退役/不可用来源并追加当前新增来源；`sources` 只列当下可用、启用、角色可见的来源。`metadata` 可含语言键和 `{name,...}` 本地化信息，客户端允许未知元数据。内建 file source 当前名称是 `File`，metadata 提供本地化名称；不能假设顶层名称一定随语言改变。

仅 file 的完整源码生成示例：

```json
{
  "order": ["file"],
  "revision": 0,
  "sources": [
    {
      "id": "file",
      "name": "File",
      "metadata": {
        "zh": {"name": "歌词文件"},
        "zh-Hant": {"name": "歌詞檔案"},
        "en": {"name": "Lyric files"},
        "ja": {"name": "歌詞ファイル"},
        "ko": {"name": "가사 파일"}
      },
      "enabled": true
    }
  ]
}
```

默认排序候选为 `lyrics-workbench → youtube-music → file`，但不是每个实例的实际返回列表，客户端必须使用 GET 结果。

## 6. PUT /api/lyrics/sources/order

只允许**管理员**修改实例级配置。它不是个人偏好，不通过传账号 ID 选择作用域。

```json
{"order":["file"],"expectedRevision":0}
```

JSON 上限 **8192 字节**，只允许 `order`、`expectedRevision`。`order` 必须包含 GET 返回的全部当前可用来源，各一次，最多 33 个；每个 ID 符合 `[a-z][a-z0-9-]{0,79}`。`expectedRevision` 是当前非负整数。示例只适用于当前可用集合恰好为 file 的实例，不能拿它覆盖真实多来源配置。

成功为 HTTP 200，返回与 GET 相同的完整对象和新修订号。来源集合在读取和保存间变化会导致 400；陈旧修订号为 409 `revision_conflict`，先重新 GET 后保留用户排序意图；非管理员 403。前置结构错误可以仅返回 `{error:"invalid_input"}`，其余捕获错误通常使用下一节歌词错误信封。

## 7. 失败响应

通用外层错误可能先于歌词业务返回 `{error:string}`；业务错误也不保证每个可选字段同时存在。成功与错误均以 HTTP 状态为第一判断依据，安全 `message` 可能本地化，不能作为机器码。

| HTTP | 代表性字段/错误码 | 处理 |
| --- | --- | --- |
| 400 | `code:400,message`；`LYRIC_RESULT_INVALID`；`invalid_input` | 修正查询、body、来源集合或引用；不要重复发送同一错误值 |
| 401 | 外层 `authentication_required` | 恢复登录 |
| 403 | 外层 `forbidden/csrf_rejected`；歌词 `forbidden` 等 | 检查模式、角色、请求来源/CSRF、来源权限 |
| 404 | `reason:song_not_found` | 歌曲不存在/删除，不再请求该内容 |
| 404 | `reason:lyrics_not_found,data:null` | 当前未取得可用歌词，显示无歌词 |
| 405 | 不支持的方法 | 校验 METHOD；GET lyrics 常为 `{code:405,message}`，来源排序可能为 `{error:"method_not_allowed"}` |
| 409 | `LYRIC_RESULT_RETIRED` / `LYRIC_RESULT_CHANGED` | 丢弃 ref，重新 GET 原文 |
| 409 | `revision_conflict` | 来源排序版本冲突，重新读取排序 |
| 409 | 外层 `account_changed` | 当前账号已切换，清理旧请求上下文 |
| 500 | GET 未分类内部错误 | 保留页面状态，允许稍后重试 |
| 502 | `message:Stored lyric asset is invalid` 等资产错误 | 不当作无歌词或空文档 |
| 503 | `reason:source_unavailable`、存储/来源/配置/预算不可用或 `LYRIC_SERVICE_UNAVAILABLE` 等 | 保留原文与未完成状态，稍后有界重试 |

典型 ref 失败：

```json
{"code":409,"error":"LYRIC_RESULT_RETIRED","message":"歌词结果已更新，请重新加载。"}
```

POST/排序路由捕获的未知服务错误通常为 `{code:503,error:"LYRIC_SERVICE_UNAVAILABLE",message:...}`；GET 还可能使用仅 code/message 的错误。不要把所有失败强行反序列化成普通 `LyricV2`。

## 8. 能力依赖和插件边界

宿主统一入口、结果引用、来源选择和排序合同是现成能力，实际内容依赖当前来源：

- `file` 是内建来源，读取既有歌词资产，需要有效媒体存储绑定；签发 ref 需要 `SETUP_SECRET` 至少 32 字符。
- 在线搜词/评估、YouTube 原生歌词等需要相应插件安装、启用、角色可见、连接和功能开关。缺插件不代表缺少统一 `/api/lyrics` 路由。
- AI 译文还依赖来源支持、AI 网关/模型与实例策略。界面按 `supported/state` 开放操作，不按插件名假定支持。
- 来源链优先采用 good 结果，保留 weak 回退；自动流程受权限、取消和版本校验，客户端不应自己覆盖共享歌词资产。
- 工作台 `/api/lyrics/workspace/*`、插件账户工作区、候选编辑/导入、在线来源配置等是可选插件业务，不在本页扩展；`/api/lyrics/sources` 不是本文来源排序路径。

## 9. 验证证据与命令

以下是对应源码和目标测试来源：

| 测试 | 重点 |
| --- | --- |
| [localMetadataRead.test.js](../src/routes/localMetadataRead.test.js) | 歌词读取、纯音乐/不存在、资产错误与旧读取兼容；部分 fixture 使用兼容 reader，不能单独代替真实 HTTP 来源链证据 |
| [lyricSourceChain.test.js](../src/services/lyricSourceChain.test.js) | 来源优先级、配对译文、ref 签名/归属/过期、固定结果轮询、偏移与内容变化 |
| [lyricSourceChain.integration.test.js](../src/services/lyricSourceChain.integration.test.js) | 真实来源工厂/宿主投影、已有译文保全、延迟初始化、epoch 和权限边界；测试禁止外部 fetch |
| [lyricSourceChain.cancellation.test.js](../src/services/lyricSourceChain.cancellation.test.js) | 超时/取消与授权失效后不得继续持久化 |
| [lyricDocument.test.js](../src/utils/lyricDocument.test.js) | 行/词时间、文档规范化与同步降级 |
| [playbackLyrics.external.test.js](../src/services/playbackLyrics.external.test.js)、[playbackLyrics.native.test.js](../src/services/playbackLyrics.native.test.js) | 可选外部歌曲和原生歌词兼容边界 |
| [httpBudget.test.js](../src/plugins/lyrics-workbench/httpBudget.test.js) | 从真实 Worker 入口调用统一 GET/POST，成员翻译、CSRF、外来 ref、144 行处理预算和恢复；使用准备好的可选插件包及本地 fixture，不证明线上上游可用性 |

```powershell
node --experimental-sqlite --test server/src/routes/localMetadataRead.test.js server/src/services/lyricSourceChain.test.js server/src/services/lyricSourceChain.integration.test.js server/src/services/lyricSourceChain.cancellation.test.js server/src/utils/lyricDocument.test.js server/src/services/playbackLyrics.external.test.js server/src/services/playbackLyrics.native.test.js server/src/plugins/lyrics-workbench/httpBudget.test.js
```

本轮本地验证（2026-11-12）：上述 8 个目标文件 **125/125 通过**，0 失败/跳过，日志为仓库忽略目录 `output/api-contracts-20261112/lyrics-target-tests.log`。另用既有真实 SQLite/登录 fixture 经过公开 Worker 入口完成来源排序 8 项临时烟测：管理员 GET、成员 GET、成员 PUT 403、管理员 PUT/修订推进、陈旧修订 409、不完整集合 400、无会话 401、无效 CSRF 403，均通过；它们未计入 125 个持久化测试。本文逐词、纯音乐和来源排序的 3 个完整响应示例还通过源码重新生成后的逐字段相等校验。

这些验证没有调用真实第三方歌词或 AI 服务，不是在线部署回读，也不保证线上来源已经正确安装或配置。
