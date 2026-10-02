import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReadyLyricArtifact } from '../services/lyricAssetWorkflow.js';
import { structuredLyrics } from './lyrics.js';
import { reply } from './response.js';
import { fixture } from './test-support.js';

const song = { id: 's1', title: 'One & <two>', artist: 'Artist', language: 'ko' };
const make = async (lines, options = {}) => (await buildReadyLyricArtifact(song,
  { source: 'manual', format: 'lyricsfile', lines }, options)).artifact;
const layers = (artifact, enhanced = true) => structuredLyrics(artifact, song, enhanced).lyricsList.structuredLyrics;

test('enhanced lyrics retain UTF-8 byte slices for repeated words, spaces, CJK and emoji', async () => {
  const chunks = ['你', ' ', '你', ' & ', '눈', '😀', 'é'];
  const text = chunks.join('');
  const artifact = await make([{ time: 1, text, words: chunks.map((text, i) =>
    ({ text, startTime: 1 + i * 0.1, endTime: 1.1 + i * 0.1 })) }], { offsetMs: 500 });
  const [main] = layers(artifact);
  assert.equal(main.kind, 'main'); assert.equal(main.lang, 'ko');
  assert.equal(main.line[0].start, 1500); assert.equal(main.offset, 0);
  const [line] = main.cueLine;
  assert.equal(line.index, 0); assert.equal(line.value, text); assert.equal(line.start, 1500);
  assert.equal(line.end, 2200);
  const bytes = new TextEncoder().encode(text);
  let position = 0;
  for (const [i, cue] of line.cue.entries()) {
    assert.equal(cue.byteStart, position);
    assert.equal(new TextDecoder().decode(bytes.slice(cue.byteStart, cue.byteEnd + 1)), chunks[i]);
    assert.equal(cue.start, 1500 + i * 100); assert.equal(cue.end, 1600 + i * 100);
    position = cue.byteEnd + 1;
  }
  assert.equal(position, bytes.length);
});

test('default response is unchanged and negative offsets apply once to lines and words', async () => {
  const artifact = await make([{ time: 0.2, text: 'Hello', words: [
    { text: 'Hello', startTime: 0.2, endTime: 1 }], tlyric: '你好' }], { offsetMs: -500, targetLanguage: 'zh' });
  assert.deepEqual(layers(artifact, false), [{ displayArtist: song.artist, displayTitle: song.title,
    lang: 'und', synced: true, offset: 0, line: [{ value: 'Hello', start: 0 }] }]);
  const [main, translation] = layers(artifact);
  assert.deepEqual(main.cueLine[0].cue[0], { value: 'Hello', start: 0, end: 500, byteStart: 0, byteEnd: 4 });
  assert.equal(translation.line[0].start, 0); assert.equal(translation.cueLine, undefined);
});

test('partial translation is a separate language layer with original row timing and no fake word timing', async () => {
  const artifact = await make([
    { time: 1, text: 'A', tlyric: '' },
    { time: 2, text: 'B', tlyric: '乙', words: [{ text: 'B', startTime: 2, endTime: 3 }] },
    { time: 4, text: 'C', tlyric: '丙' },
  ], { targetLanguage: 'zh' });
  const [main, translation] = layers(artifact);
  assert.equal(main.cueLine[0].index, 1);
  assert.equal(translation.kind, 'translation'); assert.equal(translation.lang, 'zh');
  assert.deepEqual(translation.line, [{ value: '乙', start: 2000 }, { value: '丙', start: 4000 }]);
  assert.equal(translation.cueLine, undefined);
  assert.equal(JSON.stringify(layers(artifact)).includes('originalTextHash'), false);
});

test('missing, plain and mixed untimed lyrics downgrade without invented timestamps', async () => {
  assert.deepEqual(layers(null), []); assert.deepEqual(layers({ status: 'reset' }), []);
  const plain = await make([{ text: 'A', tlyric: '甲' }]);
  const [main, translation] = layers(plain);
  assert.equal(main.synced, false); assert.deepEqual(main.line, [{ value: 'A' }]);
  assert.equal(translation.lang, 'und'); assert.equal(translation.synced, false);
  const mixed = await make([{ text: 'Info' }, { time: 1, text: 'A', words:
    [{ text: 'A', startTime: 1, endTime: 2 }] }]);
  assert.equal(layers(mixed)[0].cueLine, undefined);
  assert.ok(layers(mixed)[0].line.every(line => !Object.hasOwn(line, 'start')));
});

