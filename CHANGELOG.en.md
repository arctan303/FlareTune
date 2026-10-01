# Changelog

[简体中文](CHANGELOG.md)

## 1.1.1 — 2026-10-01

This release improves the bilingual interface, third-party client access, assistant recovery, and everyday browsing and settings.

### Language and settings

- Add account-level preferences for Follow browser, Simplified Chinese, and English. Signed-out pages follow the browser with English as the fallback. Preferences sync with the account without translating music metadata, lyrics, input, or AI rules.
- Complete English UI coverage across playback, search, catalog exploration, playlists, assistant, sign-in, and administration. Add bilingual project, deployment, usage, development, contribution, and client guides; fix untranslated Explore categories, Back buttons, and song counts.
- Remove redundant descriptions while retaining meaningful permission, format, privacy, data-impact, and failure messages.
- Use button groups for short fixed choices and a shared themed dropdown for longer lists, with selection marks, keyboard controls, Escape dismissal, and narrow-screen support. Use sliding switches for memory and personal connections.
- Rename the admin group to Administration and its system page to Instance settings.

### Third-party music clients (Beta)

- Add a personal Subsonic switch, disabled by default. Support a music subset of Subsonic 1.16.1 and the OpenSubsonic lyrics extension using the existing username/password and token/salt authentication.
- Support browsing, search, original-file streaming/downloads, HTTP Range seeking, covers, existing lyrics, song favorites, and private playlist CRUD. Favorites/playlists share web data and remain isolated between accounts.
- Verify the current password before enabling access and encrypt the compatibility copy using a separately derived SETUP_SECRET key. Disabling access, changing the password, or an administrator resetting it deletes the copy and turns access off; re-enable with the new password.
- Mark the settings card Beta and show a switch, short reminder, and [connection guide](guide/subsonic.en.md).
- Bound the short-lived catalog cache, aggregate playlist summaries per account, and batch playlist song writes while retaining transactions and revision checks.
- Revalidate database structure for every protocol mutation, even after read-cache warmup, and reject writes if required count triggers are missing. Keep the advertised server version aligned with the package version.
- Transcoding, resized covers, scrobble statistics, history/queue sync, public playlists, podcasts, and administration are unsupported. Real-client audio acceptance remains pending; see the guide for limits.

### Assistant and memory

- Show the current processing stage inline: thinking, calling a tool, or writing. Completed turns retain a compact completion/expand control.
- Preserve tool traces when history refreshes return partial data, and expanded state when a message receives its canonical ID.
- Preserve available thinking, tool progress, and public failure reasons after an interrupted request and reload. Subsequent model turns receive failure records and known executed results.
- Distinguish tool-call count limits, malformed IDs, and duplicate IDs; tell the model the existing budget without relaxing execution or permission limits.
- Show memory creation and modification dates using the interface locale, and replace the checkbox with a sliding switch.
- Use the generic Memory updated notification for additions and edits without repeating memory content.

### Browsing, Roam, and library

- Submit search explicitly instead of requesting on every keystroke or hover; enlarge search controls for touch.
- Retain loaded Home, Search, and Explore content and return state within the session. Reuse cover nodes and frequent-listening previews; load full statistics on demand to reduce repeated requests and scans.
- Sample Roam from a cached song-ID directory, exclude a recent-play window of about 20% of the catalog, and replenish continuous queues while retaining language selections and small-catalog behavior.
- Bound and align the radio panel and exploration area, wrap language options, and use three/two/one exploration columns according to content width.
- Show playlist loading, failure, and retry states instead of treating failed reads as zero playlists; preserve available lists including Favorites.
- Reuse bounded album-card sizing for playlist covers to prevent unlimited scaling on wide screens.
- Show layout-matched song, artist, and album skeletons during Explore loading, with independent result fades. Cached content appears immediately without artificial delay.

### Interaction and runtime configuration

- Add short directional transitions between primary and secondary navigation, plus lightweight press, dropdown, language-choice, switch, and mobile-backdrop feedback.
- Keep transitions around 150–180ms, cancellable, and compatible with reduced-motion preferences. Retain player/account nodes and avoid replaying retained-page entrances.
- Persist development invocation logs with query-string redaction. The default template still disables raw invocation URL logging that could retain Subsonic token/salt credentials.

### Upgrade notes and known limits

- Update both frontend and Worker for assistant failure records and Subsonic endpoints. No new database migration is required.
- Custom routing must send /rest and /rest/* to the Worker. Confirm HTTPS, SETUP_SECRET, and query-string redaction before opting in; do not share passwords or complete authenticated URLs.
- Client streaming does not increment web play counts. Validate real-client compatibility and cold-start/large-library cost on the target instance.
- One-click installation from a completely new Cloudflare account still needs independent acceptance. Release publication does not imply that every production business flow has been verified.


## Earlier releases

See the preserved [1.1.0 and 1.0.0 release history](CHANGELOG.md#110--2026-09-28).
