# <img src="client/public/favicon.svg" alt="" width="44" height="44"> FlareTune

[简体中文](README.md) · [English](README.en.md)

**Your music, in a private library you can listen to anywhere.**

FlareTune is a self-hosted audio streaming app for individuals and families. After an administrator imports audio files, members can find and play music, save favorites, and organize playlists on desktop or mobile. Library data and media files remain in the deployer's own Cloudflare D1 database and private R2 bucket.

[Screenshots](#screenshots) · [Features](#features) · [Deploy](#deploy-to-cloudflare) · [User guide](guide/using-flaretune.en.md) · [Contribute](CONTRIBUTING.en.md)

## Screenshots

The desktop home page shows library content, frequently played songs, and playback entry points. The other screenshots show the artist page, player, mobile lyrics, and appearance settings. Select an image to view it at full size.

[![FlareTune desktop home page with featured cards, song list, and bottom player](guide/images/home-desktop.png)](guide/images/home-desktop.png)

| Artist and albums | Appearance and playback settings |
| --- | --- |
| [<img src="guide/images/artist-desktop.png" alt="Desktop artist page with songs and albums" width="600">](guide/images/artist-desktop.png) | [<img src="guide/images/appearance-desktop.png" alt="Desktop appearance settings with theme and player options" width="600">](guide/images/appearance-desktop.png) |

| Desktop full-screen player | Mobile cover view | Mobile lyrics view |
| --- | --- | --- |
| [<img src="guide/images/player-current-desktop.png" alt="Desktop full-screen player with cover, synchronized lyrics, and controls" width="600">](guide/images/player-current-desktop.png) | [<img src="guide/images/player-current-mobile.png" alt="Mobile full-screen player cover view" width="220">](guide/images/player-current-mobile.png) | [<img src="guide/images/lyrics-current-mobile.png" alt="Mobile full-screen player lyrics view" width="220">](guide/images/lyrics-current-mobile.png) |

## Features

- **Browse and play:** Search songs, artists, and albums, or explore the library with Roam. The player supports a queue, full-screen cover art, and synchronized lyrics.
- **Personal library:** Each account manages its own favorites, playlists, and listening data across desktop and mobile.
- **Library administration:** Administrators upload audio and artwork, edit track details, and manage member accounts in the web app. For large local collections, use the [ingest device](tooling/ingest-agent/README.en.md) to select and import files.
- **Optional music assistant:** After an administrator configures an AI model, the assistant can answer library questions, find songs, and help organize playlists. Music playback works without an AI model.
- **Appearance:** Follow the system theme or choose light or dark mode, backgrounds, and player styles.
- **Interface language:** Each account can choose Simplified Chinese, English, or its browser language in Personal settings. Before sign-in, the browser language is used; unsupported languages fall back to English.

## Deploy to Cloudflare

Select the button below with a Cloudflare account. The deployment wizard creates and binds a Worker, D1 database, and private R2 bucket.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/arctan303/FlareTune)

1. Enter a random `SETUP_SECRET` of at least 32 characters in the deployment wizard and keep it safe.
2. After deployment, open the instance URL and enter `SETUP_SECRET` to verify initial setup.
3. Create the first administrator account, sign in, and import your music.

For setup, upgrades, and backups, see the [deployment guide](guide/deployment.en.md).

## Development and documentation

FlareTune uses React, Vite, and Cloudflare Workers. D1 stores data, while private R2 stores audio and artwork. Local development requires Node.js 22.12.0 or newer; see the [local development guide](guide/local-development.en.md) for setup and verification.

| Document | Contents |
| --- | --- |
| [User guide](guide/using-flaretune.en.md) | Search, playback, playlists, assistant, and personal settings |
| [Deployment and setup](guide/deployment.en.md) | First installation, secrets, upgrades, and backups |
| [Administration](guide/administration.en.md) | Library, accounts, instance settings, and maintenance |
| [Local ingest device](tooling/ingest-agent/README.en.md) | Scan local folders and select songs in the web app |
| [All guides](guide/README.en.md) | Documentation index for users and administrators |
| [Changelog](CHANGELOG.md) | Releases and known limitations |

## About

FlareTune grew out of my personal music player, Lejing. After more than a year of development from Lejing 4.0 to 5.0, FlareTune 1.0.0 became the starting point for this independent open-source project.

Contributions to code, design, testing, and documentation are welcome; see [Contributing](CONTRIBUTING.en.md). If you encounter a problem, open a [GitHub issue](https://github.com/arctan303/FlareTune/issues) with your environment, steps to reproduce, and only the necessary redacted logs. Please do not include music files or credentials.

## License

Code and documentation use the [MIT License](LICENSE). See [Assets](ASSETS.md) for image and brand asset terms.
