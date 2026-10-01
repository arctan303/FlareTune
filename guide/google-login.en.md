# Google sign-in

Google sign-in is optional and disabled by default. It links existing FlareTune accounts without registration, email-based merging, role changes or data ownership changes. Local password sign-in remains available; initial setup still requires a password.

## Administrator setup

1. Upgrade existing instances under **Settings → Instance settings → Runtime overview**. New installations include the required tables.
2. Configure a **Web application** OAuth client and consent screen in Google Cloud. An existing Cloud project can be used; the Client ID, Secret and redirects must belong to the same Web client. Add test users when required by the console.
3. Under **Instance settings → Google sign-in**, click **Edit configuration** and enter the Client ID, Secret and fixed callback origin in the dialog, for example `https://music.example.com`. Include only the scheme, host and optional port, without a path or trailing slash.
4. Add the displayed full address to Google's **Authorized redirect URIs**: `https://music.example.com/auth/google/callback`. Sign-in and linking share this exact callback.
5. Save the configuration, then turn on the switch on the right of the card; changes save immediately. This origin's sign-in page shows **Sign in with Google**. Other origins do not. Enabling before configuration opens the editor; saving enables sign-in, while canceling leaves it disabled.

Production requires HTTPS. Local development can use a fixed origin such as `http://127.0.0.1:8790`. Open the Worker at the callback origin directly. A frontend proxy at another origin receives its own transaction cookie and cannot complete a callback at a different site. Configure development and production separately.

The Secret is encrypted server-side and never returned by the API. Leave it blank to retain it. Changing the Client ID requires its matching Secret. After rotating `SETUP_SECRET`, enter the Google Secret again. Local password sign-in is unaffected. Disabling sign-in keeps account links; usable credentials still allow users to manage links.

## User steps

1. Sign in with your local username and password and complete any required password change.
2. Under **Personal settings → Google sign-in**, select **Link Google**, verify your local password and choose your Google account.
3. Use Google for future sign-ins without entering the local password. Google may still require account selection, consent or identity verification.

A Google account can link to only one local account. Unlinked, disabled or password-change-required accounts cannot use Google sign-in. Unlinking requires your local password and signs this account out on all devices; playlists, favorites and listening data remain. Unlink before linking a different Google account.

## Troubleshooting

- Redirect mismatch: check the origin and exact redirect configured in Google.
- Missing button: check the switch, database upgrade, credentials, decryption and current origin.
- Expired or failed: start again in the same browser. Do not copy another browser's callback. Only the latest browser transaction is guaranteed when using multiple tabs.
- Unlinked account: sign in locally and link it. Matching email addresses do not link automatically.
- Linking failure: check for an existing link, an expired local session or a changed password.

Password changes, account status changes and added/removed Google links cancel unfinished Google sign-ins across the instance. Established sessions of other accounts are unaffected. Configuration changes also invalidate pending transactions. Errors never expose tokens or secrets.

Protocol references: [Google Web OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect). Verify real authorization on a correctly configured instance; local simulated tests do not replace it.
