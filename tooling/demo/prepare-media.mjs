// The checked-in manifest is the allow-list and immutable content baseline.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = new URL('../../demo/public/media/', import.meta.url);
const songs = JSON.parse(await readFile(new URL('../../demo/catalog.json', import.meta.url), 'utf8'));
await mkdir(root, {recursive: true});
for (const [index, song] of songs.entries()) {
  const file = new URL(`${song.id}.mp3`, root);
  let bytes;
  try { bytes = await readFile(file); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch(song.download);
    if (!response.ok) throw Error(`Download failed (${response.status}): ${song.title}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (bytes.length !== song.bytes || createHash('sha256').update(bytes).digest('hex') !== song.sha256) {
    throw Error(`Source changed or file damaged: ${song.id}. Review its license and content before updating the manifest.`);
  }
  if (bytes.length > 25 * 1024 * 1024) throw Error(`Static asset too large: ${song.id}`);
  await writeFile(file, bytes);
  const colors = ['#315f67','#6b4d72','#b0713e','#3f5f4c','#576a9c','#925968'];
  const title = song.title.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600"><rect width="600" height="600" fill="${colors[index % colors.length]}"/><circle cx="300" cy="255" r="170" fill="none" stroke="#fff" stroke-opacity=".2" stroke-width="60"/><circle cx="300" cy="255" r="65" fill="#fff" fill-opacity=".3"/><text x="36" y="480" fill="#fff" font-family="sans-serif" font-size="28">${title}</text><text x="36" y="530" fill="#fff" fill-opacity=".7" font-family="sans-serif" font-size="18">FlareTune · Open Music</text></svg>`;
  await writeFile(new URL(`${song.id}.svg`, root), svg);
  console.log(`${song.id}: verified ${song.title}`);
}
