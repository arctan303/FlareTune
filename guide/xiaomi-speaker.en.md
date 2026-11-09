# Xiaomi speaker output

This development feature supports Xiaomi Smart Speaker Play **L05B** and library MP3 files. Enable one switch and keep using the existing browser queue, playback and volume controls. The browser keeps its stream running for lyrics and progress but stays muted; only the speaker produces sound. Timing differences are expected. The reference firmware is **1.68.2**. Other models, firmware and formats are unverified.

## Connect and play

1. Xiaomi speaker is not installed by default. An administrator first installs it at **Settings → Administration → Plugins → Xiaomi speaker**. Each user then opens **Settings → Plugins in the personal section → Xiaomi speaker → Account connection**, reads the authorization notice and connects their own Xiaomi account.
2. Scan with the Xiaomi account that owns the speaker and confirm on your phone. QR codes last about five minutes. Retry the authorization check after a connection failure, or generate a new QR code after expiry.
3. Open **Speaker output** in the player or track menu, select an L05B and enable output. Paused local playback stays paused; otherwise the current track is sent.
4. Select tracks, skip, pause/resume and edit the existing queue normally. The browser chooses the next track and the speaker follows. Only MP3 is supported; there is no transcoding.
5. Volume keeps its original single slider. The slider, mute, wheel and shortcuts all control the current output: speaker while enabled, browser while disabled. The browser retains its saved volume and cannot be made audible alongside speaker output.
6. Disable output to stop this speaker playback, then restore the browser's original mute state while its stream continues. An uncertain stop keeps the browser muted. If another source has taken over or authorization is lost, the browser pauses before its mute gate is released to avoid unexpected simultaneous sound. Reloading does not automatically enable speaker output.

Browser progress is not the speaker's precise position. Seeking or clicking lyrics sends a positioning request; missing device confirmation is reported. A command receipt does not prove audible playback. Check the speaker before repeating an uncertain request. Detecting another source suspends automatic forwarding; confirm its use before disabling and enabling this mode again. Closing the page can leave the current track playing, but automatic queue advancement requires the page to keep running and is not guaranteed in a frozen background tab.

## Authorization and private audio

Uninstalling closes Xiaomi APIs and new media requests while preserving each user's encrypted binding. Reinstalling can reuse the binding but never restores old media URLs. Audio already buffered by the speaker cannot be recalled. The browser pauses its own stream before leaving a retired speaker output.

Each FlareTune user manages their own Xiaomi connection. Service tokens are encrypted on the backend using a separate key derived from `SETUP_SECRET`; tokens and cookies are never returned to the browser. Temporary QR state is also encrypted and expires. Reconnect after authorization expires or the secret is rotated. No always-on computer, NAS or additional Cloudflare service is required by the design.

Xiaomi receives a temporary URL for the current track. Anyone holding it may access that track while it remains valid; associating it with speaker controls does not authenticate the physical requesting device. Do not share the URL or log its full query string in custom proxies, analytics or access logs. Standard development settings redact queries, and production settings disable raw invocation logs.

The URL permits GET, HEAD and Range requests for one track, lasts at most one day, includes at least the track duration plus fifteen minutes of buffer, and requires the issuing web session to remain valid. Sign in again if the remaining session lifetime is insufficient. Missing or abnormal track duration cannot guarantee playback. Replacing a track, stopping, unlinking, signing out, session expiry or account suspension denies subsequent requests. Bytes already delivered or buffered cannot be recalled. An expired connection can also be unlinked to remove its saved authorization.

The R2 bucket and existing `/media/` session checks stay private. The instance needs a valid HTTPS address reachable from the speaker's network; a localhost address cannot serve speaker audio. The public Demo does not connect Xiaomi accounts or send speaker commands.

Media URLs use the current instance origin by default. Operators may set `SPEAKER_MEDIA_ORIGIN` to another HTTPS hostname on the same Worker, such as `https://music.example.com`, to check device network reachability separately. Supply only the origin, without a path, query or credentials. Bind it to the same Worker, retain Worker-first handling for `/speaker-media/*`, and redact query strings in logs. This setting does not proxy external audio or add redirects.

## Validation limits

Local checks and independent review cover QR handling, credential isolation, media grants and revocation, Range behavior and uncertain receipts. With a custom media hostname on the same development Worker, the user confirmed private playback, continued audio after leaving the page, pause, resume and seeking back to an earlier section. Starting from existing browser progress now uses ordinary playback followed by a separate seek and has also produced confirmed audio. Speaker volume can be adjusted independently and read back periodically. The original workers.dev media failure remains unexplained. Device identity and position may be absent; MiNA code100 is treated as unknown, not a confirmed position or connection failure. Network failures and uncertain commands still need human checking, without automatic replay. Evidence covers the tested L05B/firmware, not all environments. The integration uses a community-researched MiNA interface and may need adaptation after upstream changes. Custom metadata/artwork, phone progress display and reverse pause/resume/seek have only been researched and are not implemented; speaker volume is read back periodically. Cloud background queues, multi-room synchronization and voice requests are not provided.

[简体中文](xiaomi-speaker.md) · [User guide](using-flaretune.en.md)
