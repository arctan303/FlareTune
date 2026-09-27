/**
 * language 是歌曲类型、歌词与翻译能力的唯一歌曲属性事实源。
 */
import { isValidSongLanguage } from '../constants/language.js';

export function resolveSongLanguage(song) {
  return isValidSongLanguage(song?.language) ? song.language : null;
}
