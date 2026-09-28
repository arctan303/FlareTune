# Administration and maintenance

[简体中文](administration.md) · [English](administration.en.md)

## Admin entry points

After signing in, administrators can open Library management, Song ingest, AI and assistant, Account management, and System management from the Settings sidebar. System management brings together the instance name, allowed origins, ingest devices, runtime status, and database upgrades. Members cannot access these areas. Administrators import their own music files. The Worker reads media from private R2 and checks session access.

System management shows the app version, instance status, and current and target database schema versions. Administrators can start a known compatible upgrade when one is available; otherwise the page reports that the database is current. The former `/settings/admin/instance` URL redirects to System management. Interface language is an account choice in Personal settings, not an instance-wide admin setting.

## Add and remove music

In Song ingest, select files from the browser or folders on a connected [local ingest device](../tooling/ingest-agent/README.en.md). Adding songs switches to the ingest list; you can return to selection without losing the list. Both sources share editing, duplicate review, and saving. Device songs appear as paginated metadata cards; their original artwork is not loaded by default. For large scans, filter first, map language by folder, and select only the songs you need. Folder language can come from the folder name, audio tags and text detection, or an explicit choice. A mapping only affects songs added afterward; entries in the list remain editable. Review similar tracks before choosing Skip, Add another version, or Replace. Before replacement, the page checks whether the target song has changed. During a batch, Pause waits for the current song to finish. Continue processes only the remaining songs; failed entries can be retried separately.

Before deleting a song, review the impact on personal playlists, lyrics, play history, and media. Media still referenced by other songs is retained. Back up any data you need to keep. If the result reports file cleanup failure, the song record may already be deleted. Check the reported R2 path and other track references before removing leftover files manually; clicking Delete again is not a file retry.

## Database upgrades

| Instance state | Action |
| --- | --- |
| Known compatible old schema, administrator can sign in | View current and target versions in System management and start the built-in upgrade. |
| Known old version requiring a service pause | On the maintenance page, the deployer verifies `SETUP_SECRET` and continues in batches; sign-in is unavailable during maintenance. |
| Unknown version, inconsistent ledger, or damaged structure | Keep the service closed. Diagnose outside the app using backups; there is no automatic repair. |

The upgrade endpoint runs only the ordered migrations built into the current Worker. It cannot execute arbitrary SQL or downgrade the schema. When legacy shared playlist data is found, the ordinary administrator path requires a D1 backup. After confirming the backup, continue with the setup secret on the maintenance page. Business APIs stay closed during upgrades, and the page shows batch progress. Plan a backup and recovery path before a major upgrade.

## Credentials and data

- `SETUP_SECRET` authorizes first claim, known maintenance upgrades, and encryption of saved AI model keys. It cannot reset an administrator.
- Administrators configure AI provider keys when needed; they are optional at first deployment.
- D1 stores accounts, sessions, personal music data, and instance settings. R2 stores audio, artwork, and generated media. Deployers are responsible for rights to and backups of their music and artwork.
