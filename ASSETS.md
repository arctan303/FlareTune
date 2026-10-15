# 素材与数据许可

项目原创代码与文档采用 [MIT 许可证](LICENSE)。第三方依赖各自遵循其上游许可证；MIT 不改变下列素材的许可。

## 页面照片

维护者确认 `client/src/assets/categories/*.jpg` 与 `client/src/assets/editorial-art-bg.jpg` 来自 **Unsplash**。这些照片按 [Unsplash License](https://unsplash.com/license) 使用，**不是 MIT 素材**。Unsplash 允许免费下载、复制、修改、使用和分发普通图库照片，包括商业用途；署名不强制要求，但鼓励致谢摄影师。不得将未经充分修改的图片单独出售，也不得汇编图片来复制类似 Unsplash 的服务。

仓库目前没有逐张照片的原始页面和摄影师记录，后续取得链接时可在此补上致谢。如有素材来自 Unsplash+，需按该素材实际适用的许可单独核对，不能直接套用普通 Unsplash License。

## 品牌标识与参考数据

`client/public/favicon.*` 是 FlareTune 的项目标识；应用内 `Tune` 字标作为产品标识使用。这些品牌素材不纳入 MIT 或 Unsplash 照片许可的再授权。`data/music/songs.json` 与 `server/db/seed.sql` 只含虚构曲目和歌单示例；对应音频、封面和歌词文件并未随仓库提供。

`guide/images/desktop-roam.png`、`mobile-roam.png`、`player-desktop.png` 和 `player-mobile.png` 是在隔离的本地演示实例中截取的实际应用页面，使用虚构曲目。截图内的示例封面复用了上述 Unsplash 页面照片，因此截图中的照片部分仍遵循 Unsplash License。

`guide/images/home-desktop.png`、`artist-desktop.png`、`appearance-desktop.png`、`player-current-desktop.png`、`player-current-mobile.png` 和 `lyrics-current-mobile.png` 由维护者提供，展示本地实例中的真实界面。截图出现的曲名、歌词、专辑封面和其他第三方内容仅用于界面展示，不作为 MIT 授权素材或项目随附曲库提供；相关权利仍归原权利人。

`guide/logo-concepts/` 保留标识探索图；其中第二版“三条声波”已用于项目图标。探索图和正式图标均不纳入 MIT 代码与文档许可。

部署者自行导入的音频、封面、歌词与歌手照片不属于本仓库授权范围；请确认自己有权存储和使用这些内容。

## 公开 Demo

Demo 音乐按 [demo/catalog.json](demo/catalog.json) 的逐曲许可使用，下载的音频不纳入 Git。Kevin MacLeod 作品采用 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)，须保留作者、来源、许可与加工说明；Rocks From The Garden 的《Amazing Grace》录音按来源页的作者公开领域贡献使用。歌词为公共领域文本，项目添加人工逐行时间轴；几何封面为原创图形。

Demo 分类图 `demo/category.svg` 和演示背景均为本项目原创几何图；Demo 构建不打包正式分类照片，也不请求外部背景图。背景预设在 Demo 中改用示例封面。
