import React from 'react';
import { t } from '../i18n/index.js';
import { trapDrawerTabKey } from './drawers/drawerFocus.js';
import { canHandlePlayerEscape } from '../utils/playerOverlayKeyboard.js';

function PlayerPending({ onClose }) {
  const markerRef = React.useRef(null);
  React.useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !canHandlePlayerEscape(markerRef.current, document)) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose]);
  // No loading paint or focus transfer; keep Escape available while the import is pending.
  return <span ref={markerRef} hidden aria-hidden="true" data-player-pending="" />;
}

function PlayerRecovery({ onRetry, onClose }) {
  const panelRef = React.useRef(null);
  React.useEffect(() => {
    const panel = panelRef.current;
    const previousFocus = document.activeElement;
    if (canHandlePlayerEscape(panel, document)) panel?.querySelector('button')?.focus({ preventScroll: true });
    const handleKeyDown = (event) => {
      if (event.defaultPrevented || !canHandlePlayerEscape(panel, document)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      } else {
        trapDrawerTabKey(event, panel, document.activeElement);
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      if (panel?.contains(document.activeElement) && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 px-6 text-white" data-player-recovery="error">
      <section ref={panelRef} tabIndex={-1} aria-label={t('全屏播放器')} className="w-full max-w-sm text-center">
        <div role="alert">
          <h2 className="mb-2 text-lg font-semibold">{t('播放器加载失败')}</h2>
          <p className="mb-5 text-sm text-white/70">{t('可以重试或返回，音乐会继续播放。')}</p>
        </div>
        <div className="mt-5 flex justify-center gap-3">
          <button type="button" onClick={onRetry} className="min-h-11 rounded-lg bg-white px-5 py-2 text-sm font-semibold text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4">{t('重试')}</button>
          <button type="button" onClick={onClose} className="min-h-11 rounded-lg border border-white/30 px-5 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4">{t('返回')}</button>
        </div>
      </section>
    </div>
  );
}

class PlayerBoundary extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error) { console.error('[FullscreenPlayer] Component unavailable:', error); }
  render() {
    return this.state.failed
      ? <PlayerRecovery onRetry={this.props.onRetry} onClose={this.props.onClose} />
      : this.props.children;
  }
}

// A new React.lazy instance invokes the loader again after a rejected import.
// The boundary remains local to the player; the shared audio engine stays mounted.
export default function FullscreenPlayerSurface({ loader, motionProfile, onClose }) {
  const [attempt, setAttempt] = React.useState(0);
  const Player = React.useMemo(() => React.lazy(loader), [loader, attempt]);
  const retry = React.useCallback(() => setAttempt((value) => value + 1), []);
  return (
    <PlayerBoundary key={attempt} onRetry={retry} onClose={onClose}>
      <React.Suspense fallback={<PlayerPending onClose={onClose} />}>
        <Player motionProfile={motionProfile} />
      </React.Suspense>
    </PlayerBoundary>
  );
}
