import React from 'react';
import { RefreshCw } from 'lucide-react';
import { t } from '../i18n/index.js';
import { hydrateSong } from '../utils';
import { usePlayStatsStore } from '../store/usePlayStatsStore.js';
import PageBackButton from './PageBackButton.jsx';
import TrackRow from './TrackRow.jsx';

export default function PlayStatsDetailView({ onBack, songsMap, likedSongIdSet = new Set(), ...trackActions }) {
    const ownerSubject = usePlayStatsStore((state) => state.ownerSubject);
    const identityReady = usePlayStatsStore((state) => state.identityReady);
    const topSongs = usePlayStatsStore((state) => state.topSongs);
    const [loadState, setLoadState] = React.useState({ subject: null, status: 'loading' });
    const requestVersion = React.useRef(0);
    const refresh = React.useCallback(async () => {
        const version = ++requestVersion.current;
        setLoadState({ subject: ownerSubject, status: 'loading' });
        const result = await usePlayStatsStore.getState().refreshRemoteStats(50, { requireDetailView: true });
        if (version === requestVersion.current) {
            setLoadState({ subject: ownerSubject, status: result.ok ? 'ready' : 'error' });
        }
    }, [ownerSubject]);

    React.useEffect(() => {
        if (!ownerSubject || !identityReady) return undefined;
        usePlayStatsStore.getState().setDetailViewActive(true);
        void refresh();
        return () => {
            requestVersion.current += 1;
            usePlayStatsStore.getState().setDetailViewActive(false);
        };
    }, [ownerSubject, identityReady, refresh]);

    const songs = React.useMemo(() => topSongs.map((song) => {
        const mapped = songsMap instanceof Map
            ? songsMap.get(String(song.id)) || songsMap.get(Number(song.id)) || {}
            : songsMap?.[song.id] || {};
        return hydrateSong({ ...mapped, ...song });
    }).filter((song) => song?.title), [songsMap, topSongs]);
    // A persisted or locally accumulated partial ledger is not an authoritative first view.
    const status = identityReady && loadState.subject === ownerSubject ? loadState.status : 'loading';

    return <div className="app-page pb-24">
        <PageBackButton className="mb-5" onClick={onBack} />
        <header className="flex items-center justify-between gap-4 mb-8">
            <h1 className="text-3xl font-bold">{t('常听单曲')}</h1>
            <button type="button" className="flex items-center gap-2 text-sm text-[var(--primary)] disabled:opacity-50"
                onClick={refresh} disabled={status === 'loading' || !ownerSubject || !identityReady}>
                <RefreshCw size={16} aria-hidden="true" />{t('刷新')}
            </button>
        </header>
        {status === 'loading' ? <p role="status">{t('加载中...')}</p>
            : status === 'error' ? <p role="alert">{t('播放统计加载失败，请刷新重试。')}</p>
                : songs.length === 0 ? <p className="text-sm text-[var(--muted)]">{t('还没有常听单曲')}</p>
                    : <div className="home-track-grid">{songs.map((song) => <TrackRow key={song.id}
                        {...trackActions} song={song} songs={songs} showPlayCount
                        isLiked={likedSongIdSet.has(String(song.id))} />)}</div>}
    </div>;
}
