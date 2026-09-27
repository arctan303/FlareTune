# 本地入库设备

在存放音乐的设备上安装 Node.js 并取得 FlareTune 项目代码，先执行：

```sh
npm install
npm run ingest:configure
```

配置命令依次询问设备名称、播放器实例根地址、管理员用户名和密码、本地音乐目录。多个目录用分号 `;` 分隔。它会先验证管理员登录与目录，再保存配置。密码直接保存在这台设备的用户配置文件中，请只在自己信任的设备上运行；配置文件不进入项目仓库。

以后运行一条命令即可启动：

```sh
npm run ingest
```

程序主动连接实例，不监听本机端口。旧的独立曲库管理网页不再由 `npm run ingest` 启动。只要程序保持运行，管理员就能在任意可访问播放器后台的设备打开「设置 → 歌曲入库 → 已连接设备目录」，筛选并勾选歌曲，加入与浏览器文件共用的预览清单。可在预览里编辑、查重、选择部分歌曲入库，也可按需查看单首封面；仅预览和勾选不会上传音频。

把歌曲放在 `zh`、`en`、`jp`／`ja`／`jn`、`ko`、`yue`、`纯音乐`／`instrumental` 子目录时，页面会把目录名作为可编辑的语言建议。运行工具的设备可以与操作网页的设备不同，且无需公网入站地址。设备离线时仍能看到最后一次扫描信息，重新上线后可点击「重新扫描」。

配置文件位于 Windows `%APPDATA%\FlareTune\ingest-agent.json`、macOS `~/Library/Application Support/FlareTune/ingest-agent.json` 或 Linux `${XDG_CONFIG_HOME:-~/.config}/flaretune/ingest-agent.json`。再次运行 `npm run ingest:configure` 会更新同一设备的配置。

第一版通过已有管理员媒体接口传输，单文件上限为 100 MB；上传任务按顺序执行，网络中断后重试沿用原媒体 ID。该版本尚未部署到生产实例。
