# 宿主音乐、个人歌单、统计、歌词与媒体 API

本文面向独立客户端开发，描述 FlareTune 宿主实际接线的接口。认证、实例状态、Cookie、CSRF、账号上下文和通用错误先见 [API 总览](../API.md)。本文件依据 `3d0076d` 及本轮本地接口完善后的源码核验；不代表相同版本已部署，也不表示下文列出的所有历史测试在本次重新执行。

范围是实例共享曲库、当前账号的个人音乐数据和宿主统一歌词入口。小爱音箱、YouTube Music、漫游、歌词工作台等插件的专属业务接口不在此展开。宿主路径存在不保证可选歌词源或外部音源已安装、启用、连接和配置。

## 1. 接入约定与端点索引

所有下列端点都要求实例 `ready`、有效普通会话；强制改密状态不能访问音乐业务。`/api/lyrics/sources/order` 的 PUT 还要求管理员身份。个人歌单、唱片架、收藏和播放统计始终按服务端验证的当前账号隔离，请求体不能选择账号。

成功信封有三种，不能用一个固定的 `code === 200` 判断全部接口：

| 类别 | HTTP 成功状态 | JSON 外形 |
| --- | --- | --- |
| 曲库、发现、统一歌词 | 200 | `{ "code": 200, "data": ... }` |
| 个人音乐 | 200；创建歌单为 201 | `{ "ok": true, "data": ... }` |
| 歌手写真 | 200 | `{ "code": 0, "data": ... }` |
| 歌词来源排序 | 200 | 直接返回 `{ "order": [...], "revision": 0, "sources": [...] }` |
| 媒体 | 200 或满足条件的 206 | 二进制流；HEAD 无响应体 |

先检查 HTTP 状态，再解析对应信封。外层认证、来源、CSRF、账号切换、维护或服务故障错误可使用总览中的通用形状，早于业务处理器返回。

| METHOD | 路径 | 功能 |
| --- | --- | --- |
| GET | `/api/init` | 兼容初始化视图：当前收藏和普通个人歌单 |
| GET | `/api/playlists/{id}` | 兼容个人歌单读取 |
| GET | `/api/songs` | 语言分类计数或按语言分页的歌曲集合 |
| GET | `/api/songs/search` | 跨歌曲元数据的有界分页搜索 |
| GET | `/api/songs/{id}` | 共享曲库的单曲元数据 |
| GET | `/api/albums` | 专辑目录 |
| GET | `/api/albums/{id}` | 完整专辑及全部可播放歌曲 |
| GET | `/api/artists` | 解析歌手署名后的目录 |
| GET | `/api/artists/{name}` | 指定歌手的分页歌曲 |
| GET | `/api/songs/random` | 随机可播放歌曲 |
| POST | `/api/songs/resolve` | 按给定 ID 顺序批量解析本地歌曲 |
| GET | `/api/songs/spotlight-artist` | 随机聚焦歌手与其歌曲 |
| GET | `/api/account/playlists` | 当前账号的歌单摘要 |
| POST | `/api/account/playlists` | 创建普通个人歌单 |
| GET | `/api/account/playlists/{id}` | 带修订号和歌曲的个人歌单 |
| PUT | `/api/account/playlists/{id}` | 修改普通歌单名称、简介 |
| DELETE | `/api/account/playlists/{id}` | 删除普通歌单；请求体带修订号 |
| PUT | `/api/account/playlists/{id}/songs` | 全量替换歌曲及顺序，可同时改普通歌单元数据 |
| DELETE | `/api/account/playlists/{id}/songs/{songId}` | 移除一首歌曲；请求体带修订号 |
| POST | `/api/account/playlist-songs` | 向一个或多个歌单追加歌曲 |
| GET | `/api/account/playlist-shelf` | 当前账号的个人歌单排列 |
| PUT | `/api/account/playlist-shelf` | 提交完整的新排列 |
| GET | `/api/account/play-stats` | 个人常听单曲和可选完整计数 |
| POST | `/api/account/play-stats` | 批量确认播放事件 |
| GET | `/api/lyrics` | 宿主统一歌词与已有译文 |
| POST | `/api/lyrics/translation` | 对已签发的歌词结果请求译文 |
| GET | `/api/lyrics/sources/order` | 当前可用来源和有效顺序 |
| PUT | `/api/lyrics/sources/order` | 管理员修改实例歌词来源顺序 |
| GET | `/api/artist-photo` | 歌手写真画廊 |
| GET | `/media/{relativePath}` | 私有媒体流和封面 |
| HEAD | `/media/{relativePath}` | 私有媒体元信息 |

