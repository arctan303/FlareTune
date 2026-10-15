# FlareTune ingest device

Read music folders on your computer and select tracks in your FlareTune web admin page. The device connects outward to your instance and does not open a local server or require an inbound public port.

Install Node.js 22.18+ (22.x) or 24.11+ first, then configure and start:

```sh
npx flaretune-ingest@latest configure
npx flaretune-ingest@latest start
```

Configuration asks for a device name, your instance URL, administrator credentials, and local music folders. Keep the terminal running, then open **Settings → Song ingest → Connected device folders** in your FlareTune instance. Scanning does not upload music; an administrator must select and save tracks in the web app.

The administrator password is saved in a local user configuration file. Use a trusted computer. SQLite scan and media-task records remain alongside that configuration. Package upgrades reuse these files; stop the old process before starting the latest version.

```sh
npx flaretune-ingest@latest --help
npx flaretune-ingest@latest --version
```

The `next` distribution tag is reserved for initial setup or prerelease packages. Use `latest` for normal operation after the first stable package is published.

Full instructions, configuration locations, limits, and troubleshooting:

- [English guide](https://github.com/arctan303/FlareTune/blob/main/tooling/ingest-agent/README.en.md)
- [简体中文指南](https://github.com/arctan303/FlareTune/blob/main/tooling/ingest-agent/README.md)

Device APIs are available from FlareTune 1.1.0. This CLI uses the existing administrator media channel and does not provide automatic directory uploads or background song saving after the web page closes.

MIT License. [Source and issue tracker](https://github.com/arctan303/FlareTune).
