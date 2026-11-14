# 已实现的 Subsonic / OpenSubsonic 兼容 API

源码盘点基线：`3d0076d8431e8cb9501c5029d1af55bddb40ac9a`（2026-11-12）。本页列当前Worker真实支持的方法与限制，不能据Subsonic标准全集推断宿主已实现其余方法。文档编写未重新运行测试、外网请求或设备联调。公共入口见 [API索引](../API.md)。

真实路由：[flaretune.js](../src/flaretune.js) 将 `/rest` / `/rest/**` 分给 [subsonic/router.js](../src/subsonic/router.js)，后者分发 [library](../src/subsonic/library.js)、[state](../src/subsonic/state.js)、[media](../src/subsonic/media.js)。这套认证不使用Web Cookie；普通原生客户端也可直接使用宿主现代API，而不是必须走兼容协议。

## 1. HTTP方法、路径、认证和格式

支持路径为 `/rest/{method}` 和等价 `/rest/{method}.view`，方法名大小写敏感。**所有34个已实现方法支持GET；仅stream/download/getCoverArt/getCoverArt2额外支持HEAD。POST不支持，也不支持POST表单认证。** `/rest`自身或不符合路径正则者返回协议错误70。

必须HTTPS；仅localhost、127.0.0.1、[::1]允许开发HTTP例外。实例必须ready；部署迁移门启用时仍受Worker外层部署门控制。查询串长度≤32768个URL字符。以下参数为查询参数，不是请求头或JSON字段：

| 参数 | 类型、约束与行为 |
| --- | --- |
| v | 必需string，`1.n.patch`数字格式；n=13..16，建议1.16.1；n<13错误20，n>16错误30 |
| c | 必需非空客户端名，≤4096字符，无控制字符 |
| f | 可选，精确xml/json，默认xml；其他值协议错误0 |
| u | 除扩展发现外必需；用户名3..64字符，`[a-z0-9_.-]`不区分大小写，服务转小写查找 |
| t | 除扩展发现外必需；32位hex，`MD5(password + salt)`，服务不区分hex大小写 |
| s | 除扩展发现外必需；6..256字符salt |
| p/apiKey | 明确不支持；不得明文/enc密码或API Key认证，返回42或43 |

`getOpenSubsonicExtensions`无需u/t/s，但仍要求v/c、合法格式与ready状态。其他方法必须是用户已显式启用兼容访问的active、非强制改密账户。管理员也只获本协议本人权限，getUser中的adminRole固定false。

同名query重复通常错误10；当前只允许 `id,songId,songIdToAdd,songIndexToRemove,albumId,artistId` 重复。列表写入使用重复参数，不是逗号分隔。单值方法应只发送一个id，不依赖服务读取首个重复值。普通required参数非空、≤4096字符、不得含控制字符。

```http
GET /rest/ping.view?v=1.16.1&c=FlareTuneClient&f=json&u=listener&t=<MD5_HEX>&s=<随机salt>
```

不要在诊断日志中保留含u/t/s的完整URL。salt和token由客户端每次按协议生成；本服务不从Cookie替用户计算token。

### 1.1 用户显式开启兼容访问

这两个是现代账号API，采用正常Cookie、Origin、X-Requested-With、CSRF和Expected-Account规则，**不是**u/t/s认证：

| METHOD + path | 请求 | 成功响应 |
| --- | --- | --- |
| `GET /api/account/subsonic` | 无body | `{enabled:boolean,revision:number}` |
| `PUT /api/account/subsonic` | `{enabled:boolean,expectedRevision:number,currentPassword?:string}` | `{enabled:boolean,revision:expectedRevision+1}` |

expectedRevision为非负安全整数，开启时currentPassword必需且须验证当前本地密码；关闭时不需要密码。正常JSON对象≤8192字节。开启另受登录尝试限流，429 rate_limited。无效字段类型400 invalid_input，版本冲突409 revision_conflict，密码不符401 invalid_credentials，非活动或强制改密账户401/外层403；加密服务不可用503。

兼容材料按账号加密保存，不在响应返回；改密、管理员重置密码会关闭访问，禁用或强制改密账户不能连接。SETUP_SECRET轮换/密文损坏使状态读取enabled=false，用户需重新验证开启。接口没有“管理员查看或导出他人协议密码”能力。