接线证据：[Worker 入口](../src/flaretune.js)、[HTTP 路由](../src/instance/httpRouter.js)、[访问策略](../src/instance/accessPolicy.js)。以下路径中的动态 ID、歌手名都应当作为单个 path segment 编码，查询项使用 URL 查询参数构造器。

## 2. 共享 DTO、时间与语言

### Song

```ts
type Song = {
  id: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  duration: number | null;    // 秒
  audio_url: string | null;
  cover_url: string | null;
  language: string | null;
};
```

这是本地曲库的公共投影，不包含上传/管理内部字段。单曲读取可以返回没有音频的元数据；目录、搜索、发现、专辑和歌手歌曲集合仅纳入 `audio_url` 非空白的可播放歌曲。各接口可增加 `created_at`、`sortOrder`、`addedAt`、`play_count`、`last_played_at` 等字段，下文分别说明。历史数据的空字段按实际值处理，不使用假封面或假曲目填充。

`duration` 和歌词行、词时间是**秒**。个人数据 `createdAt`、`updatedAt`、`addedAt`、`played_at`、`last_played_at` 使用 Unix **毫秒**；歌词 `offsetMs` 为毫秒；歌词 `updatedAt`、`translationStartedAt` 使用时间字符串。不要对所有时间字段套同一种换算。

`audio_url`、`cover_url`、`coverUrl`、`photoUrl` 等可能是实例相对路径、绝对 URL、空字符串或 null。相对路径按实例基址解析。实例 Cookie 等身份信息只发送给对应实例，不随第三方封面或音频 URL 外泄。

语言代码为：`zh, ja, en, ko, instrumental, ru, es, fr, de, sv, vi, yue, it, th, pt, other`。支持逗号分隔的多个代码；`other` 是扩展语言集合筛选，包含 `ru, es, fr, de, sv, vi, yue, it, th, pt, other`。`instrumental` 表示纯音乐。非法代码返回 400。语言计数可能保留历史原始值，客户端应容忍未知显示项。

源码：[公共歌曲投影](../src/utils/songProjection.js)、[语言代码和筛选](../src/utils/songLanguage.js)。

## 3. 歌曲目录、搜索和兼容读取

源码：[localMusicRead.js](../src/routes/localMusicRead.js)、[搜索实现](../src/tools/searchSongs.js)。这一组业务错误一般为 `{code: HTTP状态, message: string}`：参数 400、对象不存在 404、缺少存储 503。外层会话错误见总览。

### GET /api/songs?counts=language

返回 `{code:200,data:{[language:string]:number}}`，按共享可播放曲库统计；不包含空/null 语言。`counts=language` 分支优先于普通集合读取，不要求额外 `language` 参数。

```json
{"code":200,"data":{"zh":120,"en":80,"instrumental":12}}
```

### GET /api/songs

| 参数 | 类型、默认值和限制 |
| --- | --- |
| `language` | 必填非空语言筛选，支持逗号分隔代码 |
| `page` | 整数，默认 1，范围 1–100000；有效偏移另受上限限制 |
| `limit` | 整数，默认 30，范围 1–50 |
| `sort` | `asc` / `desc`，默认 `desc`，大小写不敏感 |

必须满足 `(page - 1) * limit <= 2000`，否则 400。返回：

```ts
{ code: 200, data: {
  language: string, songs: (Song & {created_at: number | null})[],
  total: number, page: number, pageSize: number, hasMore: boolean,
  sort: "asc" | "desc"
}}
```

先排列有 `created_at` 的歌曲，再按该时间和 ID 同方向排序。`total` 是筛选后的完整数量，`hasMore` 表示尚有数据；本接口尚无 `nextOffset` / `capped` 字段，客户端翻页仍必须检查下页偏移不超过 2000。省略语言不是“全部歌曲”请求。

### GET /api/songs/search

| 参数 | 类型、默认值和限制 |
| --- | --- |
| `q` | 字符串，先 trim，最长 200 个 JS 字符；省略或空白返回空结果 |
| `language` | 可选语言筛选；省略则跨全部语言 |
| `limit` | 整数，默认 20，范围 1–50 |
| `offset` | 整数，默认 0，范围 0–2000 |

```json
{"code":200,"data":{"songs":[],"query":"hello","limit":20,"offset":0,"hasMore":false,"nextOffset":null,"capped":false}}
```

`songs` 类型是 `Song[]`。搜索保留既有标题/歌手/专辑匹配与规范化、日语罗马音等行为。分页使用一次额外探测来判定后续结果：

- `hasMore=true` 时 `nextOffset` 是可直接请求的数字偏移，且不超过 2000。
- 自然末页：`hasMore=false, nextOffset=null, capped=false`。
- 仍有匹配但下一页会超过 2000：`hasMore=false, nextOffset=null, capped=true`。这表示达到浏览上限，不表示全部匹配已加载。
- 空查询：空歌曲、`hasMore=false, nextOffset=null, capped=false`。

