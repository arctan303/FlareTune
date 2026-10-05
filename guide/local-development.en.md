# Local development

[简体中文](local-development.md) · [English](local-development.en.md)

## Requirements

- Node.js 22.18+ (22.x) or 24.11+ and npm.
- Local development uses Wrangler's simulated D1/R2 bindings. You do not need access to the maintainer's Cloudflare resources.
- Generate a strong `SETUP_SECRET` and keep it only in the untracked `server/.dev.vars` file.

From the repository root, run:

```powershell
npm.cmd ci
Copy-Item .dev.vars.example server/.dev.vars
```

Edit `server/.dev.vars` to set your own random `SETUP_SECRET`; do not commit the file. Keep local D1 empty for the first visit so the app can create its schema and administrator. Do not run Wrangler migrations on a new database beforehand.

Start the Worker and web client in separate terminals:

```powershell
npm.cmd run dev:worker
```

```powershell
npm.cmd run dev
```

The client is available at `http://127.0.0.1:3000`, and the local Worker defaults to `http://127.0.0.1:8789`. Same-origin `/api`, `/auth`, `/media`, and `/rest` requests are proxied to that Worker. The client fails if its port is occupied rather than choosing another port. To use another isolated Worker that you control, set `FLARETUNE_DEV_WORKER_ORIGIN` explicitly. Do not test against an unfamiliar instance.

For client-only work against this project's online **development** Worker, first stop any local client using port 3000. Run `npm.cmd run dev:cloud` from the repository root and open `http://127.0.0.1:3000`. This proxies `/api`, `/auth`, `/media`, and `/rest` to `https://flaretune-dev.arctan.workers.dev` without starting local Wrangler. Sign in with a development-instance administrator account. The default `npm.cmd run dev` connects to the local simulated Worker. Set `FLARETUNE_DEV_CLIENT_PORT` to use another port; cloud mode also accepts `FLARETUNE_DEV_WORKER_ORIGIN`, requiring HTTPS. Sign-in, uploads, and settings affect the selected cloud instance. Cloud development data does not synchronize with local simulated data.

On first visit, verify `SETUP_SECRET`, then enter the administrator username and password. Secret verification does not write to D1; final submission installs the current built-in schema.

## Branches and development Worker

Daily changes go to `dev` and enter `main` only after development verification. Local `npm.cmd run dev:worker` uses simulated D1/R2; changing Git branches does not change those bindings.

The maintainer has a separate `flaretune-dev` Worker, development D1, and development R2. Its manual cloud deployment configuration is in the Git-ignored `server/dev/wrangler.toml`. Cloudflare Builds uses the `dev` environment in the root `wrangler.toml` and a deployment script restricted to the `dev` branch. `FLARETUNE_DEV_D1_ID` is configured in Cloudflare, not committed. Other contributors should bind their own isolated resources. Do not put personal resource IDs, secrets, or production bindings in the root `wrangler.toml`; that file is for the public deployment template.

Cloudflare branch previews also need their own variables and D1/R2 bindings; they do not inherit production Worker resources. See [Cloudflare preview configuration](https://developers.cloudflare.com/workers/previews/configuration/).

## Code entry points

| Directory or file | Purpose |
| --- | --- |
| `client/src/instance/`, `client/src/app.jsx` | Instance/sign-in gates and the application shell |
| `client/src/components/`, `hooks/`, `store/`, `services/` | Pages, playback and state, Worker API calls |
| `client/src/i18n/`, `client/src/styles/` | Chinese/English catalogs and theme styles |
| `server/src/flaretune.js` | Worker: `/rest` to Subsonic, `/media` to media, `/api` and `/auth` to application routes, everything else to static assets |
| `server/src/instance/`, `auth/`, `routes/` | Instance state/migrations, authentication, business routes |
| `server/src/services/`, `subsonic/` | AI, lyrics, media, music data, and client protocols |
| `server/db/migrations-flaretune/` | Current installation/upgrade SQL; see [database directory notes](../server/db/README.md) for historical inputs |
| `tooling/ingest-agent/` | Current headless ingest-device CLI; `npm run ingest` does not start the old local web tool |
| `tooling/dev/`, `verify/`, `release/`, `deploy/` | Development previews, asset/HTTP checks, Release gates, and branch deployment scripts |

Local `dev:worker` D1/R2 state persists under `worker/.wrangler/state`. `preview:worker` uses separate `server/.wrangler/state-preview` state and fictional media, with no development/production bindings. It previews built assets and does not replace empty-database installation verification.

## Database changes

Runtime migrations come from `server/src/instance/migrationBundle.generated.js`; the Worker does not read the SQL directory at runtime. After changing the migration set, run `node tooling/build/generate-migration-bundle.mjs` and update its migration list, schema/feature migration detection, and relevant tests. Do not rewrite migrations already applied to instances. New steps need explicit compatibility, failure, and continuation behavior.

`db:migrations:list:local` and `db:migrations:apply:local` are low-level local Wrangler commands. `apply` writes to the local database and does not replace the app's initialization/upgrade ledger controls. Start a new empty database through the app without applying SQL beforehand.

## Verification

```powershell
npm.cmd test
npm.cmd run build
npm.cmd run verify:i18n
npm.cmd run verify:dist-css
npm.cmd run verify:worker
npm.cmd run verify:worker:preview
```

Choose checks appropriate to the change. `npm test` runs Node tests; use `node --test <test-file>` for focused tests and add `--test-concurrency=1` when serial execution is needed. `build` builds the client and verifies Worker assets. `verify:i18n` checks catalogs and public documentation links; `verify:dist-css` checks CSS in an existing build.

`verify:worker` builds first and performs a dry run with the standard configuration, without deploying online. `verify:worker:preview` builds and runs an isolated local Worker HTTP smoke test, then cleans up that run's temporary state. `preview:worker` starts a local full-site preview. `verify:worker-http` checks an already running preview Worker at `http://127.0.0.1:8790` by default; pass another local address with `npm.cmd run verify:worker-http -- http://127.0.0.1:PORT`. It does not start a Worker. See [diagnostic tool boundaries](../tooling/diagnostics/README.md) for diagnostics and the old local web tool. Local D1 results do not replace installation verification in a new Cloudflare account.
