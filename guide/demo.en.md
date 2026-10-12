# Live demo

[简体中文](demo.md) · [English](demo.en.md)

Try the real player and library interface without signing in, using music licensed for public redistribution. [Open the live demo](https://flaretune-demo.arctan.workers.dev).

| Interactive | Scope |
| --- | --- |
| Playback, queue, seeking, fullscreen and lyrics | Real static audio; manually timed line lyrics, no lyric lookup |
| Search, language browsing, daily picks and roaming | Browser queries against the static catalog; unavailable languages show an empty state |
| Favorites, playlists, history and frequent songs | Stored in this browser; personal collections start empty, the sample playlist is labeled |
| Appearance and nine interface languages | Stored locally; switch and restore preferences |
| AI, administration, ingestion, accounts and connections | Read-only examples; no model calls, file uploads or server accounts |

Tabs in the same browser profile share data. Other browsers and devices do not. Clearing site data or ending a private browsing session may lose your state. Unavailable storage means a temporary session. “Reset demo data” clears only the demo’s state; the demo is not a backup service.

This is an independent Static Assets deployment, with no business Worker script, D1, R2, model keys or visitor database. Pages, dictionaries, covers and audio travel over the network; personal state does not. Normal installations still require authentication and keep music in the deployer’s private R2 bucket.


The deployed static service currently returns full audio files even for Range requests. Seeking works with downloaded/buffered audio; a slow connection may need more buffering. This demo does not claim 206 byte-range streaming. Unknown asset URLs can return the SPA page, while the player handles failed media and advances to the next usable track.

## Music and licenses

The catalog includes CC BY 4.0 works by Kevin MacLeod and an author-dedicated public-domain recording of “Amazing Grace” by Rocks From The Garden. Per-track sources, licenses, credits, modifications and checksums are in [catalog.json](../demo/catalog.json) and accessible from the demo toolbar. Geometric covers are original project artwork. Public-domain lyrics have manual line timing, with no claim of word timing precision. MIT does not cover the music.

## Reproduce and deploy independently

Install locked dependencies with a supported Node.js version, then run from the repository root:

```sh
npm ci
npm run demo:media
npm run demo:dev
```

Audio is excluded from Git. The media command downloads from the listed original sources; the build verifies SHA-256 and stops if a file is absent or differs. Run `npm run demo:build` to produce `dist-demo/`. To deploy to your account, review `demo/wrangler.toml`, choose an independent name and run `npm run demo:deploy`. This is a real remote deployment that creates or updates that Demo Worker. The normal `npm run build` still builds the authenticated application.

[Home](../README.en.md) · [Deploy your library](deployment.en.md)