```http
PUT /api/account/subsonic
Origin: https://music.example.com
X-Requested-With: FlareTune
X-CSRF-Token: <csrfToken>
X-FlareTune-Expected-Account: <accountId>
Cookie: __Host-ft_session=<session>
Content-Type: application/json

{"enabled":true,"expectedRevision":0,"currentPassword":"<用户本次输入的本地密码>"}
```

实现：[credentials.js](../src/subsonic/credentials.js)、[httpRouter.js](../src/instance/httpRouter.js)。

## 2. 真实方法表

下表“响应字段”为 `subsonic-response` 内的payload；均省略第1节通用query参数，`?`表示可选。所有GET mutation仍需u/t/s，不要求Web CSRF头。

| METHOD + path | 方法特有query参数 | 响应字段、行为 |
| --- | --- | --- |
| `GET /rest/getOpenSubsonicExtensions` | 无 | openSubsonicExtensions数组，固定声明songLyrics versions=[1,2]；免协议认证 |
| `GET /rest/ping` | 无 | 无额外payload |
| `GET /rest/getLicense` | 无 | license={valid:true}，固定兼容信息 |
| `GET /rest/getUser` | username必需，必须等于本人规范化username | user，字段见第3节 |
| `GET /rest/getMusicFolders` | musicFolderId?，若出现只能"1" | musicFolders.musicFolder=[{id:"1",name:"Music"}] |
| `GET /rest/getGenres` | musicFolderId? | genres.genre=[]，当前无genre数据 |
| `GET /rest/getScanStatus` | musicFolderId? | scanStatus={scanning:false,count:本地可播放曲数}；不启动扫描 |
| `GET /rest/getSong` | id必需，musicFolderId? | song:Song |
| `GET /rest/getArtists` | musicFolderId? | artists={ignoredArticles:"",index:[{name:"#",artist:Artist[]}]} |
| `GET /rest/getIndexes` | musicFolderId? | indexes含同上字段，另lastModified毫秒 |
| `GET /rest/getArtist` | id必需，musicFolderId? | artist:Artist & {album:Album[]} |
| `GET /rest/getAlbum` | id必需，musicFolderId? | album:Album & {song:Song[]}，本地完整专辑 |
| `GET /rest/getMusicDirectory` | id必需，musicFolderId? | directory={id,name,child:Album[]或Song[]}，仅artist/album目录 |
| `GET /rest/search2` | query必需但可空；artistCount/albumCount/songCount?；对应Offset?；musicFolderId? | searchResult2={artist:Artist[],album:Album[],song:Song[]} |
| `GET /rest/search3` | 同search2 | searchResult3，同结构 |
| `GET /rest/getRandomSongs` | size?，musicFolderId? | randomSongs.song:Song[]；genre/fromYear/toYear出现即拒绝 |
| `GET /rest/getAlbumList` | type必需，size?，offset?，musicFolderId? | albumList.album:Album[] |
| `GET /rest/getAlbumList2` | 同getAlbumList | albumList2.album:Album[] |
| `GET /rest/getPlaylists` | username?，public? | playlists.playlist:PlaylistSummary[]，只列本人regular歌单 |
| `GET /rest/getPlaylist` | id必需，username?，public? | playlist:PlaylistDetail |
| `GET /rest/getPlaylist2` | 同getPlaylist | 同上，非独立新DTO |
| `GET /rest/createPlaylist` | 新建name必需；或playlistId更新既有；重复songId?；name?；username?/public? | playlist:PlaylistDetail；创建或替换已有普通歌单本地曲目 |
| `GET /rest/updatePlaylist` | playlistId必需；name?、comment?、重复songIndexToRemove?、重复songIdToAdd?；username?/public? | 无额外payload；原子修改普通歌单 |
| `GET /rest/deletePlaylist` | id必需，username?/public? | 无额外payload；删除本人普通歌单 |
| `GET /rest/getStarred` | username?/public?；不得albumId/artistId | starred={artist:[],album:[],song:Song[]} |
| `GET /rest/getStarred2` | 同getStarred | starred2，同结构 |
| `GET /rest/star` | 一个或重复id必需；username?/public?；不得albumId/artistId | 无额外payload；增加本人歌曲收藏 |
| `GET /rest/unstar` | 同star | 无额外payload；移除本人歌曲收藏 |
| `GET /rest/stream` | id必需；format?、maxBitRate?、timeOffset? | 原音频字节，支持Range，见第5节 |
| `GET /rest/download` | 同stream | 同原字节路径，不提供转码 |
| `GET /rest/getCoverArt` | id必需；size等扩展参数当前不触发实际缩放 | 原封面字节 |
| `GET /rest/getCoverArt2` | 同getCoverArt | 同上 |
| `GET /rest/getLyrics` | id?；否则artist?/title? | lyrics={}或{artist,title,value}，无匹配可为空 |
| `GET /rest/getLyricsBySongId` | id必需，enhanced?=true/false | lyricsList.structuredLyrics数组，见第6节 |

