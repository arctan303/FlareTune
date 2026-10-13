# Lyric sources

[简体中文](lyric-sources.md) · [English](lyric-sources.en.md)

Administrators manage **Default channels** and **Custom channels** separately under **Settings → AI and assistant → Lyric sources**. LRCLIB is configured and enabled by default at `https://lrclib.net/api`; edit its URL separately or use its switch to enable or disable it. Choose **Add custom channel**, select the word-timed or line-timed protocol, and enter only that channel’s search/download URLs and translation language. Each added channel has its own Edit, Delete and enable switch. Disabling retains its configuration; deleting removes only that configuration, preserving saved lyrics. Each protocol supports one endpoint pair; use Edit to update an existing channel. Save changes only the selected channel, while Cancel discards its draft. Refresh the page and reopen after a revision conflict.

Custom services must implement the relevant protocol below. Use HTTPS search and download endpoint URLs you are entitled to access. The domains below are examples. URLs cannot include credentials, query strings or fragments; IP literals, local hostnames, nonstandard ports and redirects are unsupported. Requests contain song metadata and candidate identifiers, without application login credentials. Only administrators receive endpoint URLs; members can read enabled source IDs and lyrics.

## Word-timed search/download protocol

Example endpoints: `https://lyrics.example.com/search` and `https://lyrics.example.com/download`. Search uses GET with `keyword` (title and artist), `duration` (milliseconds, when available), `ver=1`, `man=yes` and `client=pc`:

```json
{"candidates":[{"id":"track-1","accesskey":"candidate-token","song":"Example Song","singer":"Example Artist","album":"Example Album","duration":200000}]}
```

Download uses GET with `id`, `accesskey` from search, `fmt=krc`, `charset=utf8`, `ver=1` and `client=pc`. Return `{"content":"BASE64_CONTENT"}`. KRC content contains the `krc1` header and the format's compressed/encrypted payload; the app decodes word timing and available translations. If KRC is unavailable, it requests `fmt=lrc` with Base64-encoded UTF-8 LRC content. Line-only lyrics remain line-timed.

## Line-timed search/download protocol

Example endpoints: `https://lines.example.com/search` and `https://lines.example.com/download`. Search GET parameters are `s` (title and artist), `type=1`, `offset=0` and `limit=10`:

```json
{"code":200,"result":{"songs":[{"id":"track-1","name":"Example Song","artists":[{"name":"Example Artist"}],"album":{"name":"Example Album"},"duration":200000}]}}
```

Download GET parameters are `id`, `lv=1`, `kv=1` and `tv=1`:

```json
{"code":200,"lrc":{"lyric":"[00:01.000]Example lyric"},"tlyric":{"lyric":"[00:01.000]Example translation"}}
```

`tlyric` is optional and aligned by timestamp. Set **Source translation language** to identify supplied translations correctly when comparing the lyrics AI target language. Each generic protocol supports one optional endpoint pair. Services using another response shape need their own server-side adapter.

Requests have timeout, response-size and decoding limits. Failures retain existing lyrics. Matching still considers title, artist, version and duration; administrators can preview and import candidates in the workspace. Disabling a source does not delete saved lyrics. Older assets remain readable, while new requests use only enabled sources. The [demo](https://flaretune.arcinks.com/settings/admin/assistant) shows the same read-only configuration without fetching external lyrics.

[Back to administration](administration.en.md)
