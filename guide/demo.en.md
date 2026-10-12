# Live demo

[简体中文](demo.md) · [English](demo.en.md)

Try the real player and library interface without signing in, using music licensed for public redistribution. [Open the live demo](https://flaretune.arcinks.com).

| Interactive | Scope |
| --- | --- |
| Playback, queue, fullscreen and lyrics | Real static audio; manually timed line lyrics, no lyric lookup |
| Seeking | Audio supports 206 byte-range responses for playback position changes |
| Search, language browsing, daily picks and roaming | Browser queries against the static catalog; unavailable languages show an empty state |
| Favorites, playlists, history and frequent songs | Stored in this browser; personal collections start empty, the sample playlist is labeled |
| Appearance and nine interface languages | Stored locally; switch and restore preferences |
| Assistant conversation | Send, restore and clear messages locally; responses are explicitly labeled fixed examples, without model calls; retain the latest 30 turns in this browser |
| Administration, ingestion, accounts and connections | A simulated administrator sees the actual pages and complete configuration dialogs with public example data; no uploads, server configuration changes or server accounts |

Tabs on the same domain in the same browser profile share data. Other browsers and devices do not. The old workers.dev address and public domain are separate sites; browser data does not migrate automatically. Clearing site data or ending a private browsing session may lose your state. Unavailable storage means a temporary session. “Reset demo data” at the bottom of Personal settings clears only the demo’s state; the demo is not a backup service.

This independent Static Assets deployment uses a read-only media Worker only for audio requests, providing correct Range responses. UI behavior, preferences, favorites, playlists and assistant examples run in the browser. There is no D1, R2, model key or visitor database. Pages, dictionaries, covers and audio travel over the network; personal state does not. Normal installations require authentication and keep music in private R2.


The media Worker reads only packaged catalog audio and supports GET, HEAD, single byte ranges and 416 for invalid ranges. It does not accept uploads, proxy arbitrary URLs or provide business APIs. Audio requests count toward Worker usage; other static assets follow Static Assets delivery rules. Browser codec support and network conditions still apply.

## Music and licenses

The catalog includes CC BY 4.0 works by Kevin MacLeod and an author-dedicated public-domain recording of “Amazing Grace” by Rocks From The Garden. Per-track sources, licenses, credits, modifications and checksums are in [catalog.json](../demo/catalog.json) and accessible at the bottom of Personal settings. Geometric covers are original project artwork. Public-domain lyrics have manual line timing, with no claim of word timing precision. MIT does not cover the music.

## Reproduce and deploy independently

Install locked dependencies with a supported Node.js version, then run from the repository root:

```sh
npm ci
npm run demo:media
npm run demo:dev
```

Audio is excluded from Git. The media command downloads from the listed original sources; the build verifies SHA-256 and stops if a file is absent or differs. Run `npm run demo:build` to produce `dist-demo/`. To deploy to your account, review `demo/wrangler.toml`, choose an independent name, replace `routes` with your domain or remove that section to use workers.dev, and run `npm run demo:deploy`. This is a real remote deployment that creates or updates that Demo Worker. The normal `npm run build` still builds the authenticated application.

[Home](../README.en.md) · [Deploy your library](deployment.en.md)