此处的新增字段不改变旧的 `songs`、`query` 字段。搜索不返回总匹配数。

### GET /api/songs/{id}

返回 `{code:200,data:Song}`，不存在为 404。解码后 ID 长度 1–256，无控制字符；错误编码/空 ID 为 400。此接口读取共享本地曲库，不保证解析任意插件音源 ID。`random`、`resolve`、`roam`、`spotlight-artist` 是保留路径名。

### GET /api/init 与 GET /api/playlists/{id}

这两个是兼容读取；需要修订号、准确自定义封面和新编辑流程的客户端应使用第 6 节现代个人歌单 API。

`/api/init` 的 `data`：

```ts
{
  default_playlist: {id: string, name: "我的收藏", type: "favorite", songs: Song[]},
  other_playlists: {
    id: string, name: string, description: string, author: "我", type: "regular",
    has_cover: 0, cover_url: null, preview_covers: [], order: number, songCount: number
  }[]
}
```

`/api/playlists/{id}` 的 `data`：

```ts
{
  id: string, name: string, description: string, author: "我",
  type: "favorite" | "regular", has_cover: 0, cover_url: null,
  preview_covers: [], created_at: number | null, songs: Song[]
}
```

只读取本人歌单，普通未知/他人 ID 为 404。路径字面量 `favorite` 是**仅供兼容 GET** 的当前账号收藏别名；若尚无收藏实体，返回稳定的空收藏视图。它不是现代写入 API 的真实歌单 ID，兼容视图也没有可用于写入的 `revision`。

## 4. 专辑和歌手

源码：[localAlbumRead.js](../src/routes/localAlbumRead.js)。只基于共享本地可播放歌曲聚合，不要求可选插件。通用分页参数 `limit=20`，范围 1–50；`offset=0`，范围 0–2000，均要求十进制非负整数字符串。参数错误 400，对象不存在 404；有界扫描超过安全预算返回 503 `{code:503,message:"Catalog read view is too large"}`，不悄悄截断为成功。

### GET /api/albums

除分页参数，还接受 `language`、`artist`、`q`。语言可省略，原始串最长 100；非空 `artist` / `q` trim 后 1–300 字符、无控制字符。`artist` 匹配解析后的完整歌手署名成员，不作任意子串匹配；`q` 对专辑名称或歌手署名作大小写不敏感子串搜索，包含有界 Unicode 处理。

```ts
type Album = {
  id: string; title: string; artist: string; coverUrl: string;
  trackCount: number; matchingTrackCount: number;
};
// {code:200,data:{albums:Album[],total:number,limit:number,offset:number,hasMore:boolean}}
```

按 trim 后的完整歌手署名和专辑名分组，空专辑/空歌手不形成专辑。按筛选命中曲目数降序，再按专辑名和署名排序。`matchingTrackCount` 是本次筛选命中的曲目数，`trackCount` 是同一完整专辑的全部可播放曲目数。语言筛选不会把完整专辑曲目数伪装成仅命中数量。封面从完整专辑有封面歌曲中按稳定日期/ID 规则选取，无封面为 `""`。

`id` 是服务端生成的规范 base64url 不透明标识，不是歌曲 ID；请原样保存并作为单一路径段传回，避免自行拆解、重算或使用专辑标题代替。

### GET /api/albums/{id}

返回 `{code:200,data:Album & {songs:Song[]}}`，包含完整专辑全部可播放歌曲，不分页、不继承上一次列表的语言筛选。曲目按有创建时间优先、创建时间升序、ID 升序排列。`matchingTrackCount` 在详情等于完整曲目数。规范专辑 ID 最长 3200 字符；非法或非规范 ID 为 400，当前无可播放曲目为 404。

### GET /api/artists

参数为 `limit`、`offset`、可选 `language`、`q`，长度校验同专辑。解析多歌手署名，大小写折叠去重后聚合，按歌曲数降序、歌手名排序。

```ts
type ArtistCard = {
  name: string; songCount: number; albumCount: number;
  photoUrl: string; coverUrl: string;
};
// {code:200,data:{artists:ArtistCard[],total:number,limit:number,offset:number,hasMore:boolean}}
```

`photoUrl` 是已有写真缓存；`coverUrl` 是歌曲封面回退，两者独立，缺失为 `""`。多人合作曲可计入多个歌手；`albumCount` 按完整署名和非空专辑名组合去重。

### GET /api/artists/{name}

`name` 是编码后的歌手名，解码、trim 后 1–300 字符，无控制字符；分页同上。匹配完整署名成员，返回：

