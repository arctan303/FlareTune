export const ARTIST_PHOTO_SCHEMA_VERSION = 3;
export const TARGET_MIN_COUNT = 4;
export const MAX_GALLERY_CAP = 12;

function sameArtistName(requested, candidate) {
    if (typeof candidate !== 'string') return false;
    const normalize = (value) => value.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/gu, '');
    return normalize(requested) === normalize(candidate);
}

export function getImageFingerprint(photo) {
    if (!photo?.url) return '';
    try {
        const url = new URL(photo.url);
        if (photo.url.includes('y.gtimg.cn')) {
            const match = photo.url.match(/M000[0-9a-zA-Z]+/);
            if (match) return `qq_${match[0]}`;
        }
        if (photo.url.includes('mzstatic.com')) {
            const cleanPath = url.pathname.replace(/\/\d+x\d+bb\.[a-z]+$/i, '');
            return `applemusic_${cleanPath}`;
        }
        if (photo.url.includes('theaudiodb.com')) {
            return `tadb_${url.pathname.split('/').pop()}`;
        }
        return `${photo.source}_${url.pathname}`;
    } catch {
        return photo.url;
    }
}

export function deduplicateHighestResolution(photos) {
    const photosByFingerprint = new Map();
    for (const photo of photos) {
        const key = getImageFingerprint(photo);
        if (!key) continue;
        const existing = photosByFingerprint.get(key);
        if (!existing) {
            photosByFingerprint.set(key, photo);
            continue;
        }
        const existingArea = (existing.width || 0) * (existing.height || 0);
        const currentArea = (photo.width || 0) * (photo.height || 0);
        if (currentArea > existingArea) photosByFingerprint.set(key, photo);
    }
    return [...photosByFingerprint.values()];
}

export function filterLowResolutionPhotos(photos) {
    return photos.filter((photo) => {
        if (!photo?.url || !photo.width || !photo.height) return false;
        const ratio = photo.width / photo.height;
        return ratio >= 1.4
            ? photo.width >= 1280 && photo.height >= 720
            : photo.width >= 800 && photo.height >= 800;
    });
}

export async function fetchTheAudioDB(artist, onFailure = () => {}) {
    try {
        const url = `https://www.theaudiodb.com/api/v1/json/123/search.php?s=${encodeURIComponent(artist)}`;
        const response = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            cf: { cacheTtl: 86400, cacheEverything: true },
            signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) { onFailure(); return []; }
        const artistData = (await response.json())?.artists?.find((item) => sameArtistName(artist, item.strArtist));
        if (!artistData) return [];

        const photos = [];
        const addPhoto = (urlValue, label) => {
            if (typeof urlValue !== 'string' || !urlValue.startsWith('http')) return;
            photos.push({
                url: urlValue,
                type: 'fanart',
                label,
                source: 'tadb',
                sourceName: 'TheAudioDB',
                isRealArtist: true,
                width: 1920,
                height: 1080,
                is169: true,
            });
        };

        addPhoto(artistData.strArtistFanart, '1080P 舞台写真 1');
        addPhoto(artistData.strArtistFanart2, '1080P 舞台写真 2');
        addPhoto(artistData.strArtistFanart3, '1080P 舞台写真 3');
        addPhoto(artistData.strArtistFanart4, '1080P 舞台写真 4');
        addPhoto(artistData.strArtistWideThumb, '高清宽屏写真');
        return photos;
    } catch (error) {
        onFailure();
        console.error('TheAudioDB fetch error for artist:', artist, error);
        return [];
    }
}

