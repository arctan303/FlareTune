# Deployment and setup

[简体中文](deployment.md) · [English](deployment.en.md)

## Current status

The maintainer has tested the main features on a production instance and reported that they work. The public template's root `wrangler.toml` declares the Worker, static assets, D1, and R2. Cloudflare's deployment wizard creates and binds these resources and prompts for `SETUP_SECRET` according to `.dev.vars.example`. Empty D1 setup and upgrades from known older versions have passed local Worker/D1 end-to-end rehearsals. **One-click deployment from a completely new Cloudflare account has not yet been verified.**

[Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/arctan303/FlareTune) (available to everyone once the repository is public). D1/R2 names and the empty database ID in the root `wrangler.toml` are defaults for the deploy button; the wizard creates the deployer's resources and writes their bindings. Do not run `wrangler d1 migrations apply` for a new installation. The app performs initial setup using its built-in migration transaction. Running `npm run deploy` directly from the source directory is a real remote deployment; first bind the configuration to your own existing D1/R2 resources.

## First installation

1. Start Cloudflare deployment from the public repository. In your own account, create and bind the Worker, empty D1, private R2, and static assets. Supply a high-entropy `SETUP_SECRET` of at least 32 characters.
2. On the first visit, verify the setup secret in the wizard. This step does not write to D1. The verification proof stays only in the current page's memory and expires after ten minutes.
3. Enter the first administrator username and a password of at least eight characters. The final submission creates the current built-in schema in a D1 transaction and then creates the sole initial administrator. Sign in when setup finishes.

`SETUP_SECRET` is not a daily sign-in password. It also authorizes known database upgrades that block sign-in and serves as the root material for encrypting saved AI model keys. After rotating it, administrators must re-enter those model keys. It cannot reset an administrator account.

## Existing instances and upgrades

In System management, administrators can view current and target schema versions and start a compatible built-in upgrade. If the upgrade cannot finish in the current administrator request, or a known older version requires service to pause, the instance enters maintenance. The deployer then verifies `SETUP_SECRET` to continue in batches. Sign-in and existing administrator sessions cannot perform upgrades during maintenance. Unknown versions, inconsistent migration records, and damaged structures remain closed and require diagnosis outside the app using backups.

Do not overwrite an existing instance's database and media with the new-installation flow. Before upgrading, confirm the target Cloudflare account, Worker, D1, and R2, and retain a restorable D1 backup. If legacy shared playlists contain data, an ordinary administrator upgrade stops and requests a backup. After backing up, use the setup secret on the maintenance page to confirm a migration that may remove those legacy shared playlists. The setup secret cannot repair an unknown or damaged database.
