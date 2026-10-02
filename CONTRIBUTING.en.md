# Contributing

[简体中文](CONTRIBUTING.md) · [English](CONTRIBUTING.en.md)

Thanks for helping improve FlareTune. A usable Node.js ingest device is available; testing on more devices, operating systems, and collection sizes is welcome. Contributions to third-party player compatibility and interface localization are welcome too.

## Ways to help

- Test previews, duplicate detection, retries, and recovery with multiple songs on your own test instance. Report reproducible problems.
- Verify the ingest experience with different operating systems, browsers, and music file formats.
- Help verify Cloudflare R2 direct upload, multipart upload, and target bucket checks, or improve their tests and documentation.
- Research the basic [Subsonic/OpenSubsonic API](https://opensubsonic.netlify.app/docs/) and test interoperability with compatible clients. FlareTune provides this API; see the [third-party client guide](guide/subsonic.en.md) for supported features.
- Review Simplified Chinese and English interface copy and public documentation. Song language classification and interface localization are separate features.
- Improve the player, lyrics, assistant, accessibility, and user guides.

For installation, first configuration, and operation of the Node.js tool, see the [local ingest device guide](tooling/ingest-agent/README.en.md) (use `npm.cmd` instead of `npm` in Windows PowerShell). For code contributions, see [Local development](guide/local-development.en.md). Verify new features first with your own isolated instance and a small, replaceable sample collection.

## Issues and changes

When reporting a problem, include the operating system, Node.js version, browser, steps, expected result, and actual result. Share only the redacted logs needed to reproduce it. Do not publish account passwords, session cookies, Cloudflare/R2 secrets, personal music files, or another person's data.

`main` holds accepted releases for users to deploy. `dev` collects daily work and changes under development-Worker verification. Create feature branches from `dev`, test them, and merge into `dev` via pull request. When preparing a release, merge accepted `dev` changes into `main` via pull request. Run tests and builds relevant to your changes before submitting.

A Git branch does not create or bind Cloudflare D1/R2 resources. A development Worker must use separate development resources and private Wrangler configuration. Do not commit personal resource IDs, setup secrets, or production bindings. See [Local development](guide/local-development.en.md). Development plans and acceptance records live in the maintainer's internal workspace and are not public user documentation.

The root `/docs/` directory contains Git-ignored internal work records. Do not force-add it or remove its `.gitignore` exclusion. Write user-facing guides in `guide/`.
