import React from 'react';
import LazyImage from './LazyImage.jsx';
import { reconcileHistoryCoverEntries } from './historyCoverEntries.js';
import { imageLoadRegistry } from '../utils/imageLoadRegistry.js';
import { usePrivateMediaRouteRevision } from '../hooks/usePrivateMediaRouteRevision.js';
import { visibleImageSource } from '../utils/privateImageVisibility.js';
import { usePageActivity } from '../hooks/usePageActivity.js';

const LANDING_DURATION_MS = 1050;

function HistoryImage({ src, isStaged, onReady, onError }) {
  const visible = usePageActivity();
  const routeRevision = usePrivateMediaRouteRevision();
  const onErrorRef = React.useRef(onError);
  onErrorRef.current = onError;
  const [source, setSource] = React.useState(() => ({
    requested: src,
    display: imageLoadRegistry.shouldLoadPrivately(src)
      ? imageLoadRegistry.getReadySource(src) : src,
  }));
  const display = source.requested === src
    ? visibleImageSource(src, source.display, '/placeholder-album.svg', imageLoadRegistry, !isStaged) : null;

  React.useEffect(() => {
    if (!visible) return undefined;
    if (imageLoadRegistry.isPrivateMediaUrl(src) && !imageLoadRegistry.shouldLoadPrivately(src)) {
      setSource({ requested: src, display: null });
      if (isStaged) onErrorRef.current?.();
      return undefined;
    }
    if (!imageLoadRegistry.shouldLoadPrivately(src)) {
      setSource({ requested: src, display: src });
      return undefined;
    }
    const cached = imageLoadRegistry.getReadySource(src);
    if (cached) {
      setSource({ requested: src, display: cached });
      return undefined;
    }
    let active = true;
    setSource((current) => !isStaged && current.requested === src && imageLoadRegistry.canRetainSource(src, current.display)
      ? current : { requested: src, display: null });
    void imageLoadRegistry.load(src).then(({ url }) => {
      if (active) setSource({ requested: src, display: url });
    }).catch(() => {
      if (!active) return;
      if (isStaged) onErrorRef.current?.();
      else setSource({ requested: src, display: '/placeholder-album.svg' });
    });
    return () => { active = false; };
  }, [src, isStaged, routeRevision, visible]);

  if (!display) return null;
  const handleError = () => {
    if (imageLoadRegistry.shouldLoadPrivately(src)) imageLoadRegistry.markError(src);
    if (isStaged) onErrorRef.current?.();
    else if (display !== '/placeholder-album.svg') {
      setSource({ requested: src, display: '/placeholder-album.svg' });
    }
  };
  return <img
    src={display}
    alt=""
    draggable="false"
    decoding="sync"
    ref={isStaged ? (node) => { if (node?.complete) onReady?.(node); } : null}
    onLoad={isStaged ? (event) => { onReady?.(event.currentTarget); } : undefined}
    onError={handleError}
  />;
}

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
    return <HistoryImage src={src} isStaged={isStaged}
      onReady={isStaged ? (node) => { void prepareImage(kind, node, staged.version); } : undefined}
      onError={isStaged ? () => failStage(staged.version) : undefined} />;
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
