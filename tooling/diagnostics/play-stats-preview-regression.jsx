import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import PlayStatsDetailView from '../../client/src/components/PlayStatsDetailView.jsx';
import { usePlayStatsStore, resetSyncBackoff } from '../../client/src/store/usePlayStatsStore.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, message) {
  for (let i = 0; i < 150; i++) { if (check()) return; await wait(20); }
  throw new Error(message);
}
function assert(ok, message) { if (!ok) throw new Error(message); }
const fixture = document.getElementById('fixture');
const root = createRoot(fixture);
const song = { id: 'fixture-song', title: 'Fixture Song', artist: 'Fixture Artist', play_count: 9 };
let remoteCount = 9;
let fail = false;
let finishSummary;
let holdSummary = false;
const reads = [];
globalThis.fetch = async (input, init) => {
  const url = new URL(input, location.origin);
  if (url.pathname !== '/api/account/play-stats' || init?.method !== 'GET') throw new Error(`Unexpected request ${input}`);
  const summary = url.searchParams.get('view') === 'summary';
  reads.push(summary ? 'summary' : 'full');
  if (summary && holdSummary) await new Promise((resolve) => { finishSummary = resolve; });
  if (fail) return Response.json({ ok: false, message: 'fixture failure' }, { status: 503 });
  return Response.json({ ok: true, data: { songs: [{ ...song, play_count: remoteCount }],
    ...(summary ? { view: 'summary' } : { playCounts: { [song.id]: remoteCount }, totalPlays: remoteCount, totalUniqueSongs: 1 }) } });
};
function render(detail) {
  flushSync(() => root.render(<React.StrictMode>{detail
    ? <PlayStatsDetailView onBack={() => render(false)} /> : <p>Home preview</p>}</React.StrictMode>));
}
function refreshButton() { return [...fixture.querySelectorAll('button')].find((button) => button.textContent.trim() === '刷新'); }
document.getElementById('run').onclick = async () => {
  document.getElementById('run').disabled = true;
  const report = document.getElementById('report');
  const results = [];
  const pass = (message) => { results.push(`PASS ${message}`); report.textContent = results.join('\n'); };
  try {
    const store = usePlayStatsStore.getState();
    store.setSubject(null);
    store.setSubject('preview-fixture');
    render(false);
    await store.synchronizeListeningPreview();
    render(false); render(false);
    assert(reads.join(',') === 'summary', 'home must not fetch complete counts');
    pass('home preview / rerenders: 1 summary, 0 full reads');
    render(true);
    await until(() => fixture.querySelectorAll('.track-row').length === 1, 'detail did not render');
    assert(reads.join(',') === 'summary,full', 'StrictMode duplicated detail read');
    assert(fixture.textContent.includes('9'), 'complete count missing');
    pass('detail entry: 1 full read, count 9 visible, StrictMode deduplicated');
    flushSync(() => store.recordQualifiedPlay(song));
    assert(fixture.textContent.includes('10'), 'local qualified play did not update count');
    assert(reads.length === 2, 'local play triggered extra read');
    pass('local qualified play: count 10 immediately, no extra GET');
    render(false);
    assert(!usePlayStatsStore.getState().detailViewActive, 'detail remains active after exit');
    await store.synchronizeListeningPreview();
    assert(reads.at(-1) === 'summary', 'home requested full data');
    assert(usePlayStatsStore.getState().getPlayCount(song.id) === 10, 'preview damaged ledger');
    pass('return home: summary only, detailed ledger preserved');
    render(true);
    await until(() => fixture.querySelectorAll('.track-row').length === 1, 'reentry did not render');
    remoteCount = 11;
    refreshButton().click();
    await until(() => fixture.querySelectorAll('.track-row').length === 1 && fixture.textContent.includes('12'), 'manual refresh did not reconcile');
    pass('manual refresh: cloud 11 + one unsent play = 12');
    fail = true;
    refreshButton().click();
    await until(() => fixture.querySelector('[role="alert"]'), 'failure missing');
    assert(!refreshButton().disabled, 'retry disabled after error');
    fail = false;
    refreshButton().click();
    await until(() => fixture.querySelectorAll('.track-row').length === 1, 'retry failed');
    pass('failed read: visible error and successful manual retry');
    render(false);
    holdSummary = true;
    const preview = store.synchronizeListeningPreview();
    await until(() => finishSummary, 'summary not started');
    const before = reads.length;
    render(true); render(false);
    finishSummary(); await preview; await wait(50);
    assert(reads.length === before, 'quickly closed detail still fetched complete ledger');
    pass('fast enter / exit during pending preview: no late full read');
    report.textContent += '\nALL 7 SCENARIOS PASSED';
  } catch (error) { report.textContent += `\nFAIL ${error.stack}`; }
  finally { resetSyncBackoff(); }
};