```ts
{code:200,data:{name:string,photoUrl:string,coverUrl:string,songCount:number,
  songs:Song[],limit:number,offset:number,hasMore:boolean}}
```

歌曲按标题、ID 排序；`songCount` 是该歌手全部本地可播放歌曲数。本详情不接收语言筛选，列表筛选不会自动作用于详情。歌手/专辑列表的 `hasMore` 表示还有数据，但仍须由调用方检查下页偏移 <=2000；它们没有搜索接口新增的 `capped` 字段。署名候选扫描上限 10000、单歌手命中的完整署名组合上限 200，超限返回 503。

## 5. 随机、解析和聚焦歌手

源码：[localMusicDiscovery.js](../src/routes/localMusicDiscovery.js)。成功均为 `{code:200,data:...}`，参数错误 400；仅共享本地可播放曲库，不是第三方音源搜索接口。

### GET /api/songs/random

`limit` 默认 20，范围 1–50；`exclude` 是逗号分隔的最近歌曲 ID，最多 20 个，单个 trim 后 1–80 字符、无控制字符，整个查询串最长 1000。返回 `data:{songs:Song[]}`，不分页。排除是**软性多样性提示**：优先其他歌曲，曲库不足时仍可返回被排除歌曲。

### POST /api/songs/resolve

JSON 请求体最大 64 KiB：

```json
{"song_ids":["song-1","song-2","song-1","gone"]}
```

原数组长度 1–500；每个 ID trim 后 1–80 字符，无控制字符；重复 ID 去重并保留第一次出现的顺序。成功形状：

```ts
{code:200,data:{songs:Song[],missing_ids:string[]}}
```

`songs` 与 `missing_ids` 均保持输入去重顺序；不存在或无可播放音频的 ID 进入 `missing_ids`。这是只读 POST，但仍遵循总览中的请求来源、标识和 CSRF 规则。

### GET /api/songs/spotlight-artist

`exclude` 最多 20 个署名字符串，每项 trim 后 1–100 字符，整个串最长 1000，无控制字符。优先非排除且至少有两曲的署名，排除无其他可选项时可回退。会过滤部分未知歌手、纯音乐等占位署名。

返回 `data:null`，或：

```ts
{artist:string,songCount:number,songs:Song[],photoUrl:string,coverUrl:string}
```

这里按歌曲的完整 `artist` 署名随机聚焦，不等同于第 4 节解析后的歌手成员目录。歌曲按 ID 升序返回完整集合，无分页。它不表示个性化推荐，也不提供个人常听专辑。

## 6. 个人歌单、收藏与唱片架

源码：[localAccountMusic.js](../src/routes/localAccountMusic.js)。全部 JSON 请求体最大 64 KiB。成功 `{ok:true,data:...}`；失败：

```json
{"ok":false,"error":"REVISION_CONFLICT","message":"歌单已在其他页面更新。","data":{"playlist":{"id":"pl_example","revision":3}}}
```

上例错误 `playlist` 是下述摘要完整对象，这里为突出修订号省略其余字段。`message` 用于显示，不应作稳定程序分支；按 HTTP 状态与 `error` 处理。

### DTO 与共同限制

```ts
type PlaylistSummary = {
  id: string; source: "member"; kind: "favorite" | "regular";
  name: string; description: string; songCount: number; previewCovers: string[];
  revision: number; createdAt: number; updatedAt: number;
  customCoverUrl?: string | null; coverRevision?: number;
};
type PlaylistSong = Song & {sortOrder: number; addedAt: number};
type Playlist = PlaylistSummary & {songs: PlaylistSong[]};
type Shelf = {revision: number; updatedAt: number; items: {kind:"member";id:string}[]};
```

`previewCovers` 最多四张；自定义图片结构就绪时增加 `customCoverUrl`、`coverRevision`。普通歌单显示优先级为自定义封面、歌曲封面、占位图。图片上传/移除另见 [认证与个人图片](authentication.md)；勿向本节歌单元数据接口提交封面 URL。收藏自定义封面始终为 null。

每账号最多 50 个普通歌单，收藏另计；每歌单最多 500 首唯一歌曲。名称 trim 后 1–40 个 Unicode 字符，简介 0–300；ID trim 后 1–240 个 JS 字符。`expectedRevision` 必须是非负整数，使用刚读取到的版本，不在客户端自造版本。应用更新会提升相应修订号，真正无变更可返回 `outcome:"noop"`；**相同请求体带旧修订号重发仍可能冲突**。收到 409 后读取当前内容并让用户保留/合并意图，禁止自动覆盖。

