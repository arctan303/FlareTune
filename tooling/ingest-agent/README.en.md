# Local ingest device guide

[简体中文](README.md) · [English](README.en.md)

This tool reads audio files on the computer that stores your music and connects outward to your FlareTune instance. An administrator selects folder tracks in the player's web admin page. Browser files and device tracks enter the same ingest list and share editing, duplicate review, and saving. The device and browser can run on different computers; no inbound public port is needed on the device.

## Before you begin

- Install Node.js 22.12.0 or newer on the music computer and obtain FlareTune project code compatible with your instance. Ingest device endpoints are available starting with FlareTune 1.1.0.
- Have an administrator account and one or more readable music folders on the device. The device must reach the instance URL; the browser computer only needs access to the player admin page.
- Install dependencies from the repository root. Use `npm ci` on first setup. In Windows PowerShell, use `npm.cmd` for the commands below.

## First configuration

```sh
npm ci
npm run ingest:configure
```

Answer the terminal prompts for device name, instance base URL, administrator username and password, and music folders. Folders must be absolute paths on this device; enter 1–16 paths separated by `;`, for example `D:\music;E:\albums` on Windows or `/home/me/music;/mnt/albums` on macOS/Linux. The command validates folders and administrator sign-in before saving. You do not need to enter them on every start.

The password is stored directly in this device's user configuration file. Run the tool only on a device you trust. The file is outside the repository:

| System | Configuration file |
| --- | --- |
| Windows | `%APPDATA%\FlareTune\ingest-agent.json` |
| macOS | `~/Library/Application Support/FlareTune/ingest-agent.json` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/flaretune/ingest-agent.json` |

Run `npm run ingest:configure` again to change the device name, instance, account, or folders; it retains the device identity. Reconfigure after changing the administrator password. Terminal prompts and logs use English.

## Start the device and select songs in the web app

```sh
npm run ingest
```

Keep the terminal running. The process signs in, scans the configured folders, and reports its connection status. It does not start a separate web page or listen on a local port. Multiple devices may connect to one instance, each with its own configuration.

1. Sign in as an administrator and open **Settings → System management**. Check that the device appears online under Ingest devices and review its last scan time.
2. Open **Settings → Song ingest → Select songs → Connected device folders**, then select the device. Refresh the device list or choose Rescan to read new folder changes.
3. The page checks the current catalog and initially shows **New**. Switch between suspected duplicates, imported files, changed files, unfinished transfers, and all files. Combine categories with text and folder filters. **Select new only** selects new candidates within those text/folder filters; **Exclude duplicates** deselects suspected duplicates. Add your selection to the ingest list. To retain another version, add it from the duplicate category and review it in the queue.
4. In the ingest list, review titles, albums, artwork, and language. Edit entries as needed. Review similar songs and choose Skip, Add, or Replace before importing. Batch ingest can pause after the current song and resume the remaining songs. Retry failures individually.

Scanning, filtering, selecting, and adding to the preview list do not upload audio. Files are read and transferred only during ingest. Device cards do not load every original cover by default; preview an individual cover when needed.

### Local ingest history

The tool maintains `ingest-history.sqlite` beside its configuration file. It stores scan metadata, file identities, media jobs, and errors; rescanning reconciles media references with the current catalog. Records are isolated by instance, administrator identity, and device identity. Audio, artwork bytes, and passwords are not stored in this database. A successful media transfer remains unfinished until a current catalog song references that audio. After a restart or page reload, reselecting an unfinished file reuses its original device job rather than uploading completed media again. Changed files require another review.

Duplicate detection keeps the existing title, artist, and duration rules. It does not distinguish audio quality or reliably identify every alternate version. The queue's **Exclude duplicates** removes only unapproved suspected duplicates and retains completed imports and explicit Add/Replace choices; it deletes no local files or catalog songs. Older imports without local records can still be detected through catalog metadata matching.

Closing the browser does not continue saving songs. Directory watching and automatic ingest are not enabled. Rescan to discover new files; use **Check again** after catalog changes.

### Folder language mapping

Folders named `zh`, `en`, `jp`/`ja`/`jn`, `ko`, `yue`, `纯音乐`, or `instrumental` can provide a language suggestion. For each folder, you can instead choose automatic tag/text detection or an explicit language. The mapping affects only songs subsequently added to the ingest list. Existing entries remain editable, and automatic suggestions need human review.

## Limits and troubleshooting

- The current tool uploads through the administrator media endpoint. Each file is limited to 100 MB, and upload jobs run in sequence; direct R2 upload is not yet supported. Filter and import large collections in batches.
- An offline device still shows its last scan information in the admin page but cannot provide new selections or rescans. Check that its terminal remains open, it can reach the instance, the instance supports ingest devices, and the administrator account is valid. Rescan after reconnecting or changing a local file.
- For a temporary `fetch failed`, job polling retries every ten seconds without reconfiguration or a rescan. Logs include underlying codes such as `ECONNRESET` and timeouts where available. For repeated failures, check the connection or proxy between the device and instance.
- After an upload disconnects, the tool checks and retries with the original media ID to avoid duplicate media. If a song ultimately fails, review the error in the admin page and retry it there.
- After updating the tool code, stop the old process and run `npm run ingest` again; saved configuration remains usable. Press `Ctrl+C` to stop the process.

For feedback and development, see [Contributing](../../CONTRIBUTING.en.md). Share only redacted logs publicly; do not attach music files or account credentials.
