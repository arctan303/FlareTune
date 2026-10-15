import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { formatAssistantToolText, formatAssistantToolEntry } from './assistantToolText.js';
import { getLocale, setUiLanguage, t } from './i18n/index.js';
import { appendToolProcessEntry, finishToolProcessEntry, getAssistantProcessTimeline } from '../../shared/assistantProcessTrace.js';
import { getToolProgressText } from '../../server/src/tools/index.js';
import { currentTimeTool } from '../../server/src/tools/currentTime.js';
import { getCurrentPlaybackTool } from '../../server/src/tools/getCurrentPlayback.js';
import { localPersonalPlaylistsTool } from '../../server/src/tools/localPersonalPlaylists.js';
import { localListeningStatsTool } from '../../server/src/tools/localListeningStats.js';
import { musicQueryTool } from '../../server/src/tools/musicQuery.js';
import { playerSeekTool } from '../../server/src/tools/playerSeek.js';
import { roamControlTool } from '../../server/src/tools/roamControl.js';
import { playerQueueTool } from '../../server/src/tools/playerQueue.js';
import { musicControlTool } from '../../server/src/tools/musicControl.js';
import { songDetailsTool } from '../../server/src/tools/songDetails.js';

function fixture() {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(readFileSync(new URL('../../server/db/migrations-flaretune/0001_baseline.sql', import.meta.url), 'utf8'));
    sqlite.exec(`
        INSERT INTO accounts(account_id,username,role,created_at,updated_at) VALUES ('account','listener','member',1,1);
        INSERT INTO Songs(id,title,artist,audio_url,language) VALUES ('song','晴天','周杰伦','audio/song.mp3','zh');
        INSERT INTO Member_Playlists(id,account_id,kind,name,revision,created_at,updated_at)
            VALUES ('playlist','account','regular','中文歌单',1,1,1);
        INSERT INTO Member_Playlist_Songs(playlist_id,song_id,sort_order,added_at) VALUES ('playlist','song',0,1);
        INSERT INTO Member_Song_Plays(account_id,song_id,play_count,last_played_at) VALUES ('account','song',3,1);
    `);
    const db = { prepare(sql) {
        const statement = sqlite.prepare(sql);
        const bound = values => ({ all: async () => ({ results: statement.all(...values) }),
            first: async () => statement.get(...values) ?? null });
        return { bind: (...values) => bound(values), ...bound([]) };
    } };
    return { sqlite, db };
}

test('actual tool summaries localize after live events and old history in all five languages', async () => {
    const { sqlite, db } = fixture();
    try {
        const context = { db, accountId: 'account' };
        const results = await Promise.all([
            currentTimeTool.execute({ timezone: 'Asia/Singapore' }, { now: new Date('2026-10-15T00:00:00Z') }),
            localPersonalPlaylistsTool.execute({ action: 'list' }, context),
            localPersonalPlaylistsTool.execute({ action: 'read', playlist_id: 'playlist' }, context),
            localListeningStatsTool.execute({}, context),
            musicQueryTool.execute({ action: 'search', keyword: '晴天' }, context),
            musicQueryTool.execute({ action: 'random' }, context),
            getCurrentPlaybackTool.execute({}, { currentSong: { title: '晴天', artist: '周杰伦' },
                playbackState: { isPlaying: false, isBuffering: true, progress: 50, duration: 200 } }),
            playerSeekTool.execute({ position: 30 }),
            playerSeekTool.execute({ mode: 'percent', position: 50 }),
            roamControlTool.execute({ action: 'enable', language: 'zh' }),
            roamControlTool.execute({ action: 'disable' }),
            playerQueueTool.execute({ action: 'append', song_ids: ['song'] }, context),
            playerQueueTool.execute({ action: 'insert_next', song_ids: ['song'] }, context),
            playerQueueTool.execute({ action: 'replace', song_ids: ['song'] }, context),
            musicControlTool.execute({ action: 'play_song', song_id: 'song' }, context),
            musicControlTool.execute({ action: 'pause' }, context),
            songDetailsTool.execute({ song_id: 'song' }, context),
        ]);
        assert.ok(results.every(result => result.eventData.ok), 'fixtures must execute the success paths');
        const original = JSON.stringify(results);
        const live = { processEntries: results.reduce((entries, result, index) => finishToolProcessEntry(
            appendToolProcessEntry(entries, { id: String(index), name: 'tool', progress: '我去确认一下。' }),
            { id: String(index), summary: result.summary, ok: true }), []) };
        const history = { toolSummaries: results.map((result, index) => ({ id: String(index), summary: result.summary })) };
        for (const locale of ['zh', 'zh-Hant', 'en', 'ja', 'ko']) {
            await setUiLanguage(locale);
            const actual = getAssistantProcessTimeline(live).map(formatAssistantToolEntry);
            assert.deepEqual(actual, getAssistantProcessTimeline(history).map(formatAssistantToolEntry), locale);
            if (locale === 'zh') assert.deepEqual(actual, results.map(result => result.summary));
            else for (let index = 0; index < actual.length; index += 1) {
                assert.notEqual(actual[index], results[index].summary, `${locale}: ${results[index].summary}`);
                assert.doesNotMatch(actual[index], /\{(?:count|title|name|target|state|progress)\}/, locale);
            }
            assert.ok(actual[2].includes('中文歌单'), locale);
            assert.ok(actual[4].includes('晴天'), locale);
            assert.ok(actual[6].includes('晴天') && actual[6].includes('周杰伦'), locale);
            assert.ok(actual[6].includes('50') && actual[6].includes('200') && actual[6].includes('25%'), locale);
            if (locale === 'en') {
                assert.equal(actual[0], 'Checking the current time in Asia/Singapore');
                assert.equal(actual[1], 'Loaded 1 personal playlist');
                assert.equal(actual[4], 'Found 1 song for “晴天”');
                assert.equal(actual[7], 'Player instruction prepared: Seek to 30 seconds');
                assert.equal(actual[11], 'Player instruction prepared: Add 1 song to the queue');
            }
        }
        assert.equal(JSON.stringify(results), original, 'localization never rewrites model/SSE tool results');
    } finally { sqlite.close(); await setUiLanguage('en'); }
});

