# Deployment and setup

[简体中文](deployment.md) · [English](deployment.en.md)

## Free allowances and costs

The core uses Workers, D1 and private R2, without a VPS. These Cloudflare allowances were checked on 2026-10-12 and apply across the account, including other applications:

| Service | Allowance and boundary |
| --- | --- |
| [R2 Standard](https://developers.cloudflare.com/r2/pricing/) | Monthly 10 GB-month, 1 million Class A and 10 million Class B operations. Direct R2 egress is free. Storage averages daily peaks; artwork and lyrics also count. Excess storage/operations cost money; these allowances exclude Infrequent Access |
| [Workers Free](https://developers.cloudflare.com/workers/platform/pricing/) | 100,000 dynamic requests/day and 10 ms CPU/request; large imports can still hit limits |
| [D1 Free](https://developers.cloudflare.com/d1/platform/pricing/) | 5 million rows read/day, 100,000 rows written/day, 5 GB account storage; per-database limits also apply |
| [Static Assets](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) | Static asset requests are free; authenticated private music passes through the normal instance Worker |

Starting free is conditional. R2 requires enabling its subscription and completing platform checkout; your account may need payment details. Allowances are not spending caps. Monitor usage and available alerts, and review pricing before upgrading. AI, optional domains and other external services may cost extra.

The public template and isolated local initialization/access flows have been verified. End-to-end deploy-button onboarding on a brand-new Cloudflare account remains account-dependent and has not been demonstrated by deploying to an existing development account.

## Deployment method

The public template's root `wrangler.toml` declares the Worker, static assets, D1, and R2. Cloudflare's deployment wizard creates and binds these resources and prompts for `SETUP_SECRET` according to `.dev.vars.example`.

[Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/arctan303/FlareTune). D1/R2 names and the empty database ID in the root `wrangler.toml` are defaults for the deploy button; the wizard creates the deployer's resources and writes their bindings. Do not run `wrangler d1 migrations apply` for a new installation. The app performs initial setup using its built-in migration transaction. Running `npm run deploy` directly from the source directory is a real remote deployment; first bind the configuration to your own existing D1/R2 resources.

## First installation

1. Start Cloudflare deployment from the public repository. In your own account, create and bind the Worker, empty D1, private R2, and static assets. Supply a high-entropy `SETUP_SECRET` of at least 32 characters.
2. On the first visit, verify the setup secret in the wizard. This step does not write to D1. The verification proof stays only in the current page's memory and expires after ten minutes.
3. Enter the first administrator username and a password of at least eight characters. The final submission creates the current built-in schema in a D1 transaction and then creates the sole initial administrator. Sign in when setup finishes.

`SETUP_SECRET` is not a daily sign-in password. It also authorizes known database upgrades that block sign-in and derives separate encryption keys for saved AI model keys, the optional Google Client Secret and opt-in Subsonic password copies. After rotating it, administrators must re-enter model keys and the Google Secret, and users must verify their current password to re-enable Subsonic. It cannot reset an administrator account. See the [Google setup guide](google-login.en.md).

## Existing instances and upgrades

In the runtime overview under Instance settings, administrators can view the base schema version and individual feature migrations, then start a compatible built-in upgrade when updates are pending. If the upgrade cannot finish in the current administrator request, or a known older version requires service to pause, the instance enters maintenance. The deployer then verifies `SETUP_SECRET` to continue in batches. Sign-in and existing administrator sessions cannot perform upgrades during maintenance. Unknown versions, inconsistent migration records, and damaged structures remain closed and require diagnosis outside the app using backups.

Do not overwrite an existing instance's database and media with the new-installation flow. Before upgrading, confirm the target Cloudflare account, Worker, D1, and R2, and retain a restorable D1 backup. If legacy shared playlists contain data, an ordinary administrator upgrade stops and requests a backup. After backing up, use the setup secret on the maintenance page to confirm a migration that may remove those legacy shared playlists. The setup secret cannot repair an unknown or damaged database.

## Backup and recovery

1. Save the code version, bindings and `SETUP_SECRET`. Stop ingestion, editing and client writes while taking matching database and media copies.
2. Export SQL using the [D1 instructions](https://developers.cloudflare.com/d1/best-practices/import-export-data/), for example `npx wrangler d1 export YOUR_DATABASE --remote --output=backup.sql`. Verify the target; keep private account/configuration data out of public repositories.
3. Copy R2 objects through its [S3-compatible interface](https://developers.cloudflare.com/r2/api/s3/api/), preserving keys, contents and types, including audio, lyrics, artwork and private `users/` images. A database copy alone cannot restore audio.
4. Rehearse with a separate empty D1 and private R2: import SQL, restore objects, and deploy the same code and original secret with the new bindings. Sign in to the restored database without initializing it again. Verify favorites, playlists, playback, lyrics and private images before arranging a real switch.

FlareTune has no one-click full backup or atomic D1/R2 snapshot. A cloud recovery rehearsal with a new deployer's account remains unverified.
