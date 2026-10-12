# 歌词源配置

[简体中文](lyric-sources.md) · [English](lyric-sources.en.md)

管理员在「设置 → AI 与助手 → 歌词源」打开配置弹窗。默认只启用 LRCLIB，服务地址为 `https://lrclib.net/api`；也可关闭或改为兼容的自建服务。其他来源默认关闭且没有地址。修改后保存；取消会丢弃本次草稿。配置冲突时重新打开弹窗读取最新值。

自定义接口必须提供下面对应的数据协议。域名只是示例，填写你自己有权使用的 HTTPS 搜索和下载接口完整地址；不含查询参数、片段或 URL 账号密码，不支持 IP、本地地址、非标准端口和重定向。应用只发送歌曲标题、歌手、时长及候选 ID 等检索数据，不发送登录凭据。接口地址仅管理员可见，成员可以查询启用的来源和歌词。

## 搜索／下载逐字协议

例如搜索地址 `https://lyrics.example.com/search`，下载地址 `https://lyrics.example.com/download`。搜索使用 GET，查询参数为 `keyword`（标题和歌手）、`duration`（可用时，毫秒）、`ver=1`、`man=yes`、`client=pc`。响应示例：

```json
{"candidates":[{"id":"track-1","accesskey":"candidate-token","song":"Example Song","singer":"Example Artist","album":"Example Album","duration":200000}]}
```

下载使用 GET，参数为 `id`、`accesskey`（来自搜索结果）、`fmt=krc`、`charset=utf8`、`ver=1`、`client=pc`，返回 `{"content":"BASE64_CONTENT"}`。KRC 内容为 `krc1` 标记与该格式的压缩加密数据；应用解码逐字时间及可用译文。无可用 KRC 时再请求 `fmt=lrc`，内容为 UTF-8 LRC 的 Base64。仅有逐行结果时按逐行显示，不伪造逐字精度。

## 搜索／下载逐行协议

例如 `https://lines.example.com/search` 和 `https://lines.example.com/download`。搜索 GET 参数为 `s`（标题和歌手）、`type=1`、`offset=0`、`limit=10`；响应示例：

```json
{"code":200,"result":{"songs":[{"id":"track-1","name":"Example Song","artists":[{"name":"Example Artist"}],"album":{"name":"Example Album"},"duration":200000}]}}
```

下载 GET 参数为 `id`、`lv=1`、`kv=1`、`tv=1`；响应示例：

```json
{"code":200,"lrc":{"lyric":"[00:01.000]Example lyric"},"tlyric":{"lyric":"[00:01.000]示例译文"}}
```

`tlyric` 可省略，译文通过时间戳与原文对齐。在配置中选择「来源译文语言」，使原有译文与歌词 AI 的目标语言判断一致。每种通用协议提供一组可选地址；不符合协议的服务需要由服务端自行转换响应格式。

来源请求有超时、响应大小和解码上限；失败不会替换已有歌词。候选仍按标题、歌手、版本和时长匹配，管理员可在工作台预览并导入。启停来源不会删除已保存歌词；旧版本歌词继续读取，重新取词只使用当前启用的来源。[Demo](https://flaretune.arcinks.com/settings/admin/assistant) 展示相同配置，管理项只可查看，不联网取词。

[返回管理指南](administration.md)
