import catalog from './catalog.json' with { type: 'json' };
import { isUiLanguage } from '../shared/uiLanguages.js';
export const DEMO_KEY = 'flaretune-demo:v1';
export const DEMO_ACCOUNT = 'browser-demo';
export const songs = Object.freeze(catalog);
const byId = new Map(songs.map(song => [song.id, song]));
const initial = () => ({ version: 1, revision: 1, uiLanguage: 'auto', stats: [],
  playlists: [
    { id: 'fav_demo', kind: 'favorite', name: '我的收藏', songIds: [], revision: 1, description: '' },
    { id: 'demo-picks', kind: 'regular', name: 'Open Music · Demo', songIds: songs.map(song => song.id), revision: 1,
      description: 'Open music · Kevin MacLeod & Rocks From The Garden. This playlist is editable in your browser.' },
  ], shelf: { revision: 1, items: [{ kind: 'member', id: 'fav_demo' }, { kind: 'member', id: 'demo-picks' }] } });
export function createDemoData({ storage = () => globalThis.localStorage, random = Math.random, now = Date.now } = {}) {
  let memory = initial(), temporary = false;
  const listeners = new Set();
  const markTemporary = () => { if (!temporary) { temporary = true; for (const listener of listeners) listener(); } };
  const read = () => {
    if (temporary) return memory;
    try {
      const target = storage();
      if (!target) markTemporary();
      const value = JSON.parse(target?.getItem(DEMO_KEY) || 'null');
      if (!value && target) memory = initial();
      if (value?.version === 1 && Array.isArray(value.playlists)) {
        const seen = new Set(['fav_demo']);
        const valid = p => p && typeof p.id === 'string' && typeof p.name === 'string' && Array.isArray(p.songIds);
        const clean = p => ({ id: p.id, name: p.name.slice(0,80), description: String(p.description || '').slice(0,1000),
          kind: p.id === 'fav_demo' ? 'favorite' : 'regular', revision: Number.isSafeInteger(p.revision) && p.revision > 0 ? p.revision : 1,
          createdAt: Number(p.createdAt) || 0, songIds: [...new Set(p.songIds.filter(id => byId.has(id)))].slice(0,500) });
        const favorite = value.playlists.find(p => valid(p) && p.id === 'fav_demo') || initial().playlists[0];
        const playlists = [clean(favorite), ...value.playlists.filter(p => {
          if (!valid(p) || seen.has(p.id) || p.kind !== 'regular') return false;
          seen.add(p.id); return true;
        }).slice(0,99).map(clean)];
        const ids = new Set(playlists.map(p => p.id));
        const shelfIds = [...new Set((Array.isArray(value.shelf?.items) ? value.shelf.items : []).map(p => p?.id))].filter(id => ids.has(id));
        for (const id of ids) if (!shelfIds.includes(id)) shelfIds.push(id);
        memory = { ...initial(), ...value, uiLanguage: isUiLanguage(value.uiLanguage) ? value.uiLanguage : 'auto',
          stats: Array.isArray(value.stats) ? value.stats.filter(e => e && byId.has(e.song_id) && typeof e.event_id === 'string').slice(-1000) : [],
          playlists, shelf: { revision: Number.isSafeInteger(value.shelf?.revision) && value.shelf.revision > 0 ? value.shelf.revision : 1,
            items: shelfIds.map(id => ({ kind: 'member', id })) } };
      }
    } catch { markTemporary(); }
    return memory;
  };
  const write = state => {
    memory = { ...state, revision: Number(state.revision || 0) + 1 };
    try { const target = storage(); if (!target) markTemporary(); else target.setItem(DEMO_KEY, JSON.stringify(memory)); } catch { markTemporary(); }
  };
  const detail = p => ({ ...p, ownerAccountId: DEMO_ACCOUNT, createdAt: p.createdAt || 0,
    songCount: p.songIds.length, songs: p.songIds.map(id => byId.get(id)),
    previewCovers: p.songIds.slice(0,4).map(id => byId.get(id)?.cover_url), cover_url: byId.get(p.songIds[0])?.cover_url });
  const lists = state => state.playlists.map(detail);
  const result = (data, status = 200, error) => new Response(JSON.stringify({ code: status, ok: status < 400, data,
    ...(error ? { error, message: error === 'DEMO_READ_ONLY' ? '演示模式下此功能只读。' : error } : {}) }),
    { status, headers: { 'Content-Type': 'application/json' } });
  const slice = (items, params) => {
    const limit = Math.max(1, Math.min(100, Number(params.get('limit')) || 20));
    const offset = Math.max(0, Number(params.get('offset')) || ((Number(params.get('page')) || 1) - 1) * limit);
    return { items: items.slice(offset, offset + limit), total: items.length, hasMore: offset + limit < items.length };
  };
  const filter = (params) => songs.filter(song => {
    const language = params.get('language'), query = (params.get('q') || '').toLocaleLowerCase(), artist = params.get('artist');
    return (!language || language === 'all' || language.split(',').includes(song.language))
      && (!artist || artist === song.artist) && [song.title, song.artist, song.album].some(text => text.toLocaleLowerCase().includes(query));
  });
  const albums = [...new Set(songs.map(s => s.album_id))].map(id => {
    const tracks = songs.filter(s => s.album_id === id), first = tracks[0];
    return { id, title: first.album, name: first.album, artist: first.artist, coverUrl: first.cover_url,
      cover_url: first.cover_url, songCount: tracks.length, songs: tracks };
  });
  const artists = [...new Set(songs.map(s => s.artist))].map(name => ({ name,
    songCount: songs.filter(s => s.artist === name).length, coverUrl: songs.find(s => s.artist === name).cover_url }));
  const handle = async (input, init = {}) => {
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const url = new URL(typeof input === 'string' ? input : input.url, 'https://demo.invalid');
    const path = url.pathname, method = (init.method || 'GET').toUpperCase(), params = url.searchParams;
    const state = read();
    if (path === '/api/auth/session' && method === 'GET') return new Response(JSON.stringify({
      authenticated: true, mustChangePassword: false, csrfToken: 'local-demo',
      user: { accountId: DEMO_ACCOUNT, username: 'demo', displayName: 'Demo', role: 'member', uiLanguage: state.uiLanguage },
    }), { headers: { 'Content-Type': 'application/json' } });
    let body = {};
    try { if (init.body) body = JSON.parse(init.body); } catch { return result(null, 400, 'INVALID_JSON'); }
    const commit = data => { write(state); return result(data); };
    if (path === '/api/account/ui-language' && method === 'PATCH') {
      if (!isUiLanguage(body.uiLanguage)) return result(null, 400, 'INVALID_LANGUAGE');
      state.uiLanguage = body.uiLanguage; return commit({ uiLanguage: body.uiLanguage });
    }
    if (path === '/api/init' && method === 'GET') return result({ default_playlist: detail(state.playlists[0]), other_playlists: lists(state).slice(1) });
    if (path === '/api/songs/roam' && method === 'POST') {
      const selected = songs.filter(s => !body.language || body.language === 'all' || String(body.language).split(',').includes(s.language));
      const queued = new Set(body.queuedSongIds || []), recent = new Set(body.recentSongIds || []);
      const pool = selected.filter(s => !queued.has(s.id)).map(song => ({ song, order: random() })).sort((a,b) => a.order-b.order).map(s => s.song);
      const ordered = [...pool.filter(s => !recent.has(s.id)), ...pool.filter(s => recent.has(s.id))];
      const batch = ordered.slice(0, Math.max(1, Math.min(20, Number(body.limit) || 10)));
      return result({ songs: batch, totalPlayable: selected.length, remainingPlayable: Math.max(0,pool.length-batch.length),
        exhausted: pool.length <= batch.length, strategy: 'recent', recentWindow: Math.ceil(selected.length * .2) });
    }
    if (['/api/songs/random','/api/songs/roam'].includes(path) && method === 'GET') {
      const excluded = new Set((params.get('exclude') || params.get('excludeIds') || '').split(','));
      const pool = filter(params).map(song => ({ song, order: random() })).sort((a,b) => a.order - b.order).map(item => item.song);
      const unique = [...pool.filter(s => !excluded.has(s.id)), ...pool.filter(s => excluded.has(s.id))];
      return result({ songs: unique.slice(0, Math.max(1, Math.min(20, Number(params.get('limit')) || 20))) });
    }
    if (path === '/api/songs/resolve' && method === 'POST') {
      const ids = Array.isArray(body.song_ids) ? body.song_ids : [];
      return result({ songs: ids.map(id => byId.get(id)).filter(Boolean), missing_ids: ids.filter(id => !byId.has(id)) });
    }
    if (path === '/api/songs' && params.get('counts') === 'language' && method === 'GET') {
      return result(Object.fromEntries(['zh','en','ja','ko','instrumental','other'].map(lang => [lang, songs.filter(s => s.language === lang).length])));
    }
    if (['/api/songs','/api/songs/search'].includes(path) && method === 'GET') {
      const page = slice(filter(params), params); return result({ ...page, songs: page.items });
    }
    if (/^\/api\/songs\/[^/]+$/.test(path) && method === 'GET') {
      const song = byId.get(decodeURIComponent(path.split('/').at(-1))); return song ? result(song) : result(null,404,'SONG_NOT_FOUND');
    }
    if (path === '/api/artists' && method === 'GET') {
      const names = new Set(filter(params).map(s => s.artist)), page = slice(artists.filter(a => names.has(a.name)), params);
      return result({ ...page, artists: page.items });
    }
    if (path.startsWith('/api/artists/') && method === 'GET') {
      const name = decodeURIComponent(path.slice('/api/artists/'.length)), tracks = songs.filter(s => s.artist === name), page = slice(tracks, params);
      return result({ name, songs: page.items, total: tracks.length, songCount: tracks.length, hasMore: page.hasMore,
        albums: albums.filter(a => a.artist === name), coverUrl: tracks[0]?.cover_url });
    }
    if (path === '/api/albums' && method === 'GET') {
      const ids = new Set(filter(params).map(s => s.album_id)), page = slice(albums.filter(a => ids.has(a.id)), params);
      return result({ ...page, albums: page.items });
    }
    if (path.startsWith('/api/albums/') && method === 'GET') {
      const album = albums.find(a => a.id === decodeURIComponent(path.split('/').at(-1)));
      return album ? result(album) : result(null,404,'ALBUM_NOT_FOUND');
    }
    if (path === '/api/artist-photo' && method === 'GET') return result({ photos: [], photoUrl: null });
    if (path === '/api/account/playlists') {
      if (method === 'GET') return result({ playlists: lists(state) });
      if (method === 'POST') {
        const name = String(body.name || '').trim();
        if (!name || name.length > 80 || state.playlists.length >= 100) return result(null,400,'INVALID_PLAYLIST');
        const playlist = { id: `local-${crypto.randomUUID()}`, name, description: String(body.description || '').slice(0,1000),
          kind: 'regular', songIds: [], revision: 1, createdAt: now() };
        state.playlists.push(playlist); state.shelf.items.push({ kind: 'member', id: playlist.id }); state.shelf.revision++;
        return commit({ playlist: detail(playlist), shelf: state.shelf });
      }
    }
    if (path === '/api/account/playlist-shelf') {
      if (method === 'GET') return result({ shelf: state.shelf });
      if (method === 'PUT') {
        if (body.expectedRevision !== state.shelf.revision) return result(null,409,'REVISION_CONFLICT');
        const ids = Array.isArray(body.items) ? body.items.map(p => p.id) : null;
        if (!ids || ids.length !== state.playlists.length || new Set(ids).size !== state.playlists.length || ids.some(id => !state.playlists.some(p => p.id === id))) return result(null,400,'INVALID_ORDER');
        state.shelf = { revision: state.shelf.revision + 1, items: ids.map(id => ({ kind: 'member', id })) };
        return commit({ shelf: state.shelf });
      }
    }
    if (path === '/api/account/playlist-songs' && method === 'POST') {
      const targets = Array.isArray(body.targets) ? body.targets : [], ids = Array.isArray(body.songIds) ? body.songIds : [];
      if (ids.some(id => !byId.has(id))) return result(null,404,'SONG_NOT_FOUND');
      for (const target of targets) {
        const p = state.playlists.find(p => p.id === target.playlistId);
        if (!p) return result(null,404,'PLAYLIST_NOT_FOUND');
        if (p.revision !== target.expectedRevision) return result(null,409,'REVISION_CONFLICT');
      }
      for (const target of targets) { const p = state.playlists.find(p => p.id === target.playlistId); p.songIds = [...new Set([...p.songIds,...ids])].slice(0,500); p.revision++; }
      return commit({ outcome: 'completed', results: targets.map(target => ({ playlistId: target.playlistId, outcome: 'completed', added: ids.length })) });
    }
    const playlistPath = path.match(/^\/api\/account\/playlists\/([^/]+)(?:\/songs(?:\/([^/]+))?)?$/);
    if (playlistPath) {
      const p = state.playlists.find(p => p.id === decodeURIComponent(playlistPath[1]));
      if (!p) return result(null,404,'PLAYLIST_NOT_FOUND');
      if (method === 'GET') return result({ playlist: detail(p) });
      if (body.expectedRevision !== p.revision) return result(null,409,'REVISION_CONFLICT');
      if (path.includes('/songs')) {
        if (method === 'DELETE') p.songIds = p.songIds.filter(id => id !== decodeURIComponent(playlistPath[2]));
        else if (method === 'PUT' && Array.isArray(body.songIds) && body.songIds.every(id => byId.has(id))) p.songIds = [...new Set(body.songIds)].slice(0,500);
        else return result(null,400,'INVALID_SONGS');
      } else if (method === 'DELETE') {
        if (p.kind === 'favorite') return result(null,403,'FAVORITE_PROTECTED');
        state.playlists = state.playlists.filter(item => item !== p); state.shelf.items = state.shelf.items.filter(item => item.id !== p.id); state.shelf.revision++;
        return commit({ shelf: state.shelf });
      } else if (method === 'PUT' && p.kind !== 'favorite') {
        const name = String(body.name || '').trim();
        if (!name || name.length > 80) return result(null,400,'INVALID_NAME');
        p.name = name; p.description = String(body.description || '').slice(0,1000);
      } else return result(null,403,'DEMO_READ_ONLY');
      p.revision++; return commit({ playlist: detail(p) });
    }
    if (path === '/api/account/play-stats') {
      if (method === 'POST') {
        const events = Array.isArray(body.events) ? body.events : [];
        const known = new Set(state.stats.map(e => e.event_id));
        const added = events.filter(e => {
          if (!e || !byId.has(e.song_id) || typeof e.event_id !== 'string' || known.has(e.event_id)) return false;
          known.add(e.event_id); return true;
        });
        state.stats = [...state.stats, ...added].slice(-1000);
        return commit({ recorded: added.length, acceptedEventIds: events.map(e => e.event_id) });
      }
      if (method === 'GET') {
        const counts = new Map();
        for (const e of state.stats) { const prev = counts.get(e.song_id) || { ...byId.get(e.song_id), play_count: 0 }; prev.play_count++; prev.last_played_at = e.played_at; counts.set(e.song_id,prev); }
        return result({ songs: [...counts.values()].sort((a,b) => b.play_count-a.play_count), totalPlays: state.stats.length, totalUniqueSongs: counts.size });
      }
    }
    if (path === '/api/lyrics' && method === 'GET') {
      const song = byId.get(params.get('songId'));
      if (!song) return result(null,404,'SONG_NOT_FOUND');
      if (song.language === 'instrumental') return result({ status: 'not_needed', reason: 'instrumental' });
      const lyric = await import('./lyrics.js');
      return result(lyric.default);
    }
    // Unknown reads and all shared/admin/AI writes fail closed, locally.
    return result(null,403,'DEMO_READ_ONLY');
  };
  return { handle, read, isTemporary: () => temporary,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    reset() { memory = initial(); try { storage()?.removeItem(DEMO_KEY); } catch { markTemporary(); } } };
}
