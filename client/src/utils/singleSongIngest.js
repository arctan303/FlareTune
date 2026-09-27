import { catalogSongBody } from './catalogSongDraft.js';

export async function saveSingleSong({ audioFile, coverFile, draft, uploaded, uploadMedia, createSong,
  replaceTarget = null, updateSong, onUploaded, onStage, onProgress = () => {} }) {
  let next = { ...uploaded };
  if (next.audio?.file !== audioFile) {
    onStage('正在上传音频…');
    next.audio = { file: audioFile, url: (await uploadMedia('audio', audioFile,
      (loaded, total) => onProgress('audio', loaded, total))).url };
    onUploaded(next);
  }
  if (coverFile && next.cover?.file !== coverFile) {
    onStage('正在上传封面…');
    next.cover = { file: coverFile, url: (await uploadMedia('cover', coverFile,
      (loaded, total) => onProgress('cover', loaded, total))).url };
    onUploaded(next);
  }
  onStage('正在保存歌曲信息…');
  const body = catalogSongBody({
    ...draft,
    audio_url: next.audio.url,
    cover_url: coverFile ? next.cover?.url || '' : replaceTarget?.cover_url || '',
  }, !replaceTarget);
  if (replaceTarget) {
    if (!updateSong) throw new Error('缺少歌曲替换接口。');
    await updateSong(replaceTarget.id, { ...body, audio_url: next.audio.url,
      expectedVersion: replaceTarget.version });
  } else await createSong(body);
  return next;
}
