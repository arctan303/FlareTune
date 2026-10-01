import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import SearchView from '../../client/src/components/SearchView.jsx';
import { useUIStore } from '../../client/src/store/useUIStore.js';
import { createSearchPageCache } from '../../client/src/utils/searchPageCache.js';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) { for (let i = 0; i < 150; i++) { if (check()) return; await wait(20); } throw Error(message); }
function assert(ok, message) { if (!ok) throw Error(message); }
const calls = [];
let fail = false;
globalThis.fetch = async input => {
  const url = new URL(input, location.origin);
  if (['/api/songs/search', '/api/artists', '/api/albums'].includes(url.pathname)) {
    calls.push({ path: url.pathname, q: url.searchParams.get('q'), language: url.searchParams.get('language') });
    if (fail) return Response.json({ code: 503 }, { status: 503 });
    const songs = Array.from({ length: 3 }, (_, i) => ({ id: `${url.searchParams.get('q')}-${i}`, title: `${url.searchParams.get('q')} ${i}`, artist: 'Fixture', audio_url: '/audio', language: 'en' }));
    return Response.json({ code: 200, data: { songs, artists: [], albums: [], total: 0, hasMore: false } });
  }
  return Response.json({ data: { playlists: [], photos: [] } });
};
useUIStore.setState({ authSession: { authenticated: true, user: { accountId: 'fixture' }, csrfToken: 'fixture' } });
const root = createRoot(document.getElementById('fixture'));
const cache = createSearchPageCache();
let route = { query: '', view: 'overview', language: 'all' };
function render(visible = true) { flushSync(() => root.render(visible ? <SearchView route={route} cache={cache} /> : null)); }
function draft(value) {
  const input = document.querySelector('input[aria-label="搜索曲库"]');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
  flushSync(() => input.dispatchEvent(new Event('input', { bubbles: true })));
  return input;
}
function enter(input, composing = false) { flushSync(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: composing }))); }
function submit() { document.querySelector('button[type="submit"]').click(); }
document.getElementById('run').onclick = async () => {
  document.getElementById('run').disabled = true;
  const report = document.getElementById('report'); const results = [];
  const pass = message => { results.push(`PASS ${message}`); report.textContent = results.join('\n'); };
  try {
    render(); draft('First'); await wait(900);
    assert(calls.length === 0 && !location.search.includes('First'), 'draft caused search or URL change');
    pass('typing and pause do not query or change URL');
    enter(document.querySelector('input'));
    await until(() => calls.length === 3 && document.querySelector('.track-row'), 'Enter did not load three categories');
    assert(calls.every(call => call.q === 'First'), 'wrong submitted query');
    pass('Enter loads songs, artists and albums for submitted query');
    draft('Draft'); await wait(900);
    assert(calls.length === 3 && location.search.includes('First') && !location.search.includes('Draft'), 'unsubmitted edit changed results');
    submit(); await until(() => calls.length === 6 && document.querySelector('.track-row')?.textContent.includes('Draft'), 'button submission failed');
    pass('button commits draft; unsubmitted edits preserve old results');
    let input = draft('中文');
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    enter(input, true); await wait(60);
    assert(calls.length === 6, 'IME Enter searched');
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' }));
    enter(input); await until(() => calls.length === 9 && document.querySelector('.track-row')?.textContent.includes('中文'), 'IME completion not searchable');
    pass('IME confirmation does not search; following Enter does');
    submit(); await until(() => calls.length === 12 && document.querySelector('.track-row'), 'same query did not refresh all categories');
    pass('resubmitting same query refreshes all three categories');
    route = { ...route, query: '中文' }; render(false); render(); await wait(100);
    assert(calls.length === 12, 'return to submitted query reloaded');
    pass('unmount and return reuse submitted results');
    fail = true; draft('Failure'); submit();
    await until(() => document.body.textContent.includes('搜索失败'), 'failure state absent');
    fail = false; submit(); await until(() => document.querySelector('.track-row')?.textContent.includes('Failure'), 'same query retry failed');
    pass('failed search can retry using same submit button');
    document.querySelector('[aria-label="清空搜索"]').click(); await wait(60);
    const before = calls.length; enter(document.querySelector('input')); await wait(60);
    assert(calls.length === before && !location.search.includes('Failure'), 'clearing or empty Enter fetched');
    pass('clear resets submitted state; empty Enter does not query');
    report.textContent += '\nALL 8 SCENARIOS PASSED';
  } catch (error) { report.textContent += '\nFAIL ' + error.stack; }
};
