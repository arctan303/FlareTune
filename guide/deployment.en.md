# Deployment and setup

[简体中文](deployment.md) · [English](deployment.en.md)

Try the player and full settings in the [live demo](https://flaretune.arcinks.com) before deploying your own library. The demo uses publicly licensed music; your installation needs your own audio and stores data separately from the [demo](demo.en.md).

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

`SETUP_SECRET` is not a daily sign-in password. It also authorizes known database upgrades that block sign-in and derives separate encryption keys for saved AI model keys, the optional Google Client Secret, opt-in Subsonic password copies and optional Xiaomi authorization in the development version. After rotating it, administrators must re-enter model keys and the Google Secret, users must reconnect Xiaomi and verify their current password to re-enable Subsonic. It cannot reset an administrator account. See the [Google setup guide](google-login.en.md).

## Existing instances and upgrades

Application releases use System update below. Base schema and individual feature migrations in the runtime overview maintain the current Worker database and are a separate operation. Only the older manual maintenance flow requires the deployer to verify `SETUP_SECRET` and continue in batches when an administrator request cannot finish or a known old version requires a pause. A system update's own maintenance window waits and verifies automatically without asking for the setup secret again. Unknown versions, inconsistent migration records and damaged structures remain closed and require diagnosis outside the app using backups.

Do not overwrite an existing instance's database and media with the new-installation flow. Before upgrading, confirm the target Cloudflare account, Worker, D1, and R2, and retain a restorable D1 backup. If legacy shared playlists contain data, an ordinary administrator upgrade stops and requests a backup. After backing up, use the setup secret on the maintenance page to confirm a migration that may remove those legacy shared playlists. The setup secret cannot repair an unknown or damaged database.

## System updates in administration

The running version must already include the system-update protocol and trusted runtime metadata. Stock 1.2.1 has no such entry: deploy a transition version compatible with the actual old installation first, preserving its Worker, bindings, database, media and secrets. Then use administration to upgrade. A transition deployment differs from a new installation; one test site's migration does not establish preservation for every old site.

### Configure the update channel once

There is currently no in-app wizard that creates a repository or fills in Cloudflare credentials. Complete this initial setup in your own account, using a repository created during deployment or a one-time copy of trusted official bootstrap code. The bootstrap must support both fixed stable Release assets, `flaretune-update.json` and `flaretune-source.tar.gz`; replace an older bootstrap that only supports codeload URLs with a compatible version first. For routine updates, this entry downloads the verified official version without repeatedly forking or manually syncing the repository.

1. Connect the bootstrap repository to the target Worker's [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/) and pin one branch (`main` by default). **Leave Build command empty and set Deploy command to `npm run updates:build`.** This command already downloads, builds, uploads, verifies, promotes and reports the update. Do not append the default `wrangler deploy` or run another direct deployment path. Retain the lockfile and dependency installation step; disable deployment from unauthorized branches.
2. Create a [Deploy Hook](https://developers.cloudflare.com/workers/ci-cd/builds/deploy-hooks/) for the same branch. Under Instance settings → System update → Configure update channel, save that URL, generate a build token and copy it into the Builds secrets. The app displays only whether credentials are configured; blank edit fields retain saved values. Saving the channel does not start an update.
3. Configure the following build environment and verify the account, Worker name and actual Worker metadata `tag`. Limit the Cloudflare deployment credential to the target account's required Workers deployment and binding-resource permissions; do not use a global API Key. Verify that the custom runner can read `CLOUDFLARE_API_TOKEN`: selecting a platform deployment token alone does not prove that it is available as an environment variable.

| Build variable | Value and purpose |
| --- | --- |
| `FLARETUNE_SYSTEM_UPDATE_SITE_URL` | This site's public HTTPS origin, without a path or query |
| `FLARETUNE_SYSTEM_UPDATE_BUILD_TOKEN` | The same token saved in administration; 32–256 letters, digits, `_` or `-`; store as a secret |
| `FLARETUNE_SYSTEM_UPDATE_WORKER_NAME` | The real application Worker, not another test or controller Worker |
| `FLARETUNE_SYSTEM_UPDATE_WORKER_TAG` | The actual Worker's 32-character hexadecimal metadata `tag`, not a version ID |
| `CLOUDFLARE_ACCOUNT_ID` | Target Cloudflare account ID |
| `CLOUDFLARE_API_TOKEN` | Restricted Cloudflare deployment credential readable by the runner; store as a secret, distinct from the site's build token |
| `FLARETUNE_SYSTEM_UPDATE_BUILD_BRANCH` | Pinned bootstrap branch, default `main`; must match Builds and the Hook |
| `FLARETUNE_SYSTEM_UPDATE_CHANNEL` | Optional, default `stable`; use matching `candidate` only with an explicitly trusted server candidate |

Builds supplies `WORKERS_CI=1` and `WORKERS_CI_BRANCH` for execution checks; do not fabricate them. Platform Worker-name/tag constraints must also match the application. Ordinary deployments use the default stable channel without a candidate override. The build token only authorizes a frozen task's plan, lease, reports and compatible built-in migrations, not administrator sign-in, arbitrary SQL or private configuration reads. Saved channel credentials are encrypted using `SETUP_SECRET`; plan to reconfigure the channel when rotating it.

### Check and apply releases

1. As an administrator, open Instance settings → System update and choose Check for updates. This reads the official stable Release's `flaretune-update.json` and confirms that the same Release includes the fixed `flaretune-source.tar.gz` source asset, without deploying. Stable updates require a formal, non-prerelease release with both assets and a valid manifest. Missing or unavailable assets are an error, not proof that the site is current.
2. Review the current version, target version and notes, then choose Upgrade system → Confirm upgrade. A candidate supplied by trusted server configuration is labeled separately and is not a formal stable release. Resolve pending plugin changes, active builds, incompatibility or missing runtime metadata as indicated before checking again.
3. The page shows actual build, deployment and migration stages. Refreshing or closing the page does not cancel the job; returning reads the same task. System updates freeze installed plugins' exact versions, sources, hashes and installation epochs while preserving configuration and data. They do not bundle plugin updates; confirm plugin additions, updates and removals separately in [Sources and deployment](plugin-deployment.en.md).
4. During the migration maintenance window, music, media and ordinary business requests pause while the page keeps checking. Normal administrators can still open the system-update panel; an expired session can use local administrator sign-in from the waiting page. Members wait or sign out to switch accounts. Use Retry this update after a confirmed failure, or Continue verifying for an unconfirmed result or a task the backend has confirmed can resume after stalling. Both retain the same task and target; do not create another upgrade or assume the old code is still serving. Reload when complete. Missing credentials, changed target identity or bindings require correcting the cloud configuration first.

Maintenance management requires the underlying database to pass ordinary authentication. Unknown structures or incomplete base migrations do not unlock sign-in: wait for the configured build to continue or contact the deployer. Recovery through the web page is not guaranteed for every partially migrated database.

Stable builds use the official Release source asset named by the manifest. GitHub's automatically generated “Source code (zip/tar.gz)” is not a permanent fixed-byte build input: [GitHub documents](https://docs.github.com/en/repositories/working-with-files/using-files/downloading-source-code-archives#stability-of-source-code-archives) that compressed archive bytes may change. Downloads still undergo strict manifest SHA256, full-commit and host-digest checks. A mismatch stops the update; recalculating or changing the SHA cannot bypass it. A trusted candidate channel temporarily uses a codeload archive pinned to a full commit with the same checks, not as a replacement for the two stable Release assets.

System updates run only the target's built-in compatible migrations; they do not authorize destructive legacy-data cleanup. Unknown promotion or database results remain frozen. Controlled code restoration is available only before database migration has started, and administration offers no arbitrary downgrade button. **Restoring code does not roll back database contents, plugin settings or media. Prepare backups and recovery before updating.**

## Backup and recovery

1. Save the code version, bindings and `SETUP_SECRET`. Stop ingestion, editing and client writes while taking matching database and media copies.
2. Export SQL using the [D1 instructions](https://developers.cloudflare.com/d1/best-practices/import-export-data/), for example `npx wrangler d1 export YOUR_DATABASE --remote --output=backup.sql`. Verify the target; keep private account/configuration data out of public repositories.
3. Copy R2 objects through its [S3-compatible interface](https://developers.cloudflare.com/r2/api/s3/api/), preserving keys, contents and types, including audio, lyrics, artwork and private `users/` images. A database copy alone cannot restore audio.
4. Rehearse with a separate empty D1 and private R2: import SQL, restore objects, and deploy the same code and original secret with the new bindings. Sign in to the restored database without initializing it again. Verify favorites, playlists, playback, lyrics and private images before arranging a real switch.

FlareTune has no one-click full backup or atomic D1/R2 snapshot. A cloud recovery rehearsal with a new deployer's account remains unverified.