普通本地歌曲不存在时，相关写入返回 404 `SONG_NOT_FOUND`，`data.missingSongIds:string[]`。部署启用外部引用结构和相应音源时，个人歌单可包含账号范围的外部歌曲 DTO；这不改变 `source:"member"` 所表示的歌单归属。外部引用不可用/迁移缺失有独立错误，不保证插件关闭后能继续解析新外部 ID。宿主本地曲库接口不会自动覆盖插件全目录。

### GET /api/account/playlists

返回 `data:{playlists:PlaylistSummary[]}`。首次读取会确保当前账号唯一收藏存在。收藏排在第一，其余按创建时间、ID 排序；需要用户自定义排列时再合并唱片架顺序。

### POST /api/account/playlists

```json
{"name":"通勤","description":"路上听","songIds":["song-1","song-2"],"idempotencyKey":"create-commute-20261112"}
```

必填 `name`；`description` 默认 `""`、`songIds` 默认 `[]`。可选非空字符串 `idempotencyKey` 形成当前账号范围内的确定歌单 ID。名称、简介与歌曲数组形状仍须有效；命中同账号既有 key 后直接返回原歌单的当前摘要，不重复创建、不用新请求覆盖内容，也不再验证初始歌曲当前是否存在或外部音源当前是否授权。因此首次创建后初始歌曲被删除，不妨碍同 key 重试确认原创建。仅真正新建时验证歌曲存在性和外部引用权限；另一个账号不能借同 key 读取该歌单。每个新建意图使用新 key，网络重试保留同 key。

HTTP **201**，包括幂等命中：

```ts
{ok:true,data:{outcome:"applied"|"noop",playlist:PlaylistSummary,shelf:Shelf}}
```

初始歌曲数组最多 500、不得重复，未知歌曲为 404；普通歌单额度耗尽为 409 `PLAYLIST_LIMIT_REACHED`。

### GET /api/account/playlists/{id}

返回 `data:{playlist:Playlist}`，包含完整歌曲和当前修订号。无分页。未知/他人歌单统一 404 `PLAYLIST_NOT_FOUND`。

### PUT /api/account/playlists/{id}

```json
{"expectedRevision":2,"name":"晚间通勤","description":"更新后的简介"}
```

`name` / `description` 至少提供一项；未提供的保留当前值。返回 `data:{outcome:"applied"|"noop",playlist:PlaylistSummary}`。收藏元数据修改为 409 `FAVORITE_METADATA_FORBIDDEN`。

### DELETE /api/account/playlists/{id}

**DELETE 必须带 JSON 请求体** `{"expectedRevision":2}`。返回 `data:{outcome:"applied",deletedPlaylistId:string,shelf:Shelf}`。收藏拒绝为 409 `FAVORITE_DELETE_FORBIDDEN`。再次删除已不存在对象为 404，不返回伪成功。

### PUT /api/account/playlists/{id}/songs

```json
{"expectedRevision":2,"songIds":["song-2","song-1"],"name":"可选的新名称"}
```

`songIds` 必填，是**完整替换和完整排序**，不是追加；`[]` 清空歌单。支持同时提供普通歌单的 `name` / `description`。歌曲不得重复，最多 500；超出为 409 `PLAYLIST_SONG_LIMIT_REACHED`。返回 `data:{outcome:"applied"|"noop",playlist:Playlist}`。

收藏允许曲目增删与排序，但禁止任何元数据字段。客户端仅调整收藏顺序时，应发送完整现有歌曲顺序，避免丢失未合并的新收藏。

### DELETE /api/account/playlists/{id}/songs/{songId}

请求体 `{"expectedRevision":2}`。返回 `data:{outcome:"applied"|"noop",playlist:Playlist}`。已有当前修订号且歌曲已经不在歌单内时为 `noop`；陈旧修订号仍为 409。收藏可以使用该接口取消收藏，移除后其他曲目的排序保持连续。

### POST /api/account/playlist-songs

```json
{"targets":[{"playlistId":"pl_example","expectedRevision":2},{"playlistId":"fav_example","expectedRevision":5}],"songIds":["song-1","song-2"]}
```

`targets` 为 1–50 个不同歌单，每项带自己的 `expectedRevision`；`songIds` 为 1–100 个唯一 ID；`targets.length * songIds.length <= 500`。向各目标末尾按输入顺序追加，已有歌曲为 no-op，不重复或重排已有曲目。整体格式/输入歌曲错误先拒绝整次请求；合法输入按目标独立处理。

```ts
{ok:true,data:{
  outcome:"applied"|"noop"|"partial"|"failed",
  results:{playlistId:string,outcome:"applied"|"noop"|"failed",
    addedSongIds:string[],noopSongIds:string[],revision?:number,error?:string}[],
  affectedPlaylistIds:string[]
}}
```

