# Lyric sources

[简体中文](lyric-sources.md) · [English](lyric-sources.en.md)

Administrators manage one list under **Settings → AI and assistant → Lyric sources**. Built-in LRCLIB is always enabled and has no Edit, Delete or toggle controls. Choose **Add source**, enter a name and optional note, select the word-timed or line-timed protocol, then provide its search/download URLs and translation language. You can add multiple sources using the same protocol, up to eight sources in total. Each has its own Edit, Delete and enable controls. Names distinguish sources in candidate lists; notes are visible only to administrators. An existing source keeps its protocol; add a new source to use another protocol. Disabling retains its configuration; deleting preserves saved lyrics. Save changes only the selected source, while Cancel discards the draft. Refresh the page and reopen after a revision conflict.

Previous custom configurations retain their endpoints and IDs when read, and the first save writes the new named-source list. LRCLIB always uses its official URL, `https://lrclib.net/api`; previous changes to its URL or enabled state no longer apply. Restore the previous lyric-source settings snapshot together with older code when rolling back.

Custom services must implement the relevant protocol below. Use HTTPS search and download endpoint URLs you are entitled to access. The domains below are examples. URLs cannot include credentials, query strings or fragments; IP literals, local hostnames, nonstandard ports and redirects are unsupported. Requests contain song metadata and candidate identifiers, without application login credentials. Only administrators receive endpoint URLs; members can read enabled source IDs, names and lyrics.

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

`tlyric` is optional and aligned by timestamp. Set **Source translation language** to identify supplied translations correctly when comparing the lyrics AI target language. Each source stores its own endpoint pair. Services using another response shape need their own server-side adapter.

Requests have timeout, response-size and decoding limits. Failures retain existing lyrics. Matching still considers title, artist, version and duration; administrators can preview and import candidates in the workspace. Disabling a source does not delete saved lyrics. Older assets remain readable, while new requests use only enabled sources. The [demo](https://flaretune.arcinks.com/settings/admin/assistant) shows the same read-only configuration without fetching external lyrics.

[Back to administration](administration.en.md)