额外支持：`HEAD /rest/stream`、`HEAD /rest/download`、`HEAD /rest/getCoverArt`、`HEAD /rest/getCoverArt2`，同样支持`.view`变体。其他HEAD被拒绝，POST全部被拒绝，不能把标准文档里的POST方法直接套用。

识别但**不实现** `GET /rest/scrobble`：认证后协议错误0 `Playback reporting is not supported`，无播放记录写入。所有其他未列方法返回协议错误70；不提供jukebox、分享、视频、用户管理、转码、服务端播放队列同步等方法。

### 2.1 分页、类型及写入限制

- library方法的musicFolderId若出现必须精确"1"。可播放库最多10000首；超过返回协议错误0，不伪装截断成功。库快照按DB缓存60秒，更新后部分浏览结果可能短暂滞后；getSong直接读单曲。
- search2/3的query trim后≤200 JS字符，空query用于全库同步；artist/album/song Count默认20、各0..500，对应Offset默认0、0..1000000。匹配歌名、艺人、专辑文本，不支持任意标准扩展过滤。
- random size默认10、0..500；不支持genre和年份过滤。albumList size默认10、0..500，offset默认0、0..1000000。
- albumList type实际支持newest、alphabeticalByName、alphabeticalByArtist、random；recent/frequent/starred是固定空列表兼容返回，不能宣传为已实现统计/专辑收藏；其他type错误0。
- state方法的username若出现必须等于本人；public若出现只能字符串false。普通歌单最多50个，每个最多500首，名称trim后1..40码点，comment映射description、trim后≤300码点。
- createPlaylist的songId重复参数会去重；更新playlistId分支替换本地曲目，不提供“只改名但保留曲目”的特殊语义，未传songId可清空本地曲目。改名而不改曲目应调用updatePlaylist。
- updatePlaylist的songIndexToRemove为当前可见本地曲目零基索引，必须安全非负整数且小于当前曲数；songIdToAdd追加并去重。通过Web保存的外部源引用在替换本地投影时保留，不被协议静默清掉。
- star/unstar仅歌曲id；不能传albumId/artistId，即使空值也会拒绝。收藏使用本人共享收藏数据，读收藏时可能初始化空favorite记录。普通歌单操作不能借id修改favorite，须用star/unstar。
- 协议不暴露revision字段，但写入内部读取当前revision并原子提交；冲突返回协议错误，应刷新后重试，不当作成功。

## 3. 元数据 DTO

JSON中undefined可选字段直接省略；XML多数字段为属性，数组为重复子元素，不能依赖JSON key顺序。协议ID视为不透明值：artist常为art_前缀，album常为alb_前缀，cover常为cover_歌曲ID；**不要与现代 `/api/albums` ID混用或自行去掉前缀**。

```ts
type Song = {
  id:string;parent:string;isDir:false;title:string;artist:string;album:string;
  artistId:string;albumId:string;duration:number;type:"music";
  contentType:string;suffix:string;coverArt?:string;created?:string;starred?:string;
};
type Artist = {id:string;name:string;albumCount:number;coverArt?:string};
type Album = {
  id:string;name:string;title:string;artist:string;artistId:string;isDir:true;
  coverArt?:string;songCount:number;duration:number;created?:string;
};
type PlaylistSummary = {
  id:string;name:string;comment:string;owner:string;public:false;
  songCount:number;duration:number;created:string;changed:string;coverArt?:string;
};
type PlaylistDetail = PlaylistSummary & {entry:Song[]};
type User = {
  username:string;scrobblingEnabled:false;adminRole:false;settingsRole:false;
  downloadRole:true;uploadRole:false;playlistRole:true;coverArtRole:false;
  commentRole:false;podcastRole:false;streamRole:true;jukeboxRole:false;
  shareRole:false;videoConversionRole:false;folder:[1];
};
```

