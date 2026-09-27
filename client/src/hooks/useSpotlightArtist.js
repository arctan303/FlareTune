import { useState, useEffect, useRef, useCallback } from 'react';
import { getApiBaseUrl } from '../services/apiBase.js';
import { hydrateSong } from '../utils.js';
import { authenticatedFetch } from '../services/authenticatedFetch.js';
import {
  getArtistPhotoApiBase,
  ARTIST_PHOTO_CACHE,
  preloadAndDecodeImage,
} from './useArtistPhotos.js';

const REFRESH_COOLDOWN_MS = 600;
export const SPOTLIGHT_ARTIST_STORAGE_KEY = 'musicPlayer_spotlight_artist_v1';

/**
 * 获取本地自然日日期字符串（YYYY-MM-DD），避免由于时区转换产生的跨天偏差
 */
export function getLocalTodayDateString(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getSafeLocalStorage() {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
    if (typeof localStorage !== 'undefined') {
      return localStorage;
    }
  } catch {
    // 权限限制或无痕模式
  }
  return null;
}

export function getStoredSpotlightCache(storage = getSafeLocalStorage()) {
  if (!storage) return null;
  try {
    const raw = storage.getItem(SPOTLIGHT_ARTIST_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.date || !parsed.data || typeof parsed.data !== 'object' || !parsed.data.artist) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveStoredSpotlightCache(data, dateStr = getLocalTodayDateString(), storage = getSafeLocalStorage()) {
  if (!storage || !data?.artist) return;
  try {
    const payload = {
      date: dateStr,
      data: {
        artist: String(data.artist || '').trim(),
        songs: Array.isArray(data.songs) ? data.songs : [],
        coverUrl: data.coverUrl || '',
        photoUrl: data.photoUrl || '',
        songCount: typeof data.songCount === 'number' ? data.songCount : (data.songs?.length || 0),
      },
    };
    storage.setItem(SPOTLIGHT_ARTIST_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // 忽略写入失败
  }
}

export function buildSpotlightExcludeParam(excludeList = []) {
  if (!Array.isArray(excludeList) || !excludeList.length) return '';
  const filtered = excludeList.map((s) => String(s || '').trim()).filter(Boolean);
  return filtered.length > 0 ? `?exclude=${encodeURIComponent(filtered.join(','))}` : '';
}

// 本地保底提取算法（当离线、服务异常或未就绪时使用）
export function extractFallbackSpotlightArtist(fallbackSongs = []) {
  const list = Array.isArray(fallbackSongs) ? fallbackSongs : [];
  if (!list.length) return null;
  const artistMap = new Map();
  for (const s of list) {
    if (!s || !s.artist) continue;
    const rawArtist = s.artist;
    const names = rawArtist.split(/[,/、&，]/).map((n) => n.trim()).filter(Boolean);
    for (const name of (names.length ? names : [rawArtist])) {
      if (!artistMap.has(name)) artistMap.set(name, []);
      artistMap.get(name).push(hydrateSong(s));
    }
  }
  const candidates = Array.from(artistMap.entries())
    .filter(([name]) => name !== '纯音乐' && name !== '未知歌手' && name !== '群星')
    .sort((a, b) => b[1].length - a[1].length);
  if (!candidates.length) return null;
  const richPool = candidates.filter(([, songs]) => songs.length >= 2);
  const pool = richPool.length > 0 ? richPool : candidates;
  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86400000);
  const selected = pool[dayOfYear % pool.length];
  return {
    artist: selected[0],
    songs: selected[1],
    coverUrl: selected[1].find((s) => s.cover_url)?.cover_url || '',
    songCount: selected[1].length,
  };
}

export function useSpotlightArtist(authenticated, fallbackSongs = []) {
  // 解耦 fallbackSongs 依赖：使用 ref 保持最新值，防止曲库/点赞/播放足迹变更导致重复发起请求
  const fallbackSongsRef = useRef(fallbackSongs);
  fallbackSongsRef.current = fallbackSongs;

  // 首屏挂载尝试从当天本地缓存读取，实现 0ms 秒开无白屏无跳动
  const [initialData] = useState(() => {
    const today = getLocalTodayDateString();
    const cache = getStoredSpotlightCache();
    if (cache && cache.date === today && cache.data?.artist) {
      return cache.data;
    }
    return null;
  });

  const [spotlightArtist, setSpotlightArtist] = useState(() => initialData?.artist || '');
  const [spotlightSongs, setSpotlightSongs] = useState(() => (initialData?.songs || []).map(hydrateSong));
  const [spotlightCover, setSpotlightCover] = useState(() => initialData?.coverUrl || '');
  const [spotlightPhoto, setSpotlightPhoto] = useState(() => initialData?.photoUrl || '');
  const [spotlightCount, setSpotlightCount] = useState(() => initialData?.songCount || initialData?.songs?.length || 0);
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);

  const seenArtistsRef = useRef(initialData?.artist ? [initialData.artist] : []);
  const cooldownTimerRef = useRef(null);
  const switchingTimerRef = useRef(null);
  const requestIdRef = useRef(0);

  const getFallbackArtist = useCallback(() => {
    return extractFallbackSpotlightArtist(fallbackSongsRef.current);
  }, []);

  const applyArtistData = useCallback((data, { syncCache = false } = {}) => {
    if (!data?.artist) return;
    const artist = data.artist;
    const songs = (data.songs || []).map(hydrateSong);
    const coverUrl = data.coverUrl || songs.find((s) => s.cover_url)?.cover_url || '';
    const photoUrl = data.photoUrl || '';
    const songCount = data.songCount || songs.length;

    setSpotlightArtist(artist);
    setSpotlightSongs(songs);
    setSpotlightCover(coverUrl);
    setSpotlightPhoto(photoUrl);
    setSpotlightCount(songCount);

    if (!seenArtistsRef.current.includes(artist)) {
      seenArtistsRef.current = [artist, ...seenArtistsRef.current].slice(0, 15);
    }

    if (syncCache) {
      saveStoredSpotlightCache({ artist, songs, coverUrl, photoUrl, songCount });
    }

    // 预载照片或若无则从写真服务尝试异步获取
    if (photoUrl) {
      void preloadAndDecodeImage(photoUrl);
    } else {
      const trimmed = artist.trim();
      if (ARTIST_PHOTO_CACHE.has(trimmed)) {
        const cached = ARTIST_PHOTO_CACHE.get(trimmed);
        if (Array.isArray(cached) && cached[0]?.url) {
          const fetchedPhoto = cached[0].url;
          setSpotlightPhoto(fetchedPhoto);
          void preloadAndDecodeImage(fetchedPhoto);
          const currentCache = getStoredSpotlightCache();
          if (currentCache?.data?.artist === artist) {
            saveStoredSpotlightCache({ ...currentCache.data, photoUrl: fetchedPhoto }, currentCache.date);
          }
        }
      } else {
        const photoApiBase = getArtistPhotoApiBase();
        authenticatedFetch(`${photoApiBase}/api/artist-photo?name=${encodeURIComponent(trimmed)}`, { credentials: 'include' })
          .then((r) => r.json())
          .then((res) => {
            const photos = res?.data?.photos || [];
            ARTIST_PHOTO_CACHE.set(trimmed, photos);
            if (photos[0]?.url) {
              const fetchedPhoto = photos[0].url;
              setSpotlightPhoto(fetchedPhoto);
              void preloadAndDecodeImage(fetchedPhoto);
              const currentCache = getStoredSpotlightCache();
              if (currentCache?.data?.artist === artist) {
                saveStoredSpotlightCache({ ...currentCache.data, photoUrl: fetchedPhoto }, currentCache.date);
              }
            }
          })
          .catch(() => {});
      }
    }
  }, []);

  const fetchSpotlightArtist = useCallback(async (excludeList = [], { applyImmediately = true } = {}) => {
    const requestId = ++requestIdRef.current;
    const apiBase = getApiBaseUrl();
    const excludeParam = excludeList.length > 0
      ? `?exclude=${encodeURIComponent(excludeList.join(','))}`
      : '';
    try {
      const res = await authenticatedFetch(`${apiBase}/api/songs/spotlight-artist${excludeParam}`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`spotlight artist request failed (${res.status})`);
      const json = await res.json();
      if (json.code !== 200 || !json.data?.artist) throw new Error('Invalid response');
      if (requestId === requestIdRef.current && applyImmediately) {
        applyArtistData(json.data);
      }
      return { ok: true, data: json.data };
    } catch (err) {
      if (requestId === requestIdRef.current && applyImmediately) {
        const fallback = getFallbackArtist();
        if (fallback) applyArtistData(fallback);
      }
      return { ok: false, error: err };
    }
  }, [applyArtistData, getFallbackArtist]);

  // 初次载入或登录状态改变
  useEffect(() => {
    const today = getLocalTodayDateString();
    const cache = getStoredSpotlightCache();

    if (!authenticated) {
      if (!cache || cache.date !== today || !cache.data?.artist) {
        const fallback = getFallbackArtist();
        if (fallback) applyArtistData(fallback);
      } else {
        applyArtistData(cache.data);
      }
      return;
    }

    // 当天已有有效缓存：直接应用缓存，同一天内刷新或反复进出保持固定，不重新随机打扰用户
    if (cache && cache.date === today && cache.data?.artist) {
      applyArtistData(cache.data);
      return;
    }

    // 无缓存或跨自然日：向后端拉取新一天的焦点音乐人并缓存
    setIsLoading(true);
    fetchSpotlightArtist(seenArtistsRef.current)
      .then((res) => {
        if (res?.ok && res.data) {
          saveStoredSpotlightCache(res.data, today);
        }
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [authenticated, fetchSpotlightArtist, getFallbackArtist, applyArtistData]);

  // 跨天检测：网页长时间保持打开状态时，当标签页重新被激活（如隔天唤醒浏览器）自动检查日期并刷新
  useEffect(() => {
    if (typeof document === 'undefined') return;

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && authenticated) {
        const today = getLocalTodayDateString();
        const cache = getStoredSpotlightCache();
        // 如果缓存已过期（跨天），拉取今日新歌手并持久化
        if (cache && cache.date !== today) {
          fetchSpotlightArtist(seenArtistsRef.current).then((res) => {
            if (res?.ok && res.data) {
              saveStoredSpotlightCache(res.data, today);
            }
          });
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [authenticated, fetchSpotlightArtist]);

  // 手动点击「换一位」：向后端获取新歌手，成功后更新为当天的缓存
  const refresh = useCallback(async () => {
    setIsRefreshing(true);
    setIsSwitching(true);
    const exclude = [...seenArtistsRef.current];
    if (spotlightArtist && !exclude.includes(spotlightArtist)) {
      exclude.unshift(spotlightArtist);
    }
    // 并行拉取新歌手并预留 180ms 优雅淡出旧信息过渡期
    const [fetchResult] = await Promise.all([
      fetchSpotlightArtist(exclude, { applyImmediately: false }),
      new Promise((resolve) => setTimeout(resolve, 180)),
    ]);

    const today = getLocalTodayDateString();
    if (fetchResult?.ok && fetchResult.data) {
      applyArtistData(fetchResult.data);
      saveStoredSpotlightCache(fetchResult.data, today);
    } else {
      const fallback = getFallbackArtist();
      if (fallback) {
        applyArtistData(fallback);
        saveStoredSpotlightCache(fallback, today);
      }
    }

    // 给新数据一帧挂载时间后优雅淡入
    requestAnimationFrame(() => {
      setIsSwitching(false);
    });

    clearTimeout(cooldownTimerRef.current);
    cooldownTimerRef.current = setTimeout(() => {
      setIsRefreshing(false);
    }, REFRESH_COOLDOWN_MS);
    return fetchResult;
  }, [applyArtistData, fetchSpotlightArtist, getFallbackArtist, spotlightArtist]);

  useEffect(() => () => {
    clearTimeout(cooldownTimerRef.current);
    clearTimeout(switchingTimerRef.current);
  }, []);

  return {
    spotlightArtist,
    spotlightSongs,
    spotlightCover,
    spotlightPhoto,
    spotlightCount,
    isLoading,
    isRefreshing,
    isSwitching,
    refresh,
  };
}
