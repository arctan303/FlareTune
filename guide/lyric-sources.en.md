# Lyric sources

[简体中文](lyric-sources.md) · [English](lyric-sources.en.md)

Administrators manage one list under **Settings → AI and assistant → Lyric sources**. Built-in LRCLIB is always enabled and has no Edit, Delete or toggle controls. Choose **Add source**, then enter a name, optional note, search/download URLs and source translation language. You do not select a lyric type: the app detects word timing, line timing or plain text from the downloaded content. You can add up to eight independent sources, each with Edit, Delete and enable controls. Names distinguish sources in candidate lists; notes are visible only to administrators. Disabling retains its configuration; deleting preserves saved lyrics. Save changes only the selected source, while Cancel discards the draft. Refresh the page and reopen after a revision conflict.

Previous custom configurations retain their endpoints and IDs when read, and the first save writes the new named-source list. LRCLIB always uses its official URL, `https://lrclib.net/api`; previous changes to its URL or enabled state no longer apply. Restore the previous lyric-source settings snapshot together with older code when rolling back.

Customization covers endpoint URLs and source details; requests and responses must follow the formats below. There is no arbitrary request-header or script editor. Use HTTPS search and download endpoint URLs you are entitled to access. The domains below are examples. URLs cannot include credentials, query strings or fragments; IP literals, local hostnames, nonstandard ports and redirects are unsupported. Requests contain song metadata and candidate identifiers, without application login credentials. Only administrators receive endpoint URLs; members can read enabled source IDs, names and lyrics.

## Quick test

Enter the endpoint URLs in the Add or Edit source dialog, then run the quick test. When a current song is available, its title, artist and available duration are filled in automatically. You can use the current song again or enter a title and artist yourself. The test uses the current unsaved draft; you do not need to save or enable the source first.

The test searches, then downloads and parses up to the first three candidates. Results show the candidate count, search/download/parsing stages and elapsed time. A successful parse shows the actual lyric type, line count and whether a translation is available. No candidates means this search found no match and downloading remains unverified; it does not establish that the service is broken or fully usable. Network, timeout, download and parsing failures show a reason and can be retried after editing the inputs. Test again after changing the source or test song.

Testing does not save source settings, change songs or lyrics, or call the lyrics AI. Click **Save** separately to keep the configuration. Results contain summaries without raw upstream content, endpoint URLs or candidate access tokens. Only administrators can run the test. The [demo](https://flaretune.arcinks.com/settings/admin/assistant) shows the same configuration and test area with read-only management controls and no external lyric requests.

## Search and download endpoints

Example endpoints: `https://lyrics.example.com/search` and `https://lyrics.example.com/download`. Search uses GET with `keyword` (title and artist), `duration` (milliseconds, when available), `ver=1`, `man=yes` and `client=pc`:

```json
{"candidates":[{"id":"track-1","accesskey":"candidate-token","song":"Example Song","singer":"Example Artist","album":"Example Album","duration":200000}]}
```

Download uses GET with `id`, `accesskey` from search, `fmt=krc`, `charset=utf8`, `ver=1` and `client=pc`. Return `{"content":"BASE64_CONTENT"}`. KRC content contains the `krc1` header and the format's compressed/encrypted payload; the app decodes word timing and available translations. If KRC is unavailable, it requests `fmt=lrc` with Base64-encoded UTF-8 LRC content. Word timestamps produce word-timed lyrics, line timestamps produce line-timed lyrics, and content without timing produces plain text. The app does not invent higher timing precision.

## Legacy endpoint compatibility

Previously configured sources using the alternative search/download format keep that format. There is no need to recreate the source or migrate its URLs. This is internal compatibility for existing sources; the Add source dialog no longer offers a format selector:

Example endpoints: `https://lines.example.com/search` and `https://lines.example.com/download`. Search GET parameters are `s` (title and artist), `type=1`, `offset=0` and `limit=10`:

```json
{"code":200,"result":{"songs":[{"id":"track-1","name":"Example Song","artists":[{"name":"Example Artist"}],"album":{"name":"Example Album"},"duration":200000}]}}
```

Download GET parameters are `id`, `lv=1`, `kv=1` and `tv=1`:

```json
{"code":200,"lrc":{"lyric":"[00:01.000]Example lyric"},"tlyric":{"lyric":"[00:01.000]Example translation"}}
```

`tlyric` is optional and aligned by timestamp. Set **Source translation language** to identify supplied translations correctly when comparing the lyrics AI target language. Each source stores its own endpoint pair. Services using another response shape need their own server-side adapter.

Source requests and tests have timeout, response-size and decoding limits. Failures retain existing lyrics. Matching still considers title, artist, version and duration; administrators can preview and import candidates in the workspace. Disabling a source does not delete saved lyrics. Older assets remain readable, while new requests use only enabled sources.

Queries across sources share a bounded request budget while preserving built-in LRCLIB fallback capacity. Searching many sources can reach the operation's request limit; the interface distinguishes this from upstream throttling. Completed lyrics and candidates remain available. Select fewer sources and retry if the operation reaches its limit.

Duplicate LRCLIB requests are coalesced, successful candidate summaries are briefly reused and outgoing calls are paced; preview inspection and import still perform fresh validation. Upstream rate limits honor Retry-After, with a 30-second cooldown when no wait is provided. Candidate search and preview failures show a reason and countdown, followed by an explicit retry. Retrying one source retains other candidates and does not start an automatic retry loop. Third-party services may still refuse requests, and the displayed wait does not guarantee recovery.

[Back to administration](administration.en.md)