duration为四舍五入、非负的秒数；created/changed/starred为ISO8601字符串。无艺人/专辑时分别显示Unknown artist/Unknown album。song的contentType由存储URL扩展名推断，不表示服务器承诺转码或媒体已经可通过兼容通道读取。

`getPlaylists`摘要只计算本地投影，包含空普通歌单；getPlaylist详细entry同样不含外部源曲目。getMusicDirectory不是文件系统任意路径浏览，只接受本协议artist/album目录ID。

## 4. 格式、成功和错误外壳

```json
{"subsonic-response":{"status":"ok","version":"1.16.1","type":"FlareTune","serverVersion":"<当前package版本>","openSubsonic":true,"musicFolders":{"musicFolder":[{"id":"1","name":"Music"}]}}}
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<subsonic-response xmlns="http://subsonic.org/restapi" status="ok" version="1.16.1" type="FlareTune" serverVersion="1.3.0" openSubsonic="true"><musicFolders><musicFolder id="1" name="Music"></musicFolder></musicFolders></subsonic-response>
```

XML示例的serverVersion仅示意本地开发版本，真实返回取当前包元数据。成功元数据HTTP200、Content-Type application/json或application/xml，Cache-Control private,no-store。`version`固定协议1.16.1，serverVersion来自当前包版本，不能硬编码应用版本号。

元数据协议失败通常仍HTTP200：

```json
{"subsonic-response":{"status":"failed","version":"1.16.1","type":"FlareTune","serverVersion":"<当前package版本>","openSubsonic":true,"error":{"code":40,"message":"Wrong username or password"}}}
```

| code | 当前典型含义 |
| --- | --- |
| 0 | 不支持的能力、一般请求失败、服务不可用 |
| 10 | 参数缺失/非法/重复、查询过大、索引无效 |
| 20 | 客户端协议版本过低 |
| 30 | 不支持的协议版本、要求服务端升级 |
| 40 | 密码token不符/未开启/账户不可用/认证尝试过多 |
| 42/43 | 不支持的密码或API-Key认证方式、混合认证 |
| 50 | 跨用户、公开歌单或其他权限错误 |
| 70 | 方法、歌曲、专辑、歌单或媒体不存在/不可见 |

二进制错误不能当音频保存：即使请求f=json，stream/download/getCoverArt/getCoverArt2失败时为text/xml，code70对应HTTP404，code40/50对应403，其他协议错误通常400。HEAD只返回同状态/头，无body。实例不可用或真正存储/歌词服务故障可能HTTP503；客户端同时判断HTTP状态、Content-Type和协议status。

认证失败按isolate内IP窗口计数，15分钟达到20次后拒绝；不是跨所有Worker节点的全局保证。普通error.code/status被映射成协议码，不保证现代API的机器错误字符串原样返回。

## 5. 原始音频与封面

实现：[subsonic/media.js](../src/subsonic/media.js)、[私有媒体Range实现](../src/routes/media.js)。

stream/download只能读取歌曲存储引用所指向的实例受管媒体，兼容 `audio/...` 与 `/media/audio/...`。不接受协议调用方自行提供objectKey、任意URL或跳转目标。外部HTTPS音频、YT外部引用等不由此协议代理；找到元数据不保证兼容播放成功。

| 参数/头 | 当前合同 |
| --- | --- |
| id | 必需，已有本地歌曲ID；封面使用响应提供的coverArt或支持的专辑/艺人封面ID |
| format | stream/download省略或raw/原文件扩展名（比较时转小写）；其他拒绝转码 |
| maxBitRate | 省略或精确字符串0；其他拒绝，不能用标准客户端非零默认码率 |
| timeOffset | 省略或精确字符串0；其他拒绝；定位使用Range |
| Range | HTTP字节范围，返回原文件对应数据/Content-Range；不是时间秒数 |
| size | 封面尺寸参数当前不产生resize；返回原图片，客户端缩放 |

```http
GET /rest/stream.view?v=1.16.1&c=Example&u=listener&t=<MD5_HEX>&s=<salt>&id=track_001&format=raw
Range: bytes=100000-
```

正常原文件200，合法部分响应206；失效范围可能416。音频格式白名单、存储前缀和Range细节由私有媒体实现统一校验，不能借Subsonic绕开媒体对象边界。download与stream当前使用同一原字节服务，不承诺不同的转码或下载重命名行为。