export async function fetchQqMusic(artist, onFailure = () => {}) {
    try {
        const url = `https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?key=${encodeURIComponent(artist)}&format=json`;
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                Referer: 'https://y.qq.com/',
            },
            cf: { cacheTtl: 86400, cacheEverything: true },
            signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) { onFailure(); return []; }
        const singers = (await response.json())?.data?.singer?.itemlist || [];
        const photos = [];
        for (const singer of singers.filter((item) => sameArtistName(artist, item.name)).slice(0, 3)) {
            if (!/^[A-Za-z0-9]{1,80}$/u.test(singer.mid || '')) continue;
            photos.push({
                url: `https://y.gtimg.cn/music/photo_new/T001R1500x1500M000${singer.mid}.jpg`,
                type: 'portrait',
                label: `QQ音乐 1500px 原图写真 (${singer.name})`,
                source: 'qq',
                sourceName: 'QQ 音乐',
                isRealArtist: true,
                width: 1500,
                height: 1500,
                is169: false,
            });
            photos.push({
                url: `https://y.gtimg.cn/music/photo_new/T001R800x800M000${singer.mid}.jpg`,
                type: 'portrait',
                label: `QQ音乐 800px 高清写真 (${singer.name})`,
                source: 'qq',
                sourceName: 'QQ 音乐',
                isRealArtist: true,
                width: 800,
                height: 800,
                is169: false,
            });
        }
        return photos;
    } catch (error) {
        onFailure();
        console.error('QQ Music fetch error for artist:', artist, error);
        return [];
    }
}

export async function fetchAppleMusic(artist) {
    try {
        const url = `https://itunes.apple.com/search?term=${encodeURIComponent(artist)}&entity=album&limit=6`;
        const response = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            cf: { cacheTtl: 86400, cacheEverything: true },
        });
        if (!response.ok) return [];
        const results = (await response.json())?.results || [];
        return results.flatMap((item) => {
            if (!item.artworkUrl100) return [];
            return [{
                url: item.artworkUrl100.replace('100x100bb', '1500x1500bb'),
                type: 'cover',
                label: `Apple Music 1500px《${item.collectionName || item.trackName || ''}》`,
                source: 'applemusic',
                sourceName: 'Apple Music (兜底)',
                isRealArtist: false,
                width: 1500,
                height: 1500,
                is169: false,
            }];
        });
    } catch (error) {
        console.error('Apple Music fetch error for artist:', artist, error);
        return [];
    }
}

export function rankAndPadPhotos(realPhotos, fallbackCovers) {
    const sortedReal = [...realPhotos].sort((a, b) => {
        const score = (photo) => photo.width * (photo.width / (photo.height || 1) >= 1.4 ? 1.4 : 1);
        return score(b) - score(a);
    });
    const sortedFallback = [...fallbackCovers].sort((a, b) => b.width - a.width);

    if (sortedReal.length >= TARGET_MIN_COUNT) {
        return {
            photos: sortedReal.slice(0, MAX_GALLERY_CAP),
            realCount: sortedReal.length,
            fallbackUsed: 0,
            isPureReal: true,
        };
    }

    const supplementedCovers = sortedFallback.slice(0, TARGET_MIN_COUNT - sortedReal.length);
    return {
        photos: [...sortedReal, ...supplementedCovers],
        realCount: sortedReal.length,
        fallbackUsed: supplementedCovers.length,
        isPureReal: false,
    };
}

export async function fetchArtistPhotosFromSources(artistName, { includeCovers = true } = {}) {
    let providerFailures = 0;
    const onFailure = () => { providerFailures += 1; };
    const [tadbPhotos, qqPhotos, applePhotos] = await Promise.all([
        fetchTheAudioDB(artistName, onFailure),
        fetchQqMusic(artistName, onFailure),
        includeCovers ? fetchAppleMusic(artistName) : Promise.resolve([]),
    ]);
    const photos = deduplicateHighestResolution(filterLowResolutionPhotos([
        ...tadbPhotos,
        ...qqPhotos,
        ...applePhotos,
    ]));
    const result = rankAndPadPhotos(
        photos.filter((photo) => photo.isRealArtist === true),
        photos.filter((photo) => photo.source === 'applemusic'),
    );
    const primary = result.photos[0] || null;
    return {
        artist_name: artistName,
        photo_url: primary?.url || '',
        photos: result.photos,
        source: primary?.source || 'none',
        width: primary?.width || 0,
        height: primary?.height || 0,
        data_version: ARTIST_PHOTO_SCHEMA_VERSION,
        meta: {
            realCount: result.realCount,
            fallbackUsed: result.fallbackUsed,
            isPureReal: result.isPureReal,
            providerFailures,
        },
    };
}
