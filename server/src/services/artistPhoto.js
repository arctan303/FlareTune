import { parseArtistNames } from '../utils/artistParser.js';
import {
    ARTIST_PHOTO_SCHEMA_VERSION,
    MAX_GALLERY_CAP,
    fetchArtistPhotosFromSources,
} from './artistPhotoSources.js';
import {
    getArtistPhotoFromDb,
    saveArtistPhotoToDb,
} from './artistPhotoStore.js';

export {
    ARTIST_PHOTO_SCHEMA_VERSION,
    MAX_GALLERY_CAP,
    TARGET_MIN_COUNT,
    deduplicateHighestResolution,
    fetchAppleMusic,
    fetchArtistPhotosFromSources,
    fetchQqMusic,
    fetchTheAudioDB,
    filterLowResolutionPhotos,
    getImageFingerprint,
    rankAndPadPhotos,
} from './artistPhotoSources.js';
export {
    deleteArtistPhotoFromDb,
    getArtistPhotoFromDb,
    saveArtistPhotoToDb,
} from './artistPhotoStore.js';

export function interleaveArtistPhotos(artistRecords) {
    if (!artistRecords?.length) return [];
    if (artistRecords.length === 1) return artistRecords[0].photos || [];

    const photos = [];
    const seenUrls = new Set();
    const maxLength = Math.max(...artistRecords.map((record) => (record.photos || []).length));
    for (let index = 0; index < maxLength; index += 1) {
        for (const record of artistRecords) {
            const photo = record.photos?.[index];
            if (!photo || seenUrls.has(photo.url)) continue;
            seenUrls.add(photo.url);
            photos.push({ ...photo, artistName: record.artist_name });
        }
    }
    return photos.slice(0, MAX_GALLERY_CAP);
}

export async function resolveArtistPhotos(db, rawArtistName) {
    if (typeof rawArtistName !== 'string' || !rawArtistName) {
        return { artist: '', primary: null, photos: [] };
    }

    const artistNames = parseArtistNames(rawArtistName);
    if (artistNames.length === 0) {
        return { artist: rawArtistName, primary: null, photos: [] };
    }

    const resolvedArtists = await Promise.all(artistNames.map(async (name) => {
        const cached = await getArtistPhotoFromDb(db, name);
        if (cached?.data_version === ARTIST_PHOTO_SCHEMA_VERSION && cached.photos?.length > 0) {
            return cached;
        }
        const fresh = await fetchArtistPhotosFromSources(name);
        if (db && fresh.photos?.length > 0) await saveArtistPhotoToDb(db, fresh);
        return fresh;
    }));

    const photos = interleaveArtistPhotos(resolvedArtists);
    return {
        artist: rawArtistName,
        artistNames,
        primary: photos[0]?.url || '',
        photos,
        meta: {
            artistsCount: artistNames.length,
            totalPhotos: photos.length,
        },
    };
}
