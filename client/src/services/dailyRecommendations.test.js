import test from 'node:test';
import assert from 'node:assert/strict';
import { createDailyRecommendations, createDailyRecommendationPlaylist, normalizeDailySongs } from './dailyRecommendations.js';

const songs = (count = 20, prefix = 'a') => Array.from({ length: count }, (_, index) => ({
    id: `${prefix}${index}`, title: `${prefix}${index}`, audio_url: `/media/${prefix}${index}.mp3`, language: 'en',
}));
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
function fixture({ cached = null, request = async () => songs() } = {}) {
    let date = '2026-10-12';
    const writes = [], calls = [];
    const instance = createDailyRecommendations({ scope: 'instance/account', today: () => date,
        load: () => cached, save: (...args) => writes.push(args),
        request: args => { calls.push(args); return request(args); },
    });
    return { instance, writes, calls, nextDay: () => { date = '2026-10-13'; } };
}

test('first view fetches 20, ordinary returns retain the same batch, manual refresh prefers different songs', async () => {
    const s = fixture();
    await s.instance.ensureFresh();
    assert.equal(s.instance.getSnapshot().songs.length, 20);
    assert.equal(createDailyRecommendationPlaylist(s.instance.getSnapshot().songs).preloadedSongs.length, 20);
    await s.instance.ensureFresh();
    assert.equal(s.calls.length, 1);
    await s.instance.refresh();
    assert.deepEqual(s.calls[1].excludeIds, songs().map(song => song.id));
    assert.equal(s.writes.length, 2);
});

test('next local day updates once and failed refresh keeps the previous batch and date for retry', async () => {
    const response = deferred();
    const cached = { songs: songs(), date: '2026-10-12' };
    let attempt = 0;
    const s = fixture({ cached, request: () => ++attempt === 1 ? response.promise : songs(20, 'b') });
    await s.instance.ensureFresh();
    assert.equal(s.calls.length, 0);
    s.nextDay();
    const pending = s.instance.ensureFresh();
    assert.equal(s.instance.getSnapshot().songs, cached.songs);
    assert.equal(s.instance.getSnapshot().isLoading, false);
    assert.equal(s.instance.getSnapshot().isRefreshing, true);
    response.reject(new Error('offline'));
    assert.equal((await pending).ok, false);
    assert.equal(s.instance.getSnapshot().date, '2026-10-12');
    assert.equal(s.instance.getSnapshot().songs, cached.songs);
    assert.ok(s.instance.getSnapshot().error);
    assert.equal(s.writes.length, 0);
    await s.instance.ensureFresh();
    assert.equal(s.instance.getSnapshot().date, '2026-10-13');
    assert.equal(s.instance.getSnapshot().songs[0].id, 'b0');
});

test('concurrent automatic/manual refresh shares one request and unmount prevents late writes', async () => {
    const response = deferred();
    const s = fixture({ request: () => response.promise });
    const first = s.instance.ensureFresh();
    assert.equal(first, s.instance.refresh());
    await Promise.resolve();
    assert.equal(s.calls.length, 1);
    const signal = s.calls[0].signal;
    s.instance.dispose();
    assert.equal(signal.aborted, true);
    response.resolve(songs());
    assert.deepEqual(await first, { ok: false, stale: true });
    assert.equal(s.writes.length, 0);
});

test('a request finishing after midnight keeps its start day and must refresh on the next view', async () => {
    const response = deferred();
    let attempt = 0;
    const s = fixture({ request: () => ++attempt === 1 ? response.promise : songs(20, 'b') });
    const first = s.instance.ensureFresh();
    s.nextDay();
    response.resolve(songs());
    await first;
    assert.equal(s.instance.getSnapshot().date, '2026-10-12');
    await s.instance.ensureFresh();
    assert.equal(s.calls.length, 2);
    assert.equal(s.instance.getSnapshot().date, '2026-10-13');
});

test('small and empty playable libraries retain their actual count without duplicate padding', async () => {
    for (const count of [0, 3, 8, 19, 20]) {
        const s = fixture({ request: async () => songs(count) });
        await s.instance.ensureFresh();
        assert.equal(s.instance.getSnapshot().songs.length, count);
        await s.instance.ensureFresh();
        assert.equal(s.calls.length, 1);
    }
    assert.deepEqual(normalizeDailySongs([songs(1)[0], songs(1)[0], { ...songs(1)[0], id: 'silent', audio_url: '' }]), songs(1));
});

test('invalid metadata preserves usable cache and does not mark the new day successful', async () => {
    const s = fixture({ cached: { songs: songs(), date: '2026-10-12' },
        request: async () => [{ ...songs(1)[0], language: 'invalid' }] });
    s.nextDay();
    assert.equal((await s.instance.ensureFresh()).ok, false);
    assert.equal(s.instance.getSnapshot().songs.length, 20);
    assert.equal(s.writes.length, 0);
});
