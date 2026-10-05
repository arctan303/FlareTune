import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { hookComponent, deferred, flushAsync, nodes, text, button } from '../test/lyricCandidateHarness.js';
import * as state from './LyricsManagementWorkspace.state.js';

const song = { id: 's1', title: 'Night Song', artist: 'Singer' };
const candidate = (index, source = 'kugou') => ({ source, providerLyricId: `${source}-${index}`,
  matchedTitle: song.title, matchedArtist: song.artist, score: 200 - index, durationDelta: 0 });
const ready = (item, mode = 'line', translated = false) => ({ ...item, state: 'ready', syncMode: mode,
  translationAvailable: translated, lyrics: { lines: [{ time: 1, text: 'Hello' }] } });
const translate = (value, values) => value.replace(/\{(\w+)\}/g, (_, key) => String(values?.[key] ?? `{${key}}`));
function setup(api, songValue = song) {
  const imports = [];
  const component = hookComponent({ file: fileURLToPath(new URL('./LyricsCandidatePanel.jsx', import.meta.url)),
    modules: { 'lucide-react': { Loader2: 'Loader2', Search: 'Search' },
      '../i18n/index.js': { t: translate }, './SelectControl.jsx': 'SelectControl',
      '../services/localLyricsWorkspaceApi.js': { lyricsWorkspaceApi: api },
      './LyricsManagementWorkspace.state.js': state }, globals: { AbortController } });
  const props = { song: songValue, authenticated: true, isAdmin: true, saving: false, active: true,
    Preview: 'Preview', onImport: inspection => imports.push(inspection) };
  return { component, props, imports, render: () => component.render(props) };
}
const cards = tree => nodes(tree).filter(node => node.type === 'button' && node.props.className?.startsWith('lyric-studio__candidate'));
const filter = (tree, label, value) => nodes(tree).find(node => node.type === 'SelectControl' && node.props['aria-label'] === label)
  .props.onChange({ target: { value } });
async function settle(subject) { subject.render(); await flushAsync(); subject.render(); await flushAsync(); return subject.render(); }
async function search(subject) {
  nodes(subject.render()).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  return settle(subject);
}

test('all candidate summaries remain reachable while default inspection reads only four nearby bodies', async () => {
  const all = [...Array.from({ length: 12 }, (_, i) => candidate(i)), candidate(13, 'netease')];
  const inspections = [];
  const s = setup({ getLyricsCandidates: async () => ({ data: { candidates: all } }),
    inspectLyricsCandidates: async (_, items) => { inspections.push(items); return { data: { results: items.map(item => ready(item)) } }; } });
  const tree = await search(s);
  assert.equal(cards(tree).length, 13);
  assert.ok(text(cards(tree).at(-1)).includes('网易云'));
  assert.deepEqual(inspections.map(items => items.length), [4]);
  s.component.unmount();
});

test('unsubmitted field edits do not change an in-flight inspection query or discard its response', async () => {
  const pending = deferred(); const calls = [];
  const s = setup({ getLyricsCandidates: async () => ({ data: { candidates: [candidate(1)] } }),
    inspectLyricsCandidates: async (_, items, options) => { calls.push({ items, options }); return pending.promise; } });
  let tree = await search(s);
  nodes(tree).filter(node => node.type === 'input')[1].props.onChange({ target: { value: 'unsubmitted artist' } });
  s.render();
  pending.resolve({ data: { results: [ready(candidate(1))] } });
  tree = await settle(s);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.artist, song.artist);
  assert.equal(calls[0].options.signal.aborted, false);
  assert.ok(text(tree).includes('逐行'));
  button(tree, '导入当前歌词草稿').props.onClick();
  assert.equal(s.imports.length, 1);
  assert.equal(s.imports[0].state, 'ready');
  s.component.unmount();
});

test('source selection restarts actual search using the submitted query and ignores an older response', async () => {
  const pending = deferred(); const calls = [];
  const s = setup({ getLyricsCandidates: async (_, options) => {
    calls.push(options); return calls.length === 1 ? pending.promise : { data: { candidates: [candidate(1, 'netease')] } };
  }, inspectLyricsCandidates: async (_, items) => ({ data: { results: items.map(item => ready(item)) } }) });
  let tree = await search(s);
  nodes(tree).filter(node => node.type === 'input')[0].props.onChange({ target: { value: 'unsubmitted title' } });
  tree = s.render(); filter(tree, '歌词来源', 'netease'); tree = await settle(s);
  pending.resolve({ data: { candidates: [candidate(2)] } }); tree = await settle(s);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(calls[1].title, song.title);
  assert.equal(calls[1].source, 'netease');
  assert.equal(cards(tree).length, 1);
  assert.ok(text(cards(tree)[0]).includes('网易云'));
  s.component.unmount();
});

