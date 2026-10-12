# <img src="client/public/favicon.svg" alt="" width="44" height="44"> FlareTune

[简体中文](README.md) · [English](README.en.md) · [繁體中文](guide/quickstart.zh-Hant.md) · [日本語](guide/quickstart.ja.md) · [한국어](guide/quickstart.ko.md) · [Español](guide/quickstart.es.md) · [Français](guide/quickstart.fr.md) · [Deutsch](guide/quickstart.de.md) · [Português (Brasil)](guide/quickstart.pt-BR.md)

**Your music, your private library. No VPS to maintain.**

FlareTune runs its web player, accounts and library service on Cloudflare Workers, stores metadata in D1, and keeps audio and artwork in private R2 storage. Open your library on a computer or phone, and give family members their own accounts without running an always-on server.

Cloudflare R2 Standard includes **10 GB-month of free storage each month**, a starting point for a small private library. Workers, D1 and storage operations have separate allowances. Staying within free usage depends on total account usage, requests and optional services; see [allowances and costs](guide/deployment.en.md#free-allowances-and-costs). You need a Cloudflare account with R2 enabled, initial setup, and audio you have the right to use.

**[Try the live demo](https://flaretune-demo.arctan.workers.dev)** · [Deploy your library](#deploy-your-library) · [User guide](guide/using-flaretune.en.md) · [Changelog](CHANGELOG.en.md)

## Try it with music

The demo needs no sign-in and uses music licensed for public redistribution. Play, search, roam, favorite tracks and edit personal playlists. Favorites, history and preferences stay in your browser. AI, ingestion and instance administration are clearly labeled read-only examples; deploy your instance to use those services. See [demo details and licenses](guide/demo.en.md).

[![Demo desktop home with music, recommendations and player controls](guide/images/demo-home-desktop.png)](guide/images/demo-home-desktop.png)

| Fullscreen player | Mobile interface |
| --- | --- |
| [<img src="guide/images/demo-player-desktop.png" alt="Demo fullscreen player and synchronized lyrics" width="640">](guide/images/demo-player-desktop.png) | [<img src="guide/images/demo-mobile.png" alt="Demo mobile fullscreen player" width="230">](guide/images/demo-mobile.png) |

## For listening and organizing

- **Your own library**: search songs, artists and albums, or roam by music language. Daily recommendations target 20 songs, with up to 8 on the home page. Smaller libraries show the actual available number; request another batch whenever you like.
- **A considered player**: queue, repeat and shuffle, desktop and mobile fullscreen layouts, and line or word synchronized lyrics when suitable lyrics are available. Audio format support depends on the browser; there is no server transcoding.
- **Personal collections**: account favorites and playlists are stored by your instance and available across devices. Recent listening history stays in the current browser.
- **Start with your files**: upload through the web, manage metadata, artwork and lyrics, or use the [ingestion device](tooling/ingest-agent/README.en.md) to scan and review a local collection before importing it.
- **Optional music assistant**: configure your own model provider to let “Little A” help find music, answer library questions and organize playlists. The library and player work without AI.
- **Make it comfortable**: nine interface languages, light and dark themes, background and player preferences, plus optional [Google sign-in](guide/google-login.en.md) and [Subsonic clients](guide/subsonic.en.md).

## Why deploy this way?

If you want a personal or family music library without maintaining a VPS, containers or background processes, FlareTune offers a Cloudflare-based option. You control the account, D1 database and private R2 bucket. Normal instances require authentication for business APIs and media.

The core deployment needs no extra server. AI, Google sign-in and third-party lyric or image sources are optional external services with their own availability and possible costs. FlareTune focuses on listening to and organizing your audio; a normal installation includes no commercial music catalog and does not provide the transcoding features of a larger media server.

## Deploy your library

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/arctan303/FlareTune)

1. Prepare a Cloudflare account with R2 enabled. Use the wizard to create or bind a Worker, an empty D1 database and a private R2 bucket.
2. Set and securely save a random `SETUP_SECRET` of at least 32 characters.
3. Open the deployed URL, verify the secret, create the first administrator and import your music.

Initial database setup runs inside the application; no manual migration command is needed for a new instance. See the [deployment guide](guide/deployment.en.md) for manual deployment, allowances, backups and upgrades. A new Cloudflare account follows the platform’s current onboarding prompts.

## Docs and contributions

| Entry | Contents |
| --- | --- |
| [User guide](guide/using-flaretune.en.md) | Playback, roaming, playlists, assistant and preferences |
| [Administration](guide/administration.en.md) | Library, accounts, instance configuration and data |
| [Deployment](guide/deployment.en.md) | Installation, allowances, secrets, backups and upgrades |
| [Demo](guide/demo.en.md) | Browser data, read-only boundaries, sources and reproduction |
| [Local development](guide/local-development.en.md) | React/Vite/Workers development and checks |
| [All docs](guide/README.en.md) | User, administrator and client documentation |
| [Contributing](CONTRIBUTING.en.md) | Code, translation, design, testing and feedback |

FlareTune grew from my personal player, “乐境”, after more than a year of iteration. Report reproducible problems through [GitHub Issues](https://github.com/arctan303/FlareTune/issues), or contribute code, design, translations and documentation.

Original code and docs use [MIT](LICENSE); the protocol MD5 implementation retains [Apache-2.0](licenses/legacy-flaretune-Apache-2.0.txt). Music, photos and brand assets follow their [own terms](ASSETS.md); MIT does not cover them.
