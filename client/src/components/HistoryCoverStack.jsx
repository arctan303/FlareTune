import React from 'react';
import LazyImage from './LazyImage.jsx';
import { reconcileHistoryCoverEntries } from './historyCoverEntries.js';

const LANDING_DURATION_MS = 1050;

export default function HistoryCoverStack({ history }) {
  const [visible, setVisible] = React.useState(() => reconcileHistoryCoverEntries(history.slice(0, 3)));
  const [staged, setStaged] = React.useState(null);
  const previousHistory = React.useRef(history);
  const run = React.useRef({ version: 0, timer: null, phase: 'idle', entry: null, ready: {}, decoding: {} });

  const failStage = React.useCallback((version) => {
    const current = run.current;
    if (current.version !== version || current.phase === 'idle') return;
    window.clearTimeout(current.timer);
    current.phase = 'idle';
    current.entry = null;
    setVisible((previous) => reconcileHistoryCoverEntries(previousHistory.current.slice(0, 3), previous));
    setStaged(null);
  }, []);

  const prepareImage = React.useCallback(async (kind, image, version) => {
    const current = run.current;
    if (current.version !== version || current.phase !== 'loading' || current.decoding[kind]) return;
    if (!image.complete || !image.naturalWidth) return;
    current.decoding[kind] = true;
    try {
      await image.decode?.();
    } catch {
      failStage(version);
      return;
    }
    if (current.version !== version || current.phase !== 'loading') return;
    current.ready[kind] = true;
    if (!current.ready.cover || !current.ready.ambient) return;

    const latest = previousHistory.current;
    current.entry = { ...current.entry, song: latest[0], ready: true };
    const readyEntry = current.entry;
    setVisible((previous) => reconcileHistoryCoverEntries(latest.slice(1, 4), previous));
    setStaged((previous) => previous?.version === version
      ? { ...previous, entry: readyEntry, phase: 'landing' } : previous);
    current.phase = 'landing';
    current.timer = window.setTimeout(() => {
      if (current.version !== version) return;
      const completedEntry = current.entry;
      setVisible((previous) => reconcileHistoryCoverEntries(
        previousHistory.current.slice(0, 3), previous, completedEntry,
      ));
      setStaged(null);
      current.phase = 'idle';
      current.entry = null;
    }, LANDING_DURATION_MS);
  }, [failStage]);

  React.useLayoutEffect(() => {
    const previous = previousHistory.current;
    const previousTop = previous[0];
    const nextTop = history[0];
    previousHistory.current = history;

    // play and playing both record the same song. The second event updates
    // its timestamp without interrupting the cover already in flight.
    if (nextTop?.id === previousTop?.id && nextTop?.cover_url === previousTop?.cover_url) {
      if (run.current.phase === 'idle') {
        setVisible((entries) => reconcileHistoryCoverEntries(history.slice(0, 3), entries));
      }
      return;
    }

    const current = run.current;
    const returnedBeforeLanding = current.phase === 'loading'
      && visible[0]?.song.id === nextTop?.id
      && visible[0]?.song.cover_url === nextTop?.cover_url;
    const interruptedEntry = current.phase === 'landing' ? current.entry : null;
    current.version += 1;
    window.clearTimeout(current.timer);
    current.phase = 'idle';
    current.entry = null;
    if (interruptedEntry) {
      setVisible((entries) => reconcileHistoryCoverEntries(previous.slice(0, 3), entries, interruptedEntry));
    }
    setStaged(null);

    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const newPlay = nextTop && nextTop.id !== previousTop?.id
      && nextTop.playedAt >= (previousTop?.playedAt || 0)
      && Date.now() - nextTop.playedAt < 5000;

    if (!newPlay || reducedMotion || !nextTop.cover_url || returnedBeforeLanding) {
      setVisible((entries) => reconcileHistoryCoverEntries(history.slice(0, 3), entries));
      return;
    }

    const nextEntry = { key: `arrival-${current.version}`, song: nextTop, ready: false };
    current.phase = 'loading';
    current.entry = nextEntry;
    current.ready = { cover: false, ambient: false };
    current.decoding = { cover: false, ambient: false };
    setStaged({ entry: nextEntry, phase: 'loading', version: current.version });
  }, [history]);

  React.useEffect(() => () => {
    run.current.version += 1;
    window.clearTimeout(run.current.timer);
  }, []);

  const imageFor = (entry, kind, isStaged) => {
    const src = entry.song.cover_url || '/placeholder-album.svg';
    if (!isStaged && !entry.ready) return <LazyImage src={src} fallback="/placeholder-album.svg" alt="" />;
    if (!isStaged) return <img src={src} alt="" draggable="false" decoding="sync" />;
    return <img
      src={src}
      alt=""
      draggable="false"
      decoding="sync"
      ref={(node) => { if (node?.complete) void prepareImage(kind, node, staged.version); }}
      onLoad={(event) => { void prepareImage(kind, event.currentTarget, staged.version); }}
      onError={() => failStage(staged.version)}
    />;
  };

  const stagedActive = staged?.phase === 'landing';
  const ambientEntries = [
    ...(visible[0]?.song.cover_url ? [{ entry: visible[0], isStaged: false }] : []),
    ...(staged ? [{ entry: staged.entry, isStaged: true }] : []),
  ];
  const coverEntries = [
    ...visible.map((entry) => ({ entry, isStaged: false })),
    ...(staged ? [{ entry: staged.entry, isStaged: true }] : []),
  ];

  return <>
    {ambientEntries.map(({ entry, isStaged }) => <span
      className={`editorial-card__history-ambient ${isStaged ? 'editorial-card__history-ambient--incoming' : ''} ${stagedActive && !isStaged ? 'is-outgoing' : ''} ${stagedActive && isStaged ? 'is-active' : ''}`}
      key={entry.key}
      aria-hidden="true"
    >
      {imageFor(entry, 'ambient', isStaged)}
    </span>)}
    <span className={`editorial-card__history-art ${stagedActive ? 'is-shifting' : ''}`} aria-hidden="true">
      {!visible.length && <span className="editorial-card__history-empty-art" />}
      {coverEntries.map(({ entry, isStaged }) => <span
        className={`editorial-card__history-cover ${isStaged ? 'editorial-card__history-cover--staged' : ''} ${isStaged && stagedActive ? 'is-active' : ''}`}
        key={entry.key}
      >
        {imageFor(entry, 'cover', isStaged)}
      </span>)}
    </span>
  </>;
}
