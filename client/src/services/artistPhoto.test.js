import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArtistNames } from '../../../server/src/utils/artistParser.js';
import {
    getImageFingerprint,
    deduplicateHighestResolution,
    filterLowResolutionPhotos,
    rankAndPadPhotos,
    TARGET_MIN_COUNT,
    ARTIST_PHOTO_SCHEMA_VERSION
} from '../../../server/src/services/artistPhotoSources.js';

test('parseArtistNames - 智能拆分合作、合唱、Feat.等多歌手', () => {
    // 单一歌手
    assert.deepEqual(parseArtistNames('周杰伦'), ['周杰伦']);
    assert.deepEqual(parseArtistNames('  Taylor Swift  '), ['Taylor Swift']);
    
    // 斜杠 / 反斜杠
    assert.deepEqual(parseArtistNames('周杰伦 / 费玉清'), ['周杰伦', '费玉清']);
    assert.deepEqual(parseArtistNames('周杰伦/温岚'), ['周杰伦', '温岚']);
    assert.deepEqual(parseArtistNames('A \\ B / C'), ['A', 'B', 'C']);

    // 英文 feat / ft / with / vs
    assert.deepEqual(parseArtistNames('Taylor Swift feat. Kendrick Lamar'), ['Taylor Swift', 'Kendrick Lamar']);
    assert.deepEqual(parseArtistNames('Marshmello ft. CHVRCHES'), ['Marshmello', 'CHVRCHES']);
    assert.deepEqual(parseArtistNames('Coldplay with BTS'), ['Coldplay', 'BTS']);
    assert.deepEqual(parseArtistNames('林俊杰 vs 蔡依林'), ['林俊杰', '蔡依林']);

    // 标点符号与连字符
    assert.deepEqual(parseArtistNames('米津玄師 & 菅田将暉'), ['米津玄師', '菅田将暉']);
    assert.deepEqual(parseArtistNames('周深, G.E.M.邓紫棋'), ['周深', 'G.E.M.邓紫棋']);
    assert.deepEqual(parseArtistNames('YOASOBI; Ayase'), ['YOASOBI', 'Ayase']);
    assert.deepEqual(parseArtistNames('王菲 · 梁朝伟'), ['王菲', '梁朝伟']);

    // 重复名称去重
    assert.deepEqual(parseArtistNames('周杰伦 / 周杰伦'), ['周杰伦']);

    // 空值防守
    assert.deepEqual(parseArtistNames(''), []);
    assert.deepEqual(parseArtistNames(null), []);
});

test('getImageFingerprint & deduplicateHighestResolution - 跨分辨率同图去重', () => {
    const rawList = [
        {
            url: 'https://y.gtimg.cn/music/photo_new/T001R800x800M0000025NhlN2y5Zfx.jpg',
            width: 800,
            height: 800,
            source: 'qq'
        },
        {
            url: 'https://y.gtimg.cn/music/photo_new/T001R1500x1500M0000025NhlN2y5Zfx.jpg',
            width: 1500,
            height: 1500,
            source: 'qq'
        },
        {
            url: 'https://is1-ssl.mzstatic.com/image/thumb/Music112/v4/01/1500x1500bb.jpg',
            width: 1500,
            height: 1500,
            source: 'applemusic'
        },
        {
            url: 'https://is1-ssl.mzstatic.com/image/thumb/Music112/v4/01/600x600bb.jpg',
            width: 600,
            height: 600,
            source: 'applemusic'
        }
    ];

    const deduped = deduplicateHighestResolution(rawList);
    assert.equal(deduped.length, 2);
    
    // QQ 音乐保留 1500x1500 原图
    const qqWinner = deduped.find(p => p.source === 'qq');
    assert.equal(qqWinner.width, 1500);
    assert.equal(qqWinner.height, 1500);

    // Apple Music 保留 1500x1500 原图
    const appleWinner = deduped.find(p => p.source === 'applemusic');
    assert.equal(appleWinner.width, 1500);
});

test('filterLowResolutionPhotos - 严格画质拦截', () => {
    const candidates = [
        { url: 'a.jpg', width: 1920, height: 1080 }, // 16:9 1080P -> 通过
        { url: 'b.jpg', width: 1280, height: 720 },  // 16:9 720P -> 通过
        { url: 'c.jpg', width: 1500, height: 1500 }, // 1:1 1500px -> 通过
        { url: 'd.jpg', width: 800, height: 800 },   // 1:1 800px -> 通过
        { url: 'e.jpg', width: 700, height: 700 },   // 1:1 700px -> 淘汰！
        { url: 'f.jpg', width: 600, height: 600 },   // 1:1 600px -> 淘汰！
        { url: 'g.jpg', width: 500, height: 500 },   // 1:1 500px -> 淘汰！
        { url: 'h.jpg', width: 1000, height: 500 },  // 16:9 低于 720p -> 淘汰！
    ];

    const passed = filterLowResolutionPhotos(candidates);
    assert.equal(passed.length, 4);
    assert.deepEqual(passed.map(p => p.url), ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg']);
});

test('rankAndPadPhotos - 4张保底动态按需补位与分辨率最优排序', () => {
    // 场景 1：真写真充沛 (6张真写真) -> 100% 纯真写真输出，0 封面混入
    const richReal = [
        { url: 'real1.jpg', width: 1500, height: 1500, isRealArtist: true },
        { url: 'real2_1080p.jpg', width: 1920, height: 1080, isRealArtist: true }, // 16:9 加权排第一
        { url: 'real3.jpg', width: 1500, height: 1500, isRealArtist: true },
        { url: 'real4.jpg', width: 800, height: 800, isRealArtist: true },
        { url: 'real5.jpg', width: 800, height: 800, isRealArtist: true },
        { url: 'real6.jpg', width: 1500, height: 1500, isRealArtist: true }
    ];
    const appleCovers = [
        { url: 'apple1.jpg', width: 1500, height: 1500, source: 'applemusic' },
        { url: 'apple2.jpg', width: 1500, height: 1500, source: 'applemusic' }
    ];

    const richResult = rankAndPadPhotos(richReal, appleCovers);
    assert.equal(richResult.isPureReal, true);
    assert.equal(richResult.fallbackUsed, 0);
    assert.equal(richResult.photos.length, 6);
    // 1080P 16:9 写真依据画幅加权排在最前
    assert.equal(richResult.photos[0].url, 'real2_1080p.jpg');

    // 场景 2：真写真不足 (只有 2 张) -> 全量保留 2 张真写真，从 Apple Music 精准补足 2 张至 4 张
    const scarceReal = [
        { url: 'real_tadb.jpg', width: 1920, height: 1080, isRealArtist: true },
        { url: 'real_qq.jpg', width: 1500, height: 1500, isRealArtist: true }
    ];
    const scarceResult = rankAndPadPhotos(scarceReal, appleCovers);
    assert.equal(scarceResult.isPureReal, false);
    assert.equal(scarceResult.realCount, 2);
    assert.equal(scarceResult.fallbackUsed, 2);
    assert.equal(scarceResult.photos.length, 4);
    assert.equal(scarceResult.photos[0].url, 'real_tadb.jpg');
    assert.equal(scarceResult.photos[1].url, 'real_qq.jpg');
    assert.equal(scarceResult.photos[2].url, 'apple1.jpg');
    assert.equal(scarceResult.photos[3].url, 'apple2.jpg');
});