test('translation languages use saved metadata or known legacy provider conventions', async () => {
  const artifact = await make([{ time: 1, text: 'A', tlyric: '甲' }]);
  for (const source of ['kugou', 'netease', 'ai']) {
    assert.equal(layers({ ...artifact, translation: { ...artifact.translation, source } })[1].lang, 'zh');
  }
  assert.equal(layers(artifact)[1].lang, 'und');
});

test('XML uses cueLine value attributes, cue text and existing line text with matching offsets', async () => {
  const artifact = await make([{ time: 1, text: '你 & "😀"', words:
    [{ text: '你 & "😀"', startTime: 1, endTime: 2 }] }]);
  const xml = await reply(structuredLyrics(artifact, song, true), 'xml').text();
  assert.match(xml, /<line start="1000">你 &amp; &quot;😀&quot;<\/line>/u);
  assert.match(xml, /<cueLine index="0" start="1000" end="2000" value="你 &amp; &quot;😀&quot;"><cue start="1000" end="2000" byteStart="0" byteEnd="11">你 &amp; &quot;😀&quot;<\/cue><\/cueLine>/u);
});

test('XML cueLine attributes preserve internal whitespace and exact UTF-8 word ranges', async () => {
  const chunks = ['你\n', 'é\t', '😀\n', 'B'];
  const text = chunks.join('');
  const artifact = await make([{ time: 1, text, words: chunks.map((text, i) =>
    ({ text, startTime: 1 + i, endTime: 2 + i })) }]);
  const payload = structuredLyrics(artifact, song, true);
  const json = (await reply(payload, 'json').json())['subsonic-response'];
  const line = json.lyricsList.structuredLyrics[0].cueLine[0];
  assert.equal(line.value, text);
  const bytes = new TextEncoder().encode(line.value);
  for (const [i, cue] of line.cue.entries()) {
    assert.equal(new TextDecoder().decode(bytes.slice(cue.byteStart, cue.byteEnd + 1)), chunks[i]);
  }
  const xml = await reply(payload, 'xml').text();
  assert.ok(xml.includes('value="你&#10;é&#9;😀&#10;B"'));
  assert.ok(xml.includes('>你\n</cue>'));
  assert.ok(xml.includes('>é\t</cue>'));
  assert.ok((await reply({ cueLine: { value: 'A\rB' } }, 'xml').text()).includes('value="A&#13;B"'));
});

test('authenticated HTTP opt-in returns stored word and translation layers while v1 and plain lyrics stay compatible', async t => {
  const f = await fixture(); t.after(f.close); await f.enable();
  f.sqlite.exec("UPDATE Songs SET language='ko' WHERE id='s1'");
  const artifact = await make([{ time: 1, text: '눈', tlyric: '眼睛', words:
    [{ text: '눈', startTime: 1, endTime: 2 }] }], { targetLanguage: 'zh' });
  f.objects.set('media/lyrics/s1.json', { bytes: new TextEncoder().encode(JSON.stringify(artifact)), type: 'application/json' });
  const read = async (method, params) => (await (await f.rest(method, params)).json())['subsonic-response'];
  const discovery = await read('getOpenSubsonicExtensions', { u: null, t: null, s: null });
  assert.deepEqual(discovery.openSubsonicExtensions, [{ name: 'songLyrics', versions: [1, 2] }]);
  const ordinary = await read('getLyricsBySongId', { id: 's1' });
  assert.deepEqual(await read('getLyricsBySongId', { id: 's1', enhanced: false }), ordinary);
  assert.deepEqual(ordinary.lyricsList.structuredLyrics, layers(artifact, false));
  assert.deepEqual((await read('getLyricsBySongId', { id: 's1', enhanced: true })).lyricsList.structuredLyrics, layers(artifact));
  assert.equal((await read('getLyrics', { title: song.title, artist: song.artist })).lyrics.value, '눈');
  assert.deepEqual((await read('getLyricsBySongId', { id: 's2', enhanced: true })).lyricsList.structuredLyrics, []);
  for (const enhanced of ['', '1', 'yes']) {
    const bad = await f.rest('getLyricsBySongId', { id: 's1', enhanced });
    assert.equal(bad.status, 200); assert.equal((await bad.json())['subsonic-response'].error.code, 10);
  }
  const reads = f.mediaReads();
  assert.equal((await read('getLyricsBySongId', { id: 's1', enhanced: true, t: 'bad' })).error.code, 40);
  assert.equal(f.mediaReads(), reads);
  const xml = await (await f.rest('getLyricsBySongId.view', { id: 's1', enhanced: true, f: 'xml' })).text();
  assert.match(xml, /kind="main"/); assert.match(xml, /kind="translation"/); assert.match(xml, /<cueLine/);
});
