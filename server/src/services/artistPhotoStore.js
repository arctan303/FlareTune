import { ARTIST_PHOTO_SCHEMA_VERSION } from './artistPhotoSources.js';

export async function getArtistPhotoFromDb(db, artistName) {
    if (!db || !artistName) return null;
    try {
        const row = await db.prepare(`
            SELECT artist_name, photo_url, photos, source, width, height,
                data_version, created_at, updated_at
            FROM Artist_Photos
            WHERE artist_name = ?
        `).bind(artistName).first();
        if (!row) return null;
        let photos = [];
        try {
            photos = typeof row.photos === 'string' ? JSON.parse(row.photos) : (row.photos || []);
        } catch {
            photos = [];
        }
        return { ...row, photos };
    } catch (error) {
        console.error('D1 getArtistPhotoFromDb error:', artistName, error);
        return null;
    }
}

export async function saveArtistPhotoToDb(db, photoRecord) {
    if (!db || !photoRecord?.artist_name) return false;
    const now = Math.floor(Date.now() / 1000);
    try {
        await db.prepare(`
            INSERT INTO Artist_Photos (artist_name, photo_url, photos, source, width, height, data_version, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(artist_name) DO UPDATE SET
                photo_url = excluded.photo_url,
                photos = excluded.photos,
                source = excluded.source,
                width = excluded.width,
                height = excluded.height,
                data_version = excluded.data_version,
                updated_at = excluded.updated_at
        `).bind(
            photoRecord.artist_name,
            photoRecord.photo_url || '',
            JSON.stringify(photoRecord.photos || []),
            photoRecord.source || 'tadb',
            photoRecord.width || 0,
            photoRecord.height || 0,
            ARTIST_PHOTO_SCHEMA_VERSION,
            now,
            now,
        ).run();
        return true;
    } catch (error) {
        console.error('D1 saveArtistPhotoToDb error:', photoRecord.artist_name, error);
        return false;
    }
}
