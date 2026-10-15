# FlareTune 快速開始

[免登入試用線上 Demo](https://flaretune.arcinks.com) · [體驗範圍與素材授權（英文）](demo.en.md)。示範以管理員身分呈現完整設定；本機偏好可修改，管理設定僅供查看。助手可傳送訊息並收到固定範例回覆，不呼叫模型。

[繁體中文](quickstart.zh-Hant.md) · [English](../README.en.md) · [简体中文](../README.md)

不必維護 VPS，在 Cloudflare 建立自己的私人音樂庫。Workers 提供應用程式、D1 保存中繼資料、私人 R2 儲存音訊與封面。R2 Standard 每月有 10 GB-month 免費額度；帳號總用量、請求及選用服務仍可能產生費用，請先閱讀[費用說明（英文）](deployment.en.md)。

先試用[免登入 Demo](demo.md)：可播放、搜尋、收藏和編輯播放清單，個人資料只存在目前瀏覽器。

1. 準備 Cloudflare 帳號並開通 R2，按 [Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/arctan303/FlareTune) 建立獨立資源。
2. 設定並妥善保存至少 32 字元的隨機 `SETUP_SECRET`。
3. 開啟部署網址，驗證密鑰、建立管理員帳號並登入。
4. 匯入自己有權使用的歌曲，再搜尋、播放、收藏與建立播放清單。大量檔案可用[本機匯入裝置（英文）](../tooling/ingest-agent/README.en.md)。

個人設定可選「繁體中文」或跟隨瀏覽器。一般執行個體的收藏和播放清單隨帳號保存；播放歷史僅保存在目前瀏覽器。AI 為選用功能，播放不依賴模型。更新前備份 D1 與 R2，不要用新安裝流程覆蓋既有執行個體。

完整指南：[使用](using-flaretune.md) · [部署](deployment.md) · [管理](administration.md) · [第三方播放器](subsonic.md)。其他指南目前提供簡體中文與英文。
