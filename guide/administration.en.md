# Administration and maintenance

[简体中文](administration.md) · [English](administration.en.md)

Explore full pages and configuration dialogs in the [demo administration settings](https://flaretune.arcinks.com/settings/admin/assistant). The demo simulates an administrator with configuration available for viewing; make real changes in your own installation. See [demo details](demo.en.md).

## Admin entry points

After signing in, administrators can open Library management, Song ingest, Account management and Instance settings from the Settings sidebar, with optional features managed through Plugin list and Sources and deployment. Open an installed plugin's settings from its list entry; AI Gateway, Assistant and Lyrics Workbench each own their configuration page. Instance settings brings together the instance name, allowed origins, ingest devices, runtime status and database upgrades. Members cannot access these areas. Administrators import their own audio; the Worker reads local media from private R2, while external sources use their plugin's authorization and playback path.

Instance settings shows the app version, instance status, base schema version, and individual feature migrations. Administrators can apply compatible pending updates; the database is current only when no migration is pending. The former `/settings/admin/instance` URL redirects to Instance settings. Interface language is an account choice in Personal settings, not an instance-wide admin setting.

## AI connections

Install AI Gateway and the consumer plugins you need. Under Plugin list → AI Gateway → Settings → Provider configuration, select Add provider, choose a DeepSeek, OpenAI, Anthropic, Gemini or Custom connection preset, and enter the API key and display name (blank uses the preset name). Only added connections appear in the list. Add multiple connections of the same type, such as two DeepSeek accounts with different names and keys. Official connections use Chat Completions, Responses, Anthropic Messages and native Gemini respectively, with protocol and address supplied by the preset. Editing can rename a connection or update its key; leaving the key blank retains it. Add a new connection for a different preset. The gateway stores connections rather than each plugin's model profile.

For a third-party gateway, add a Custom provider with a name, one of the four protocols, an HTTPS base URL including the version prefix but not the final request path, and an API key. Only custom providers expose protocol and address controls. Use trusted public endpoints; local and private-network addresses are unsupported.

Open the model section in Assistant or Lyrics Workbench settings, initialize its configuration when prompted, then use Configure profile to choose a provider. Fetch models or enter a model ID; the consumer plugin saves its own vision declaration, temperature and other generation options. Plugins may share a provider while using different models. Changing provider/model requires reconfirming vision; discovery does not verify capabilities. Changing a custom protocol/address requires entering the key again, and affected consumer configurations do not automatically reuse their previous vision declaration or generation options. Keys remain encrypted in the gateway and are never returned to the browser.

## Lyric sources

After installing Lyrics Workbench, configure sources in its settings. Only LRCLIB is enabled by default; administrators can enable custom word-timed and line-timed endpoints. See [Lyric sources](lyric-sources.en.md) for request and response examples. Disabling a source retains saved lyrics. Sources, candidates and existing lyrics can be managed without AI.

## Add and remove music

In Song ingest, select files from the browser or folders on a connected [local ingest device](../tooling/ingest-agent/README.en.md). Adding songs switches to the ingest list; you can return to selection without losing the list. Both sources share editing, duplicate review, and saving. Device songs appear as paginated metadata cards; their original artwork is not loaded by default. For large scans, filter first, map language by folder, and select only the songs you need. Folder language can come from the folder name, audio tags and text detection, or an explicit choice. A mapping only affects songs added afterward; entries in the list remain editable. Review similar tracks before choosing Skip, Add another version, or Replace. Before replacement, the page checks whether the target song has changed. During a batch, Pause waits for the current song to finish. Continue processes only the remaining songs; failed entries can be retried separately.

The current web library's Delete button requires confirmation and rejects songs still referenced by playlists, listening data, or lyrics. Successful deletion removes only song metadata and retains audio and artwork. The web page has no option to remove references or clean up media. The old manually started local web tool has a separate impact-preview and cleanup flow; it is not part of the ingest-device program and does not describe the current web button.

## Database upgrades

| Instance state | Action |
| --- | --- |
| Known compatible old schema, administrator can sign in | View current and target versions in Instance settings and start the built-in upgrade. |
| Known old version requiring a service pause | On the maintenance page, the deployer verifies `SETUP_SECRET` and continues in batches; sign-in is unavailable during maintenance. |
| Unknown version, inconsistent ledger, or damaged structure | Keep the service closed. Diagnose outside the app using backups; there is no automatic repair. |

The upgrade endpoint runs only the ordered migrations built into the current Worker. It cannot execute arbitrary SQL or downgrade the schema. When legacy shared playlist data is found, the ordinary administrator path requires a D1 backup. After confirming the backup, continue with the setup secret on the maintenance page. Business APIs stay closed during upgrades, and the page shows batch progress. Plan a backup and recovery path before a major upgrade.

## User images and assistant image input

Apply supplemental migrations 0009 (AI protocols), 0010 (private user images), and 0011 (per-feature models) in Instance settings. Existing text functionality remains available before migration.

Personal settings supports your own avatar; ordinary personal playlist details supports your own cover. Favorites retain their fixed star; shared albums are unchanged. Choose JPEG, PNG, or WebP up to 5 MiB and 20 megapixels. Avatar and cover crops support drag, zoom, and keyboard position sliders and export square static WebP at 512 and 1024 pixels respectively, without an extra original copy.

In Assistant plugin settings, enable **Allow assistant image input** (off by default), and declare **This model supports vision** in the model configuration on the same page based on its actual capabilities. A configuration without that declaration is not automatically treated as vision-capable. Attach up to 4 images per message, preserving aspect ratio with a 2048-pixel longest edge. The latest 4 images within the last 24 messages can be replayed for follow-up questions; older images require reattachment. Replaying images may incur provider image-input charges. Disabling the switch or using a non-vision model stops new and historical image transmission while text remains usable and stored images remain owner-only. Avatars and playlist covers are never automatically sent to the model.

Private R2 keys are `users/<internal-account-id>/avatars/`, `playlist-covers/`, and `chat-images/`, with random filenames and database-owned references. The `users/` namespace is reserved: do not set shared `MEDIA_PREFIX` to `users` or a child, and keep the bucket private. Administrators cannot read other accounts' images through the app. Later image writes retry up to 10 unused drafts older than 24 hours or failed-delete tombstones per request; successful replacement cleans only unreferenced old artwork. Back up both D1 and R2.

## Credentials and data

- `SETUP_SECRET` authorizes first claim, known maintenance upgrades, and encryption of saved AI model keys. It cannot reset an administrator.
- Administrators configure AI provider keys when needed; they are optional at first deployment.
- D1 stores accounts, sessions, personal music data, and instance settings. R2 stores audio, artwork, and generated media. Deployers are responsible for rights to and backups of their music and artwork.