## 6. 歌词兼容字段

实现：[subsonic/media.js](../src/subsonic/media.js)、[subsonic/lyrics.js](../src/subsonic/lyrics.js)。歌词读取使用宿主统一来源链，可能按需获取并保存/更新歌词资产；GET不代表绝对无缓存写入。具体来源与现代歌词写入合同应查对应音乐/歌词分册，本页只定义协议输出。

getLyrics支持id精确定位；若无id，则artist/title trim后搜索，至少一项非空，每项≤4096字符且无控制字符。无足够唯一匹配时返回lyrics={}；最多考虑8个候选，不为多首歧义录音盲目触发全部来源搜索。匹配歌曲但无歌词可返回 `{lyrics:{artist,title,value:""}}`。value为逐行文本，以换行连接，不返回LRC时间标签或机器凭据。

getLyricsBySongId要求id，enhanced省略/false输出基础结构；仅精确字符串true启用增强，其他值错误10。没有歌词时 `lyricsList.structuredLyrics=[]` 是成功空结果。

```ts
type StructuredLyrics = {
  displayArtist:string;displayTitle:string;
  lang:string;synced:boolean;offset:0;
  line:{value:string;start?:number}[];
  kind?:"main"|"translation";
  cueLine?:{
    index:number;start:number;end?:number;value:string;
    cue:{value:string;start:number;end:number;byteStart:number;byteEnd:number}[];
  }[];
};
// payload: {lyricsList:{structuredLyrics:StructuredLyrics[]}}
```

所有start/end为应用保存偏移后的毫秒，协议offset输出0，客户端不要重复叠加。基础模式只有原文层，lang固定und，不含kind/cueLine。增强模式原文kind=main、lang取有效歌曲语言（无法映射为und），有逐词数据时附cueLine；存在非空翻译时另加kind=translation层，未翻译空行不伪造。

cue.index是原文零基行索引；byteStart/byteEnd是该cueLine.value中**UTF-8字节位置，结束包含在内**，不是UTF-16索引；XML转义前计算。XML的line文本与增强cueLine/cue的value表达不同，应按实际XML/JSON结构解析，不用单一字符串替换兼容所有版本。

```http
GET /rest/getLyricsBySongId.view?v=1.16.1&c=Example&f=json&u=listener&t=<MD5_HEX>&s=<salt>&id=track_001&enhanced=true
```

```json
{"lyricsList":{"structuredLyrics":[{"displayArtist":"Example","displayTitle":"Night","lang":"en","synced":true,"offset":0,"kind":"main","line":[{"value":"Good night","start":1200}]}]}}
```

上述示例是外壳内payload，不包含整层subsonic-response。instrumental/other或无有效语言映射输出und；翻译缺目标语言时按已有资产来源规则回退，不保证总是当前UI语言。

## 7. 兼容边界与本地测试入口

不支持scrobble播放上报、专辑/艺人收藏、音频转码、码率限制、timeOffset定位、genre/year随机筛选、真实genre/服务端扫描管理、任意用户操作。getLicense.valid=true、getUser固定能力、getGenres空数组、getScanStatus.scanning=false和部分albumList类型空结果均为当前兼容响应，不表示对应完整产品能力已实现。

测试入口：

- [subsonic.test.js](../src/subsonic/subsonic.test.js)：启用/关闭、密码重置、XML/JSON、歌单/收藏隔离、Range/HEAD与二进制错误。
- [externalReferences.test.js](../src/subsonic/externalReferences.test.js)：仅本地投影及外部引用保全。
- [mailboxIsolation.test.js](../src/subsonic/mailboxIsolation.test.js)：非媒体对象边界。
- [lyrics.test.js](../src/subsonic/lyrics.test.js)、[lyricPlayback.test.js](../src/subsonic/lyricPlayback.test.js)：增强结构与实际播放歌词链。
- [pluginAuthority.test.js](../src/subsonic/pluginAuthority.test.js)：协议身份到宿主能力的授权边界。
- [response.js](../src/subsonic/response.js)、[credentials.js](../src/subsonic/credentials.js)为参数、格式和认证实现来源。

这里只登记源码及已有测试入口；不同第三方客户端、真实账号、媒体格式、蓝牙及长时间后台兼容需各自验证，不由方法表推断。
