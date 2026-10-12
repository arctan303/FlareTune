# FlareTune クイックスタート

[日本語](quickstart.ja.md) · [English](../README.en.md) · [简体中文](../README.md)

VPS を管理せずに、Cloudflare で自分の音楽ライブラリを作れます。アプリは Workers、メタデータは D1、音声とカバーは非公開の R2 に置きます。R2 Standard には月 10 GB-month の無料枠があります。アカウント全体の使用量、リクエスト、任意のサービスによって料金が発生するため、[料金の説明（英語）](deployment.en.md)をご確認ください。

まず[ログイン不要のデモ](demo.en.md)で再生、検索、お気に入り、プレイリストを試せます。個人データはこのブラウザーに保存され、管理や AI は読み取り専用の例です。

1. Cloudflare アカウントで R2 を有効にし、[Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/arctan303/FlareTune) からリソースを作成します。
2. 32 文字以上のランダムな `SETUP_SECRET` を設定し、安全に保管します。
3. デプロイ先を開き、シークレットを確認して管理者を作成し、ログインします。
4. 利用する権利のある音楽を取り込みます。大量のファイルには[ローカル取り込みツール（英語）](../tooling/ingest-agent/README.en.md)を利用できます。

個人設定で日本語を選択できます。通常のインスタンスではお気に入りとプレイリストがアカウントに保存され、再生履歴は現在のブラウザーに残ります。AI は任意です。更新前に D1 と R2 をバックアップし、既存のインスタンスを新規初期化で上書きしないでください。

詳しいガイド（英語）：[使い方](using-flaretune.en.md) · [デプロイ](deployment.en.md) · [管理](administration.en.md) · [Subsonic](subsonic.en.md)。
