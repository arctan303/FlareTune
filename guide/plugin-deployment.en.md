# Plugin sources and deployment

[简体中文](plugin-deployment.md) · [English](plugin-deployment.en.md)

> **Release and upgrade status:** the current stable release is **1.2.1**. The plugin-capable API2 host and delivery channel described here have development-channel validation; this does not mean a stock 1.2.1 installation includes them. The 1.3.0 plugin milestone, including the new API3 host capabilities and three 0.2.0 AI packages, remains a **local candidate**, not a released upgrade. Preservation of existing data and settings still requires an actual 1.2.1-to-candidate upgrade test. A maintainer-specific manual reinstall exception is not a general upgrade procedure or a promise of lossless upgrades for other installations.

This guide covers plugin catalogs, a dedicated build channel, activation, host upgrades and recovery. Configure both your site and Cloudflare build environment before using the channel. A repository, a saved trigger URL or a successful build alone does not prove that installation works. For an existing installation, first follow the backup and upgrade precautions in the [deployment guide](deployment.en.md), and verify the recovery procedure for your own resources.

## Management and permissions

Routine application releases use Instance settings → System update; see [system-update setup](deployment.en.md#system-updates-in-administration). System updates preserve the site's exact plugin combination. Sources and deployment continues to manage plugin installation, updates and removal; credentials and tasks from the two channels are not interchangeable. The host-upgrade protocol below remains a maintainer integration for controlled builds and transition deployments, not daily manual steps for system updates.

Stable system updates use `flaretune-update.json` and the fixed `flaretune-source.tar.gz` source asset from the same official Release, with strict SHA and host-digest checks. These assets are separate from immutable plugin packages. GitHub's automatic Source code archives are not substitutes, and a failed check never permits recalculating the SHA to proceed. Initial bootstrap code must support this asset contract; routine releases require no repository syncing.

Open the **Plugins** group in the settings sidebar:

- **Plugin list:** view installed plugins and open their settings. Administrators can also discover, install, update and uninstall plugins.
- **Sources and deployment:** administrators manage catalogs, build configuration, manual or automatic rebuilding, pending changes and the latest build.

Members can use only installed plugins available to their role and manage their own settings. Installation applies to the whole site. Plugins with service pages may provide a functional sidebar; Roam retains the main sidebar and category browsing page. Service sidebars contain functional pages and actions. Overview and site configuration remain in plugin management, and Back follows the actual entry point and page hierarchy.

Plugin management uses a **Plugin settings** sidebar heading with Overview, the primary Settings page and any derived pages. Overview explains the purpose and prerequisites without repeating the Settings action. Roles and data scopes still follow the plugin declarations.

## Add a plugin source

The official source is preconfigured. Its catalog and six plugin packages have been published. An unavailable or unpublished source is shown as not ready. Administrators can add a public HTTPS URL for a third-party JSON catalog, then refresh or remove that source.

A catalog uses `schemaVersion: 1`, with `id`, `name` and a `plugins` array. Each entry contains a `manifest` and `artifact: { url, sha256 }`. A manifest declares a stable `id`, a three-part `version`, `hostApiVersion`, `apiVersion`, name, description, icon, and `pages`/`entries` arrays. Refreshing discovers versions; it does not update installed code. Removing a source does not uninstall its running plugins.

The [official catalog](https://raw.githubusercontent.com/arctan303/FlareTune-Plugins/main/repository.json) can change, but each package URL is pinned to a complete Git commit and content hash. Builds use the confirmed version rather than resolving the latest catalog again. The [FlareTune-Plugins repository](https://github.com/arctan303/FlareTune-Plugins) owns official plugin source, locked dependencies and publishing tools.

### Package format and SDK boundaries

Current official packages use UTF-8 JSON **schema2**, understood by the SDK2 host, with `manifest.hostApiVersion` at least 2. The package manifest must exactly match the catalog version selected for installation. Schema1 and the SDK1 baseline remain supported; old packages do not automatically gain new interfaces.

```json
{
  "schemaVersion": 2,
  "manifest": { "id": "example", "version": "1.0.0", "hostApiVersion": 2 },
  "entries": { "client": "client/index.js", "server": "server/index.js" },
  "files": { "client/index.js": "client module text", "server/index.js": "server module text" },
  "exports": { "client/index.js": "client/index.js", "server/index.js": "server/index.js" },
  "assets": {}
}
```

This illustrates the package structure, not a complete installable manifest. Include `apiVersion`, name, description, icon, `pages`, `entries` and other required declarations. Declare supported and default locales, localized metadata and page labels. Roles are `admin` and `member`. Declare service and settings pages separately; a plugin with settings only does not need a service sidebar.

The updated host supports optional plain-text paragraphs in `metadata[locale].introduction`, with a top-level `introduction` fallback. Packages that omit them retain their `description`. An introduction contains 1–6 nonempty paragraphs of at most 1500 UTF-16 code units each; the complete manifest remains limited to 64 KiB. HTML and Markdown are not parsed. Keep the list description short and explain the purpose, actual capabilities, prerequisites, first step and limits in the introduction. Missing localized introductions fall back to the default language, then the top-level content. Upgrade an existing test site's host before delivering these new packages, and publish new package versions rather than replacing bytes under an existing version.

The local API3 candidate does not change artifact schema2. Its new AI Gateway, Assistant and Lyrics Workbench packages are version 0.2.0 and require host API3. New consumers require Gateway `^0.2.0`; the new gateway retains service API1 compatibility for older consumers. An API2 host cannot run packages requiring API3. These candidate changes are not installed by refreshing the catalog or following the API2 examples above.

Plugin authors must observe these boundaries:

- `files` contains JS/MJS/JSX/JSON/CSS text under `client/`, `server/` or `shared/`. Relative imports stay within their execution side and `shared`; `shared` imports only `shared`.
- Client code may import React, Lucide and the host's exact SDK allowlist. Server code uses explicit `@flaretune/plugin-sdk/server/...` interfaces. Do not import host internals. The allowlist is in `shared/plugins/sdkImports.js`; an arbitrary `@flaretune/plugin-sdk/*` path is not supported.
- `exports` maps public paths to package files, including JSX paths mapped to bundled JS. Cross-plugin code requires a declared required or optional dependency and a public module such as `@flaretune/plugin-service/ai-gateway/server/client.js`. The assembler resolves the selected provider. Cross-plugin service imports support JS/MJS/JSX, not arbitrary CSS/JSON imports. A missing optional provider makes the declared feature unavailable; do not fall back to a private host copy.
- `assets` accepts only `server/*.wasm`, with `{ encoding: "base64", data, size, sha256 }`. The decoded size and SHA are checked before Worker compilation. Client binaries and arbitrary file reads are not allowed.
- Each Wasm asset and schema2 text file is limited to 2 MiB; schema1 text files remain limited to 512 KiB. A package has at most 256 files and assets, a 4 MiB download limit, and each assembly has at most 32 plugins and 32 MiB of package downloads.
- Dependencies are bundled by the publisher from its lockfile, retaining licenses. Installation does not run package install scripts or install additional npm dependencies. Schema1 retains `{ schemaVersion: 1, manifest, entries, files }`, without schema2 `exports` or `assets`. The official repository fixes LF line endings for reproducible license hashes and artifacts.

Roam keeps `/roam` and ordinary category browsing available without the plugin. When installed, revocable `browse-header` and `queue-controls` contributions provide its radio and queue continuation features. The legacy `/plugins/roam/browse` route returns to the same page; Overview remains available through the plugin list. Install, role and build checks gate plugin features, not ordinary category browsing.

Contribution events, snapshots and subscriptions must belong to the runtime and page session that registered them. Removing a component on uninstall or account change is insufficient: old callbacks must reject and old snapshots must not reveal the next account's state. Do not forward retained callbacks through a globally mutable controller.

### First assembly and cache recovery

The host release's `plugins.seed.lock.json` pins default compiled packages by immutable URL, manifest and SHA. Explicit `npm run plugins:seed` creates initial catalog data, static entries and compatibility bridges with `pluginDeployment=null`. Compiled code is not an installation: seeding does not enable plugins, invent a build task or reset installation epochs.

Normal build, test and development entry points first run `plugins:hydrate`. It verifies and restores ignored immutable package caches while retaining the current selection, deployment description and D1 installation state. It does not re-add removed packages. Style scanning reads only selected client/shared source, not unrelated cached plugins or server vendors. A clean dedicated CI run restores the release cache, checks the host and lock, then assembles the site's frozen plan. Commit generated release descriptions, bridges and combination locks; keep `.delivery` and raw download caches out of Git.

**Trust code before installing it.** Plugins run as this site's Worker and same-origin frontend code. There is no sandbox for untrusted plugins, and a matching hash does not establish publisher trust. Invalid URLs, unavailable catalogs and incompatible packages do not by themselves replace the running combination.

## Configure a dedicated build channel

A trigger URL starts a build; the build must also read the site's locked target, assemble it and report the result. Configure both ends. Keep the target Worker and its bindings fixed. Ordinary plugin changes require the running host's source baseline. A host change uses the upgrade procedure below, preserving exact running packages rather than replacing them with the release seed.

1. Connect the build Worker to the trusted host repository and appropriate branch. In **Settings → Builds → Deploy Hooks**, create a hook for the branch configured in Builds. The build controller can be separate from the application Worker. See [Cloudflare's Deploy Hook instructions](https://developers.cloudflare.com/workers/ci-cd/builds/deploy-hooks/).
2. Save the hook URL in **Sources and deployment**, and generate or enter a separate **build access token**. It must contain 32–256 URL-safe characters: letters, digits, `_` or `-`. Store the same token as a build secret. Both site fields are encrypted and masked on read; saving does not trigger a build. Omitted fields retain stored values; explicit clearing removes them.
3. Configure the following in the dedicated **build environment**, not in Git or frontend code:

| Variable | Value |
| --- | --- |
| `FLARETUNE_PLUGIN_SITE_URL` | Your site's HTTPS origin, without a path or query, matching the target Worker |
| `FLARETUNE_PLUGIN_BUILD_TOKEN` | The same token saved on the site; store as a secret |
| `FLARETUNE_PLUGIN_WORKER_NAME` | The actual target Worker name |
| `CLOUDFLARE_ACCOUNT_ID` | The target Worker's Cloudflare account |
| `CLOUDFLARE_API_TOKEN` | A secret with permission to read, upload and deploy the target Worker |
| `FLARETUNE_PLUGIN_WRANGLER_CONFIG` | Optional; defaults to `wrangler.toml`, and must match the actual host and bindings |
| `FLARETUNE_PLUGIN_WRANGLER_ENV` | Optional; empty uses the base configuration; any environment must match the real target |

4. Connect the assembly, checking, deployment and reporting steps below while retaining the existing bindings and permissions. The build token authorizes plan/running-package reads, controlled host-upgrade reservation and reporting. It is not an administrator login or permission to read user settings.
5. Complete setup in **Manual** mode before enabling Automatic if desired. Automatic requires both the hook and build token. Saving configuration, changing mode or refreshing a catalog does not itself start a build.

The hook URL grants trigger permission to anyone holding it. Protect it as a secret; never include it in catalog JSON, screenshots, public source or logs. See [Cloudflare's credential guidance](https://developers.cloudflare.com/workers/ci-cd/builds/deploy-hooks/).

### Maintainer-specific CI wrappers

`plugins:ci-build` and `plugins:ci-deploy` are pinned to the maintainer's test installation. Its separate controller owns the Git connection, build records and hook, has no application bindings or public application service, and deploys the actual application target separately. Creating such infrastructure is a deployer's action, not something plugin installation does automatically.

The controller's Builds branch, hook branch and `FLARETUNE_PLUGIN_BUILD_BRANCH` are pinned to `dev`. With preview builds disabled, a mismatch can be rejected with Cloudflare error `12068`; changing a build script alone does not fix that restriction. A migration keeps the existing hook identity and secrets. Disable the application's legacy direct Git build entry before pushing dev, so the same push cannot run two deployment paths; keep the running application, bindings, installed plugins and main production channel intact.

The controller uses `npm run plugins:ci-build` and `npm run plugins:ci-deploy`. The build wrapper runs `prepare-current` first, continuing a matching plan or reserving a host upgrade from the running combination when dev changes. It inherits the site's exact installed packages instead of restoring uninstalled packages from the release seed.

The wrappers use `FLARETUNE_PLUGIN_SITE_URL`, `FLARETUNE_PLUGIN_WORKER_NAME`, `FLARETUNE_PLUGIN_BUILD_BRANCH`, `CLOUDFLARE_ACCOUNT_ID`, `FLARETUNE_PLUGIN_BUILD_TOKEN` and `FLARETUNE_PLUGIN_DEPLOY_WORKER_TAG`. The deployment tag belongs to the actual application Worker, not the controller. Builds supplies its configured `CLOUDFLARE_API_TOKEN`, which must have application-target permissions. A temporary Builds-configuration token is not a replacement deployment credential.

These wrappers also check the controller, branch, application identity, source digest and complete bindings, including the pinned test database. **Other installations cannot use them by copying these variables.** Use the generic sequence below with your own verified account, Worker, configuration and bindings, or separately adapt and validate a wrapper for your instance. The maintainer's manual reinstall exception does not establish a migration path for other deployments.

## Build integration sequence

Read `GET /api/plugin-build/snapshot` with `Authorization: Bearer <build-access-token>`. It returns the saved task's fixed plan, not the latest catalog. Report to `POST /api/plugin-build/report` using the same authentication and `buildId`, `planDigest` and `status`. Status values are `building`, `deploying`, `activation_pending`, `rolling_back`, `failed`, `rolled_back` and `deployed`. The credential cannot manage sources, rewrite targets or read user configuration.

The order is: read and verify the fixed plan and host baseline → verify and assemble packages → lock and build both sides → record original traffic and upload an inactive version → check the plan again → report `deploying` → recheck that another deployment has not changed the target → promote traffic → verify the live combination and D1 activation. A successful trigger or accepted report alone does not mean activation succeeded. The actual deployment serving the API must validate its combination fingerprint.

Install dependencies from the project lockfile, then run:

```sh
npm run plugins:prepare
npm run plugins:lock
npm run build
npm run plugins:deploy
```

`prepare` authenticates, reads the snapshot, verifies the current host/lock, checks downloaded packages and generates static bindings. Success reports `building`; failure attempts to report `failed`. `plugins:lock` records the assembled combination. `build` creates the frontend. `plugins:deploy` verifies the target and task, uploads, promotes traffic and reports the result. Stop if the task has been invalidated. Do not substitute a bare `wrangler deploy`.

In the dedicated channel, the **build command** can stop at the first failed step:

```sh
npm run plugins:prepare && npm run plugins:lock && npm run build
```

Its **deploy command** is:

```sh
npm run plugins:deploy
```

That command really updates the target Worker. Documentation is not authorization to run it against an existing instance. Do not silently replace ordinary development or main-branch release commands with plugin-channel commands.

Before promoting traffic, the tool compares the uploaded version's actual `resources.bindings` with every running version. Changes to D1, KV, R2, services, Durable Objects, variables or secret-binding identities/types reject deployment. A matching Worker name or syntactically valid resource ID is insufficient. Different bindings across running versions also reject the operation. Binding contents and their digest are not written into recovery receipts or logs. The locked Wrangler configuration must match the expected name, account, entry point and real resource IDs; empty or placeholder bindings cannot create resources through plugin installation.

For a confirmed failure before upload/promotion, report `npm run plugins:report -- failed` only after this task has actually been reserved/prepared. A local preflight failure before reserving a host upgrade must not report failure using an older generated task. After `deploying`, verify whether D1 committed before deciding what happened. A lost response may follow a successful commit: use the same task's repeatable snapshot/build status and idempotent `deployed` confirmation; do not rerun `prepare` or blindly restore old code. Leave `activation_pending` frozen if the outcome cannot be established.

A host version/source mismatch stops an ordinary plugin task; installing a plugin must not also upgrade the host. Package handling must not execute installation scripts or gain deployment credentials. Validate the complete integration in your own isolated environment; the commands do not demonstrate that your Cloudflare instance has passed it.

## Host upgrades and exact combination inheritance

This maintainer-controlled build protocol requires the running site to implement `/api/plugin-build/upgrade`. If it does not, use the controlled bridge described below; do not bypass the check. Routine system updates use a separate trusted official Release flow and accept no arbitrary repository URLs. This protocol originates from trusted maintainer source/builds. Manual/Automatic controls plugin selection changes, not system release upgrades.

Using the same build token, `GET /api/plugin-build/upgrade` returns the serving `host`, exact running package IDs/versions/sources/hashes, and baseline fields including `revision`, `registryRevision` and `runningDigest`. It returns no site/personal settings or encrypted credentials. `POST /api/plugin-build/upgrade` accepts only the target `host` and expected `revision`, `registryRevision`, `fromHost`, `runningDigest`; take all expected values from the same GET, using its `host` as `fromHost`. It does not accept a package list. The site freezes its verified running combination rather than accepting a builder's seed or latest-catalog replacement.

| Preparation command | Purpose |
| --- | --- |
| `npm run plugins:prepare-current` | Continue an active same-host plan or replay its deployed plan; if the host changes, reserve an upgrade inheriting the running combination. CI may resume the same frozen new-host task. |
| `npm run plugins:prepare-host-upgrade` | Explicit host upgrade only. Rejects an unchanged host rather than turning the operation into plugin installation. |
| `npm run plugins:prepare` | Prepare an existing ordinary plugin plan; does not reserve a host upgrade. |

After reviewing new host code, update and commit its release combination lock with `npm run plugins:lock`. `prepare-current` checks the actual checkout host against that lock. An arbitrary unlocked checkout cannot reserve an upgrade. After freezing and assembling the site's exact combination, the second lock operation records the site combination; it does not replace release-baseline validation.

In a verified host checkout, the generic flow is:

```sh
npm run plugins:prepare-current
npm run plugins:lock
npm run build
npm run plugins:deploy
```

Replace the first command with `npm run plugins:prepare-host-upgrade` when the operation is explicitly restricted to upgrading the host. Retain the channel's credentials, target, Wrangler configuration and recovery receipt. Other deployments must not substitute the maintainer-pinned `plugins:ci-*` wrappers.

The protocol inherits exact installed package IDs, versions, immutable URLs, source ownership and SHA. It does not fetch latest versions, update plugins or reinstall removed packages. Seed may restore verified caches, not change the inherited combination. Settings, encrypted credentials and business data stay in the original database; installation epochs/revisions are retained. The protocol does not export/copy settings or use uninstall/reinstall to simulate an upgrade. These are protocol guarantees to test against the actual starting version, not evidence that a general 1.2.1 upgrade has passed.

Pending selections, another active plan or an unknown result prevent a new upgrade. Resolve them first; do not merge or discard them silently. CI may resume the same reserved new-host task. Once in `deploying`, `activation_pending` or `rolling_back`, follow recovery checks. Pre-reservation checkout/compatibility failures do not report against an old build; later package/build failures report only the reserved new task. After traffic may have changed, establish the actual deployment and D1 result rather than assuming failure left the old host serving.

Completion requires the real new host and combination metadata to match the frozen plan, complete binding checks and successful D1 activation. A host rollback must also prove that the recorded `previousHost` actually serves again. New code cannot claim to be the old host in a `rolled_back` report. Code rollback does not revert configuration or data changes.

If GET is unavailable, the tool returns `PLUGIN_HOST_UPGRADE_UNAVAILABLE`; it does not fall back to seed. A controlled bridge must separately deploy only the exact running packages, verify all bindings, honestly retain `pluginDeployment=null`, and preserve D1 installation records and configuration. Record bridge deployment separately from a later upgrade to a genuinely different host. A bridge succeeding does not validate the subsequent upgrade, and no universal bridge procedure from stock 1.2.1 is claimed here.

## When plugin changes take effect

Confirming installation, update or removal shows scope, dependency checks and application mode. Saving first creates **pending changes**; the running combination remains unchanged.

- **Manual:** select multiple changes, then use **Build and deploy** once. You may save a target before the channel is configured, then build after completing setup.
- **Automatic:** each explicit confirmation of a code-combination change starts a build. Source refreshes, publisher releases, secret edits and personal preferences do not automatically install or update code.

The fixed target is locked during a build. Only a matching deployed host/plugin fingerprint and completed required data updates make it installed/updated and accessible to members. An unconfirmed new deployment rejects plugin business access; do not assume old code always remains live. After deployment, use **Reload page**, then verify entries and behavior. Ordinary plugin settings need no rebuild. Reload an old frontend when its build differs from the Worker; do not bypass compatibility checks.

## Failure, retry and recovery

- **Source unavailable:** verify the public HTTPS URL and catalog format, then refresh. Existing running plugins remain. Repeated deployment cannot create an unpublished catalog.
- **Build rejected:** check hook/token configuration, host baseline, package hashes and dependencies. The target stays pending; rejection does not replace the running combination.
- **Confirmed build failure:** inspect the safe error and build-platform records, fix the cause, then retry the same target or discard pending changes. Failure does not delete plugin data or user configuration.
- **Unknown trigger result:** a timeout does not prove no build started. Keep the snapshot and edit/discard lock, and resume or retry the same target. If reporting cannot arrive, first establish in the remote build service that jobs have stopped, then explicitly unlock the local task. Unlocking invalidates its old ID; it neither cancels remote jobs nor proves they stopped.
- **Deployed but not activated:** check task ID, plan digest, the real Worker combination and required data updates. A successful trigger or `deployed` report alone is insufficient.

After deployment has started, use:

```sh
npm run plugins:deploy -- recover
```

Keep the same working directory and `tooling/plugins/.delivery-recovery/<buildId>.json` receipt. It contains no secrets, but records the actual previous versions/traffic; retain it as a protected CI artifact for recovery across sessions. Without it, do not guess the old version.

Only after confirming D1 has not activated may recovery obtain the site's atomic `rolling_back` intent lock, preventing concurrent activation. It then verifies traffic belongs only to this task's old/new versions, restores the exact original traffic, verifies original identity/source digest, and reports `rolled_back`. If D1 may have committed, the original deployment is unclear or recovery is unconfirmed, keep the task frozen. Do not blindly revert code; plugin data does not automatically roll back.

Discarding an unexecuted or confirmed failed target only restores pending selection; it does not uninstall running plugins. Uninstall retains data and revokes the old installation epoch. Code rollback does not restore an older database schema or pre-migration data.

Before deployment, administrators can resolve a stopped task through `POST /api/admin/plugin-delivery/build/resolve` with `{ revision, confirmedStopped: true }`. This requires renewed confirmation that remote jobs were checked/stopped, preserves the target for editing/retry, and invalidates old snapshot/report access. The builder must still check task validity before deployment. This local recovery endpoint neither stops remote jobs nor bypasses deployment/D1 verification in `deploying`, `activation_pending` or `rolling_back`.
