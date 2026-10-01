# Third-party music clients

[简体中文](subsonic.md) · [User guide](using-flaretune.en.md)

FlareTune implements a music subset of Subsonic 1.16.1 and the OpenSubsonic lyrics extension. Local automated checks are available; **this version has not yet been accepted using real clients such as StreamMusic**. Compatibility with every Subsonic client is not promised.

## Connect

1. Open Settings → Personal settings → Third-party music clients.
2. Enable Subsonic connections and verify your current account password.
3. Choose **Subsonic** in the client. Enter the site root, such as `https://music.example.com`, without `/rest`. Use your existing username/password and **token/salt authentication**.
4. Select original quality and turn off server transcoding or bitrate limits.

Access is off by default. Changing your password or an administrator resetting it turns access off and deletes the encrypted copy. Sign in with the new password and enable access again. Disabling access rejects new requests, including media requests; it does not erase files already cached on the client. Disabled accounts and accounts requiring a password change cannot connect.

Token/salt compatibility requires an additional AES-GCM encrypted copy of the password, bound to the account and password version. The normal website keeps its existing irreversible password hash. Disabling access, changing or resetting the password deletes the copy. Encryption uses a separate key derivation from AI credentials; rotating `SETUP_SECRET` requires enabling access again. The settings API never returns the password, and the web UI does not persist it.

## Capabilities and limits

Supported: browsing, search, original audio playback/download, HTTP Range seeking, covers, existing canonical R2 lyrics, song favorites and private playlist CRUD. Favorites/playlists are shared with the web UI. Existing limits apply: 50 regular playlists per account, 500 distinct songs per playlist. Album/artist favorites are unsupported.

No live transcoding, image resizing, playback count reporting, history/queue synchronization, public playlists, podcasts, videos, account or catalog administration. `scrobble` returns unsupported; streams/downloads do not increment web play counts. Missing lyrics return an empty result without external fetching or AI work. Recent/frequent album lists are empty.

Grouping uses existing artist credits and album names, retaining joint credits. Song IDs match the native API; artist/album IDs are deterministic from their names and change on rename. A shared catalog view is cached per Worker instance for 60 seconds, with a 10000-song bound and 500 results per page. Larger catalogs fail explicitly; empty-query search supports paged synchronization. Catalog edits may take about 60 seconds to appear; media requests still query the current song. Actual cold-start and large-library D1 cost must be measured after deployment.

GET only, with HEAD for media; JSON/XML and `.view` paths are supported. Capability discovery is public, all other requests verify account opt-in and credentials. Password parameter `p`, API keys and form POST are unsupported. HTTPS is required outside loopback. Failed protocol authentication has bounded, per-Worker-instance in-memory rate limiting, not global enforcement. Enabling access reuses the durable login rate limiter.

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
