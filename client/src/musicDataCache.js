import { isValidSongLanguage } from './constants/language.js';
import { canReferenceAccountSong } from './utils/musicSource.js';

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const isValidMusicInitData = (value) => {
    if (!isRecord(value)) return false;

    const defaultPlaylist = value.default_playlist;
    if (!isRecord(defaultPlaylist) || !Array.isArray(defaultPlaylist.songs)) return false;
    if (!defaultPlaylist.songs.every((song) => (
        isRecord(song) && song.id != null && (isValidSongLanguage(song.language)
            || (song.language == null && song.source === 'youtube'
                && typeof song.id === 'string' && song.sourceId === song.id.slice(3)
                && canReferenceAccountSong(song)))
    ))) return false;

    if (!Array.isArray(value.other_playlists)) return false;
    if (!value.other_playlists.every((playlist) => isRecord(playlist) && playlist.id != null)) return false;

    return true;
};
