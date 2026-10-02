# Third-party music clients

[简体中文](subsonic.md) · [User guide](using-flaretune.en.md)

FlareTune implements a music subset of Subsonic 1.16.1 and the OpenSubsonic lyrics extension. Local automated checks are available; **complete third-party client acceptance is still in progress**. Compatibility with every Subsonic client is not promised.

Development verification (2026-10-02): Musiver 1.3.9 on Windows has been checked for actual audio cache files, pause/resume, seeking, track switching, covers, and existing lyrics. Private playlists are visible in both directions between the web API and Musiver. Native playlist creation/song addition and starring/unstarring reached the server; remaining playlist CRUD and favorite writes were checked between the protocol and web API. The tools did not listen to audio. Audible playback, complete native playlist editing, local copies after server deletion, other formats/systems/clients still need checks. Download management leads to the Musiver membership page, so offline playback remains unverified. These patches have not entered a formal release.

## Connect

1. Open Settings → Personal settings → Third-party music clients.
2. Enable Subsonic connections and verify your current account password.
3. Choose **Subsonic** in the client. Enter the site root, such as `https://music.example.com`, without `/rest`. Use your existing username/password and **token/salt authentication**.
4. Select original quality and turn off server transcoding or bitrate limits.

Access is off by default. Changing your password or an administrator resetting it turns access off and deletes the encrypted copy. Sign in with the new password and enable access again. Disabling access rejects new requests, including media requests; it does not erase files already cached on the client. Disabled accounts and accounts requiring a password change cannot connect.

If individual tracks remain at 00:00 after enabling access, first check original quality and the server connection, then use the client's cache management to retrieve the affected tracks again. Development testing found that Musiver can save earlier protocol-error XML as an `.mp3` cache file. A server fix or restored access does not automatically replace these old files. Do not delete server music or favorites to repair client caches.

Token/salt compatibility requires an additional AES-GCM encrypted copy of the password, bound to the account and password version. The normal website keeps its existing irreversible password hash. Disabling access, changing or resetting the password deletes the copy. Encryption uses a separate key derivation from AI credentials; rotating `SETUP_SECRET` requires enabling access again. The settings API never returns the password, and the web UI does not persist it.

## Capabilities and limits

Supported: browsing, search, original audio playback/download, HTTP Range seeking, covers, existing canonical R2 lyrics, song favorites and private playlist CRUD. Favorites/playlists are shared with the web UI. Existing limits apply: 50 regular playlists per account, 500 distinct songs per playlist. Album/artist favorites are unsupported.

No live transcoding, image resizing, playback count reporting, history/queue synchronization, public playlists, podcasts, videos, account or catalog administration. `scrobble` returns unsupported; streams/downloads do not increment web play counts. Missing lyrics return an empty result without external fetching or AI work. Recent/frequent album lists are empty.

### Word timing and translation layers (development deployment, not formally released)

- Subsonic `getLyrics` returns saved original text. Default `getLyricsBySongId`, including `enhanced=false`, keeps the existing line timing or unsynchronized text response.
- Discovery advertises `songLyrics` versions `[1,2]`. Clients implementing v2 can request `getLyricsBySongId` with `enhanced=true` to receive a `kind=main` layer with `cueLine/cue` word start/end times in milliseconds, plus a separate `kind=translation` layer for saved translations. Byte ranges address the exact UTF-8 original, including CJK and emoji.
- Saved offsets apply once to both line and word times. Lyrics without word timing fall back to lines; untimed lyrics remain text. Translations inherit their original row times, without invented word timing. Unknown languages use `und`; existing provider and legacy AI Chinese conventions are preserved. Internal provider IDs, AI/account state are omitted. No external lyrics or AI requests are triggered.

Development favorites verified 501 word-timed lines, 3,220 cues and 470 translated lines across JSON/XML, with unchanged default-response hashes. **Server support does not prove client display support.** The current Windows Musiver was observed showing an LRC page; word highlighting and translation display remain unverified. Clients must implement and opt into enhanced mode. Enabling account access alone does not add client display features. See [songLyrics v2](https://opensubsonic.netlify.app/docs/extensions/songlyrics/).

Grouping uses existing artist credits and album names, retaining joint credits. Song IDs match the native API; artist/album IDs are deterministic from their names and change on rename. A shared catalog view is cached per Worker instance for 60 seconds, with a 10000-song bound and 500 results per page. Larger catalogs fail explicitly; empty-query search supports paged synchronization. Catalog edits may take about 60 seconds to appear; media requests still query the current song. Actual cold-start and large-library D1 cost must be measured after deployment.

GET only, with HEAD for media; JSON/XML and `.view` paths are supported. Capability discovery is public, all other requests verify account opt-in and credentials. Password parameter `p`, API keys and form POST are unsupported. HTTPS is required outside loopback. Failed protocol authentication has bounded, per-Worker-instance in-memory rate limiting, not global enforcement. Enabling access reuses the durable login rate limiter.

Development media-error behavior (not formally released): streams, downloads and covers return text/xml errors regardless of f=json. Protocol code 70 maps to HTTP404, 40/50 to 403, other protocol errors to 400, and unavailable services to 503; HEAD has no body. Metadata keeps HTTP200 and the selected JSON/XML format. 43 targeted regressions and independent review passed. The development deployment was checked in Musiver: a new failure left no audio cache, and restoring the same track retrieved actual audio. Clients relying on HTTP200 media errors must adapt. Content-Type alone does not prevent Musiver 1.3.9 from caching error documents; existing invalid caches still need retrieval again.

## Acceptance checklist

Record the FlareTune commit, client version and operating system:

- Connection is rejected while disabled; after enabling, browse artists/albums and search for a known song.
- Confirm audible playback, pause/resume, seeking, continuous playback, covers and existing lyrics.
- Download and play offline; verify behavior for unsupported audio formats.
- Add/remove favorites and verify both directions between web and client after refreshing.
- Create, rename and delete playlists; add/remove songs and check both interfaces.
- Another account cannot see personal playlists/favorites, and a member cannot manage accounts/catalog.
- Turning access off rejects new requests. Password changes turn access off; the old password fails, and the new one works only after enabling again.

Report steps and sanitized errors. Do not share passwords, complete request URLs or logs containing `t` and `s`.

## Deployment and logs

No schema migration is needed. Existing `DB`, `MEDIA_BUCKET` and `SETUP_SECRET` bindings are used. Custom asset routing must send `/rest` and `/rest/*` to the Worker. Templates disable invocation logs containing request URLs to avoid retaining token/salt credentials. Custom proxies, Tail, Logpush and external monitoring must also remove query parameters. Test with a test account after deployment. The settings switch retains normal session, CSRF and account protections.

References: [Subsonic API](https://www.subsonic.org/pages/api.jsp), [OpenSubsonic discovery](https://opensubsonic.netlify.app/docs/endpoints/getopensubsonicextensions/), [Cloudflare request logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/).
