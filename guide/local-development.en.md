# Local development

[简体中文](local-development.md) · [English](local-development.en.md)

## Requirements

- Node.js 22.12.0 or newer and npm.
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

The client is available at `http://127.0.0.1:3000`, and the local Worker defaults to `http://127.0.0.1:8789`. Same-origin `/api`, `/auth`, and `/media` requests from the client are proxied to that Worker. To use another isolated Worker that you control, set `FLARETUNE_DEV_WORKER_ORIGIN` explicitly. Do not test against an unfamiliar instance.

For client-only work against this project's online **development** Worker, first stop any local client using port 3000. Run `npm.cmd run dev:cloud` from the repository root and open `http://127.0.0.1:3000`. This proxies `/api`, `/auth`, and `/media` to `https://flaretune-dev.arctan.workers.dev`, without starting local Wrangler. Sign in with a development-instance administrator account. The default `npm.cmd run dev` still connects to the local simulated Worker to avoid unintended cloud data changes. Set `FLARETUNE_DEV_CLIENT_PORT` to use another client port.

On first visit, verify `SETUP_SECRET`, then enter the administrator username and password. Secret verification does not write to D1; final submission installs the current built-in schema.

## Branches and development Worker

Daily changes go to `dev` and enter `main` only after development verification. Local `npm.cmd run dev:worker` uses simulated D1/R2; changing Git branches does not change those bindings.

The maintainer has a separate `flaretune-dev` Worker, development D1, and development R2. Its manual cloud deployment configuration is in the Git-ignored `server/dev/wrangler.toml`. Cloudflare Builds uses the `dev` environment in the root `wrangler.toml` and a deployment script restricted to the `dev` branch. `FLARETUNE_DEV_D1_ID` is configured in Cloudflare, not committed. Other contributors should bind their own isolated resources. Do not put personal resource IDs, secrets, or production bindings in the root `wrangler.toml`; that file is for the public deployment template.

Cloudflare branch previews also need their own variables and D1/R2 bindings; they do not inherit production Worker resources. See [Cloudflare preview configuration](https://developers.cloudflare.com/workers/previews/configuration/).

## Verification

```powershell
npm.cmd test
npm.cmd run build
npm.cmd run verify:worker
```

`verify:worker` performs a dry run with the standard configuration and does not deploy online. `npm.cmd run preview:worker` starts a local full-site preview. Development scripts and local D1 state do not replace installation verification in a new Cloudflare account.