HTTP **200 仍可能部分失败或全部目标失败**。必须检查 `results`，典型目标错误为 `PLAYLIST_NOT_FOUND`、`REVISION_CONFLICT`、`PLAYLIST_SONG_LIMIT_REACHED` 或外部引用错误；`affectedPlaylistIds` 仅包含确实修改的目标。不要把 `partial` 显示为所有目标成功，也不要盲目重发所有目标。

### “我的收藏”的接入流程

从现代歌单列表找到 `kind:"favorite"`，保留**真实 ID 和 revision**；添加使用 `/api/account/playlist-songs`，取消使用单曲 DELETE，完整顺序用 songs PUT。没有另一个宿主星标切换接口。收藏固定名称为“我的收藏”、简介为空，不可改名、删除或换封面。旧 GET 的 `favorite` 别名不能用作现代写入 ID。

### GET /api/account/playlist-shelf 与 PUT /api/account/playlist-shelf

GET 返回 `data:{shelf:Shelf}`，仅包含当前账号收藏和普通个人歌单。读取会创建或修复过期排列，因此必要时可能推进唱片架版本。

PUT 请求：

```json
{"expectedRevision":1,"items":[{"kind":"member","id":"pl_example"},{"kind":"member","id":"fav_example"}]}
```

提交的是当前全部项目的完整排列，收藏可移动到任意位置。不能省略、重复或加入他人/系统项目，不支持 `hidden`；结构错误 400。返回 `data:{outcome:"applied"|"noop",shelf:Shelf}`；陈旧版本 409 `REVISION_CONFLICT`，可带当前 `data.shelf`。唱片架版本与各歌单版本是不同并发域。

### 个人音乐错误索引

| HTTP | `error` | 处理要点 |
| --- | --- | --- |
| 400 | `INVALID_BODY` / `INVALID_NAME` / `INVALID_DESCRIPTION` | 修正 JSON、数量、ID、字段或修订号 |
| 400 | `PAYLOAD_TOO_LARGE` | 播放事件数量超过 25；不等同于通用 HTTP 413 |
| 401 | `AUTH_REQUIRED` | 恢复正常登录 |
| 404 | `PLAYLIST_NOT_FOUND` / `SONG_NOT_FOUND` | 重新读取对象，勿猜测他人数据 |
| 409 | `REVISION_CONFLICT` | 读取当前版本后重新确认意图 |
| 409 | `PLAYLIST_LIMIT_REACHED` / `PLAYLIST_SONG_LIMIT_REACHED` | 达到 50 个普通歌单 / 每歌单 500 曲上限 |
| 409 | `FAVORITE_METADATA_FORBIDDEN` / `FAVORITE_DELETE_FORBIDDEN` | 收藏固定属性不支持该操作 |
| 409 | `ACCOUNT_CONTEXT_CHANGED` | 处理器账号上下文保护；外层也可能先返回通用 `account_changed` |
| 429 | `PLAY_EVENT_BUDGET_EXCEEDED` | 保留未确认事件，稍后重试 |
| 503 | `MUSIC_STORAGE_UNAVAILABLE` | 不将存储故障显示为空歌单 |

## 7. 个人播放事件与统计

源码同 [localAccountMusic.js](../src/routes/localAccountMusic.js)。这是个人常听**单曲**统计，不是可任意分页查询的完整播放历史时间线。

### POST /api/account/play-stats

```json
{"events":[{"event_id":"deviceA_20261112_0001","song_id":"song-1","played_at":1794441600000}]}
```

`events` 必填数组，0–25 条。`event_id` trim 后 1–128 字符，仅 `[A-Za-z0-9_-]`；`song_id` trim 后 1–256 字符；`played_at` 为正安全整数 Unix 毫秒。同一批次重复 `event_id` 只取首次；同账号范围的本地/已支持外部音源共享事件去重语义，重试必须保留原 `event_id`。

```json
{"ok":true,"data":{"recorded":1,"acceptedEventIds":["deviceA_20261112_0001"]}}
```

`recorded` 是本次新记录数；`acceptedEventIds` 是客户端可从待传队列删除的 ID，也会包括已接收的重试和确认歌曲已删除的本地事件，不能用 `recorded` 推导哪些事件需要重试。当前无法确认的外部引用事件可能不在已确认集合，客户端保留未确认 ID。空数组返回 0 和空确认集合。

事件收据保留 30 天，每账号最多 10000 条近期收据；超限 429。此上限约束去重收据，不表示清空已汇总的播放次数。不要假定无限期重放旧事件仍能去重。

### GET /api/account/play-stats

