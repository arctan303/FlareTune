import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const catalog = JSON.parse(await readFile(new URL('../../demo/catalog.json',import.meta.url),'utf8'));
for (const song of catalog) {
  const bytes = await readFile(new URL(`../../demo/public${song.audio_url}`,import.meta.url)).catch(()=>{
    throw Error(`Missing licensed demo media: ${song.id}. Run npm run demo:media first.`);
  });
  if (bytes.length !== song.bytes || createHash('sha256').update(bytes).digest('hex') !== song.sha256) throw Error(`Media integrity mismatch: ${song.id}`);
  if (bytes.length > 25*1024*1024) throw Error(`Media too large: ${song.id}`);
  await readFile(new URL(`../../demo/public${song.cover_url}`,import.meta.url));
}
console.log(`${catalog.length} licensed demo audio files verified`);