test('every current deterministic progress variant has a localized path and keeps display targets', async () => {
    const calls = [
        ['music_query', { keyword: '晴天' }], ['music_query', {}],
        ['music_control', { action: 'play_song', song_name: '晴天' }],
        ['music_control', { action: 'pause' }], ['current_time', {}],
        ['manage_playlist', { action: 'list' }], ['manage_playlist', { action: 'create', name: '中文歌单' }],
        ['manage_playlist', { action: 'update_metadata' }], ['player_queue', {}], ['player_seek', {}],
        ['my_listening_stats', {}], ['my_playlists', {}], ['song_details', {}],
        ['roam_control', { action: 'disable' }], ['roam_control', { action: 'enable' }], ['remember_user', {}],
    ];
    const messages = calls.flatMap(([name, args]) => Array.from({ length: 20 }, (_, index) =>
        getToolProgressText(name, args, String(index))));
    for (const locale of ['zh', 'zh-Hant', 'en', 'ja', 'ko']) {
        await setUiLanguage(locale);
        for (const source of new Set(messages)) {
            const result = formatAssistantToolEntry({ progress: source });
            if (locale === 'zh') assert.equal(result, source);
            else assert.notEqual(result, source, `${locale}: ${source}`);
            if (source.includes('晴天')) assert.ok(result.includes('晴天'), locale);
            if (source.includes('中文歌单')) assert.ok(result.includes('中文歌单'), locale);
        }
    }
    await setUiLanguage('en');
});

test('legacy dynamic summaries preserve arbitrary values and use native English plurals', async () => {
    await setUiLanguage('en');
    assert.equal(formatAssistantToolText('搜索「中文查找词」找到 0 首歌曲'), 'Found 0 songs for “中文查找词”');
    assert.equal(formatAssistantToolText('查询到 2 首歌曲'), 'Found 2 songs');
    assert.equal(formatAssistantToolText('已查询 1 条记忆'), 'Loaded 1 memory');
    assert.equal(formatAssistantToolText('已查询 2 条记忆'), 'Loaded 2 memories');
    assert.equal(formatAssistantToolText('播放器指令已生成：跳转播放进度至 1 秒'), 'Player instruction prepared: Seek to 1 second');
    assert.equal(formatAssistantToolText('播放器指令已生成：跳转播放进度至 2 秒'), 'Player instruction prepared: Seek to 2 seconds');
    assert.equal(formatAssistantToolText('读取了《歌曲《引用》》资料与 2 行歌词'), 'Loaded details and 2 lyric lines for “歌曲《引用》”');
    assert.equal(formatAssistantToolText('等待确认删除歌单《登录》'), 'Waiting for confirmation to delete playlist “登录”');
    assert.equal(formatAssistantToolText('播放器指令已生成：播放《登录》'), 'Player instruction prepared: Play “登录”');
    assert.equal(formatAssistantToolText('歌名「登录」对应多首歌曲，请使用歌曲 ID。'), 'Multiple songs are named “登录”. Use the song ID.');
    assert.equal(formatAssistantToolText('自定义工具历史内容：登录'), '自定义工具历史内容：登录');
    assert.equal(formatAssistantToolText('前缀查询到 2 首歌曲'), '前缀查询到 2 首歌曲');
    assert.equal(formatAssistantToolEntry({}), t('已调用'));
    assert.equal(getLocale(), 'en');
});