`limit` 默认20，正整数最大50；无效或非正值回退20。`view=summary`读取轻量预览，其他值读取完整计数。省略`days`保持累计统计和既有响应。

CONTINUE-LISTENING-20261113新增可选`days=1..30`，只接受一次规范十进制整数（如`7`，不接受空、0、31、01、1.0、空白或重复参数）；非法返回HTTP400/`INVALID_QUERY`。例如`GET /api/account/play-stats?days=7&view=summary&limit=50`。带days时只聚合当前认证账号已保存事件中`from <= played_at <= to`的有效记录，未来事件不计，额外返回`window:{days:number,from:number,to:number}`，from/to均为Unix毫秒，to为本请求捕获时间，from=to-days×86400000。

窗口响应的`play_count`、`last_played_at`及完整模式`playCounts/totalPlays/totalUniqueSongs`全部属于该窗口；summary不读完整映射，仍返回`view:"summary"`。曲库/YT继续按既有可用性和schema门禁，只用本账号已拥有引用，无外部解析或读取写入。窗口参数没有被回显时，客户端不能把响应当作近期统计。

窗口统计受既有30天/每账号最多10000条收据边界约束；已清理或未上报的事件不可从累计次数重建。本轮不新增迁移、不改事件上传/幂等/累计汇总。开发与验证状态见[本轮任务](../../docs/tasks/continue-listening-20261113.md)，代码存在不代表已部署。

```ts
type RankedSong = Song & {play_count:number;last_played_at:number};
// 完整 data
{songs:RankedSong[],playCounts:{[songId:string]:number},
 totalPlays:number,totalUniqueSongs:number,topAlbums:[]}
// summary data
{songs:RankedSong[],topAlbums:[],view:"summary"}
```

按播放次数降序、最近播放时间降序。`songs` 受 limit 限制；完整模式的 `playCounts` 才是完整映射。个人常听专辑已经按有效产品决定撤回，`topAlbums:[]` 是刻意保留的兼容字段，不是等待补齐的服务端功能；普通专辑目录继续保留。依据：[listening-and-resources.md 的 AC-CF-GOV-03](../../docs/spec/listening-and-resources.md)。

## 8. 宿主统一歌词与翻译

完整且唯一的详细合同见 [统一歌词 API](lyrics.md)：四个宿主端点、v2 DTO、正文/词级/译文时间、纯音乐联合分支、全部翻译状态、resultRef 时效与轮询恢复、请求/响应示例、来源配置依赖与验证证据均在该分册维护。本节不再复制字段定义，避免客户端读取到分歧合同。

## 9. 歌手写真

### GET /api/artist-photo?name={credit}

只接受一次 `name`，不能带额外参数。值为 1–200 字符、无首尾空白和控制字符；署名解析后最多 8 位歌手。成功码是 **0**：

```ts
{code:0,data:{artist:string,artistNames:string[],primary:string,
  photos:{url:string,type?:string,label?:string,source?:string,sourceName?:string,
    width?:number,height?:number,isRealArtist?:boolean,is169?:boolean,artistName:string}[],
  meta:{artistsCount:number,totalPhotos:number}}}
```

返回最多 12 张，按各歌手画廊交错合并并按 URL 去重；无图时 `primary:""`、`photos:[]`。优先既有缓存，缺图时只对曲库中存在的歌手抓取，每请求最多 2 位；无结果缓存约一小时。GET 可能更新写真缓存，不是纯数据库快照。字段只保留安全 URL 和有界元数据。参数错误 400，数据库/缓存写入故障 503。

写真 URL 接受实例安全相对路径或 HTTPS，过滤嵌入凭据和 localhost；不要在第三方请求中附带实例认证。此画廊与 `/api/artists` 直接返回的缓存首图是不同粒度。

## 10. 私有音频与封面媒体

源码：[media.js](../src/routes/media.js)、[媒体前缀](../src/services/adminMusicMedia.js)。公开接线是 `handleMediaRoute`，内部测试辅助函数不构成另一个可绕过认证的 HTTP 入口。

### GET /media/{relativePath} 与 HEAD /media/{relativePath}

音频播放器、封面加载器和 HEAD 请求都必须使用实例有效 Cookie；每次请求重新检查实例与当前账号会话，不能用 URL 查询 token 替代。媒体不会因已经获取 Song DTO 而公开可读。

宿主把相对路径映射到 `MEDIA_BUCKET` 的 `${MEDIA_PREFIX}/{relativePath}`，默认前缀 `media`。客户端直接使用歌曲提供的 URL，不自行猜测对象 key。各路径段独立解码，拒绝空段、`.`、`..`、斜线/反斜线和控制字符；设备收件箱 `ingest-devices` 与 `users/` 私有图片命名空间不能通过这个通用路径读取。