test('type filtering distinguishes unknown results and checks bounded batches only when continued', async () => {
  const all = Array.from({ length: 13 }, (_, i) => candidate(i)); const calls = [];
  const s = setup({ getLyricsCandidates: async () => ({ data: { candidates: all } }),
    inspectLyricsCandidates: async (_, items) => {
      calls.push(items); return { data: { results: items.map(item => ready(item, item.providerLyricId === 'kugou-12' ? 'word' : 'line')) } };
    } });
  let tree = await search(s);
  filter(tree, '同步类型', 'word'); tree = await settle(s);
  assert.deepEqual(calls.map(items => items.length), [4, 4]);
  assert.equal(cards(tree).length, 0);
  assert.ok(text(tree).includes('尚无已确认的匹配'));
  assert.ok(text(tree).includes('还有 5 份候选未检查'));
  button(tree, '继续检查').props.onClick(); tree = await settle(s);
  button(tree, '继续检查').props.onClick(); tree = await settle(s);
  assert.deepEqual(calls.map(items => items.length), [4, 4, 4, 1]);
  assert.equal(cards(tree).length, 1);
  assert.ok(text(cards(tree)[0]).includes('逐字'));
  assert.equal(text(tree).includes('继续检查'), false);
  s.component.unmount();
});

test('a failed preview can be explicitly retried and errors are not treated as absent lyrics', async () => {
  let attempts = 0;
  const s = setup({ getLyricsCandidates: async () => ({ data: { candidates: [candidate(1)] } }),
    inspectLyricsCandidates: async (_, items) => {
      attempts += 1; if (attempts === 1) throw Error('temporary');
      return { data: { results: items.map(item => ready(item, 'word')) } };
    } });
  let tree = await search(s);
  assert.ok(text(tree).includes('候选预览失败。'));
  button(tree, '重试预览').props.onClick(); tree = await settle(s);
  assert.equal(attempts, 2);
  assert.ok(text(tree).includes('逐字'));
  assert.equal(button(tree, '导入当前歌词草稿').props.disabled, false);
  s.component.unmount();
});

test('switching songs unmounts and aborts old search without leaving the new song busy', async () => {
  const pending = deferred(); let signal;
  const old = setup({ getLyricsCandidates: async (_, options) => { signal = options.signal; return pending.promise; } });
  await search(old); old.component.unmount();
  const fresh = setup({ getLyricsCandidates: async () => ({ data: { candidates: [] } }) }, { ...song, id: 's2' });
  pending.resolve({ data: { candidates: [candidate(1)] } }); await flushAsync();
  assert.equal(signal.aborted, true);
  assert.equal(button(fresh.render(), '查找候选').props.disabled, false);
  assert.equal(cards(fresh.render()).length, 0);
  fresh.component.unmount();
});

test('filter changes cancel stale inspection results and keep the new filter progress authoritative', async () => {
  const first = deferred(); const calls = [];
  const s = setup({ getLyricsCandidates: async () => ({ data: { candidates: [candidate(1)] } }),
    inspectLyricsCandidates: async (_, items, options) => {
      calls.push(options); return calls.length === 1 ? first.promise : { data: { results: items.map(item => ready(item, 'word', true)) } };
    } });
  let tree = await search(s); filter(tree, '译文', 'yes'); tree = await settle(s);
  first.resolve({ data: { results: [ready(candidate(1), 'line', false)] } }); tree = await settle(s);
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(cards(tree).length, 1);
  assert.ok(text(cards(tree)[0]).includes('有翻译'));
  s.component.unmount();
});

test('match reliability and metadata outrank precision; unknown candidates remain discoverable', () => {
  const exact = { ...candidate(1), providerLyricId: 'exact', score: 170 };
  const wrong = { ...candidate(2), providerLyricId: 'wrong', score: 180, versionMismatch: true };
  const short = { ...candidate(3), providerLyricId: 'short', score: 190, durationDelta: 60 };
  const unknown = { ...candidate(4), providerLyricId: 'unknown', score: 175 };
  const inspections = { 'kugou:exact': ready(exact), 'kugou:wrong': ready(wrong, 'word'), 'kugou:short': ready(short, 'word') };
  assert.deepEqual(state.sortLyricsCandidates([wrong, short, exact, unknown], inspections).map(item => item.providerLyricId), ['unknown', 'exact', 'short', 'wrong']);
  assert.deepEqual(state.filterLyricsCandidates([exact, wrong, unknown], inspections, 'word', 'no'), [wrong]);
  assert.deepEqual(state.filterLyricsCandidates([exact, wrong, unknown], inspections, 'line', 'no'), [exact]);
  assert.deepEqual(state.filterLyricsCandidates([exact, wrong, unknown], inspections, 'all', 'yes'), []);
});
