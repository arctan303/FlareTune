# Administration and maintenance

[简体中文](administration.md) · [English](administration.en.md)

## Admin entry points

After signing in, administrators can open Library management, Song ingest, AI and assistant, Account management, and Instance settings from the Settings sidebar. Instance settings brings together the instance name, allowed origins, ingest devices, runtime status, and database upgrades. Members cannot access these areas. Administrators import their own music files. The Worker reads media from private R2 and checks session access.

Instance settings shows the app version, instance status, and current and target database schema versions. Administrators can apply a compatible upgrade or the supplemental AI connection migration when available; the database is current only when no migration is pending. The former `/settings/admin/instance` URL redirects to Instance settings. Interface language is an account choice in Personal settings, not an instance-wide admin setting.

## AI connections

Under Provider configuration, select Add provider, choose a DeepSeek, OpenAI, Anthropic, Gemini, or Custom connection preset, and enter the API key and display name (blank uses the preset name). Only added connections appear in the list. Add multiple connections of the same type, such as two DeepSeek accounts with different names and keys. New official connections use Chat Completions, Responses, Anthropic Messages, and native Gemini respectively; model, protocol, address, and advanced connection fields stay hidden. Editing can rename a connection or update its key; leaving the key blank retains it. The preset cannot be changed after saving: add a new connection for a different preset.

For a third-party gateway, add a Custom provider with a name, one of the four protocols, an HTTPS base URL including the version prefix but not the final request path, and an API key. Only custom providers expose protocol and address controls. Use trusted public endpoints; local and private-network addresses are unsupported.

Under Feature configuration, select a provider separately for the music assistant and lyrics AI. Fetch models for direct selection or enter a model ID, declare This model supports vision based on its actual capabilities, and save. Features may share a provider while using different models. Changing provider/model requires reconfirming vision; discovery does not verify capabilities. Changing a custom protocol/address requires entering the key again and clears the affected features' vision declaration and generation options. Historical protocols and destinations are retained; old proxy connections appear as custom, and old keys are not merged. Keys remain encrypted and are never returned to the browser.

## Add and remove music

In Song ingest, select files from the browser or folders on a connected [local ingest device](../tooling/ingest-agent/README.en.md). Adding songs switches to the ingest list; you can return to selection without losing the list. Both sources share editing, duplicate review, and saving. Device songs appear as paginated metadata cards; their original artwork is not loaded by default. For large scans, filter first, map language by folder, and select only the songs you need. Folder language can come from the folder name, audio tags and text detection, or an explicit choice. A mapping only affects songs added afterward; entries in the list remain editable. Review similar tracks before choosing Skip, Add another version, or Replace. Before replacement, the page checks whether the target song has changed. During a batch, Pause waits for the current song to finish. Continue processes only the remaining songs; failed entries can be retried separately.

Before deleting a song, review the impact on personal playlists, lyrics, play history, and media. Media still referenced by other songs is retained. Back up any data you need to keep. If the result reports file cleanup failure, the song record may already be deleted. Check the reported R2 path and other track references before removing leftover files manually; clicking Delete again is not a file retry.

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

Enable **Allow assistant image input** (off by default), and explicitly declare **This model supports vision** in the music assistant's feature configuration based on its actual capabilities. Legacy deployment configuration is not automatically treated as vision-capable. Attach up to 4 images per message, preserving aspect ratio with a 2048-pixel longest edge. The latest 4 images within the last 24 messages can be replayed for follow-up questions; older images require reattachment. Replaying images may incur provider image-input charges. Disabling the switch or using a non-vision model stops new and historical image transmission while text remains usable and stored images remain owner-only. Avatars and playlist covers are never automatically sent to the model.

Private R2 keys are `users/<internal-account-id>/avatars/`, `playlist-covers/`, and `chat-images/`, with random filenames and database-owned references. The `users/` namespace is reserved: do not set shared `MEDIA_PREFIX` to `users` or a child, and keep the bucket private. Administrators cannot read other accounts' images through the app. Later image writes retry up to 10 unused drafts older than 24 hours or failed-delete tombstones per request; successful replacement cleans only unreferenced old artwork. Back up both D1 and R2.

## Credentials and data

- `SETUP_SECRET` authorizes first claim, known maintenance upgrades, and encryption of saved AI model keys. It cannot reset an administrator.
- Administrators configure AI provider keys when needed; they are optional at first deployment.
- D1 stores accounts, sessions, personal music data, and instance settings. R2 stores audio, artwork, and generated media. Deployers are responsible for rights to and backups of their music and artwork.