正常响应含 `Accept-Ranges: bytes`、`Cache-Control: private, no-store`、`X-Content-Type-Options: nosniff`，并按对象元信息设置 Content-Type、ETag、Content-Length。即使 R2 对象缓存元数据不同，也强制保留私有 no-store 策略。

GET 将 `Range` 请求头交给存储读取；当存储返回有效 `range.offset`、`range.length` 和对象总大小时响应 206，带 `Content-Range: bytes start-end/total` 与分段长度；否则可能返回 200 完整对象。HEAD 使用对象 head，200 无响应体。目前宿主没有自行定义完整的 416、If-Range 或条件 GET 状态机，客户端必须接受服务端实际状态和 Range 结果，不能仅凭 `Accept-Ranges` 假设任意 Range 都必然成功。

| HTTP | 情况 |
| --- | --- |
| 200 | 完整媒体或 HEAD 元信息 |
| 206 | GET Range 且存储返回有效分段描述 |
| 401 | 缺失或失效会话 |
| 403 | 非正常模式或无允许角色 |
| 404 | 非法/受保护路径，或对象不存在 |
| 405 | 非 GET/HEAD，`Allow: GET, HEAD` |
| 503 | 实例非 ready、会话校验/存储绑定不可用等 |

媒体错误一般无 JSON 响应体。运行平台或存储异常不保证能归入上述每一个业务错误形状。可选 YouTube 媒体处理器在宿主对象读取前分派；插件专属流地址和有效期遵循该插件合同，不意味着任意外部 URL 都由宿主媒体路由承接。

## 11. 验证来源与接入核对

可在仓库根目录对宿主目标模块运行：

```powershell
node --experimental-sqlite --test server/src/routes/localMusicRead.test.js server/src/routes/localAlbumRead.test.js server/src/routes/localMusicDiscovery.test.js server/src/routes/localAccountMusic.test.js server/src/routes/externalAccountMusic.test.js server/src/routes/localMetadataRead.test.js server/src/routes/media.test.js
```

这些测试的已存在覆盖来源如下；列出命令和来源不等于本次全部通过：

| 测试 | 覆盖重点 |
| --- | --- |
| [localMusicRead.test.js](../src/routes/localMusicRead.test.js) | 本地歌曲、兼容收藏/歌单、分类、搜索参数与分页 |
| [localAlbumRead.test.js](../src/routes/localAlbumRead.test.js) | 完整专辑、歌手成员、Unicode、分页、封面与边界 |
| [localMusicDiscovery.test.js](../src/routes/localMusicDiscovery.test.js) | 随机、软排除、输入顺序解析和聚焦歌手 |
| [localAccountMusic.test.js](../src/routes/localAccountMusic.test.js) | 归属、收藏限制、CRUD、版本冲突、配额、部分成功、唱片架和事件 |
| [externalAccountMusic.test.js](../src/routes/externalAccountMusic.test.js) | 外部引用快照与来源边界、跨来源事件去重/并发 |
| [localMetadataRead.test.js](../src/routes/localMetadataRead.test.js) | 歌词读取、资产错误、写真校验、缓存与抓取预算 |
| [lyricSourceChain.test.js](../src/services/lyricSourceChain.test.js) | 来源选择、结果引用、翻译和权限边界；其他同名前缀用例补充场景 |
| [media.test.js](../src/routes/media.test.js) | 对象路径、私有目录、GET/HEAD 和存储错误分支 |

公开入口会话/CSRF 等还需结合 [flaretune.test.js](../src/flaretune.test.js) 与总览测试。媒体辅助函数测试不单独证明真实存储的全部 Range/416 行为；插件 HTTP 测试不能代替未安装实例的宿主能力证据。

给客户端实现的接入核对：

1. 按接口解析信封，保留外层认证/账号切换错误，失败不要转为空数据。
2. 个人音乐用现代歌单 API 获取真实收藏 ID、完整歌曲和 revision。
3. 普通修改、全量替换、追加、DELETE 的语义不同；DELETE 带 JSON 修订号，多目标追加检查每项目标结果。
4. 搜索跟随 `nextOffset`，达到 `capped` 明确提示上限；其他分页先检查下页偏移 <=2000。
5. 完整专辑使用详情歌曲，不能把首页几张卡或搜索一页当完整播放队列。
6. 时间按字段单位转换；歌词已应用 offset，译文按原文行配对。
7. 结果引用绑定账号与会话，409 后重新获取；播放事件按确认 ID 出队并保留稳定 event_id。
8. 媒体和图片请求使用正确实例来源，私有媒体携 Cookie；插件是否可用读取实际状态，不依赖预设 UI。
