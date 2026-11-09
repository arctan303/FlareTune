import { registerOutputTarget } from '../store/useOutputTargetStore.js';
import { capturePlaybackCleanup } from './playbackCleanup.js';

export function createOutputCapability({ pluginId, playerStore, audioRef, isCurrent, assertCurrent }) {
  return Object.freeze({ register() {
    assertCurrent();
    const target = registerOutputTarget(pluginId);
    const audio = playerStore.getState().audioRef?.current || audioRef?.current;
    let release = null, disposed = false;
    const listeners = new Map();
    const clock = audio && Object.freeze({
      get paused() { return audio.paused; }, get currentTime() { return audio.currentTime; },
      addEventListener(name, callback) {
        assertCurrent();
        if (disposed || typeof callback !== 'function' || !['play', 'pause', 'seeked', 'ended'].includes(name)) return;
        if (!listeners.has(name)) listeners.set(name, new Map());
        if (listeners.get(name).has(callback)) return;
        const guarded = () => { if (!disposed && isCurrent()) callback(Object.freeze({ type: name })); };
        listeners.get(name).set(callback, guarded); audio.addEventListener(name, guarded);
      },
      removeEventListener(name, callback) {
        const guarded = listeners.get(name)?.get(callback);
        if (guarded) { audio.removeEventListener(name, guarded); listeners.get(name).delete(callback); }
      },
    });
    return Object.freeze({
      clock,
      canClaim: () => !disposed && isCurrent() && target.canClaim(),
      publish(value) {
        if (value) assertCurrent();
        if (disposed) return false;
        return target.publish(value ? { ...value, write: (...args) =>
          !disposed && isCurrent() && target.canClaim() ? value.write?.(...args) : false } : null);
      },
      muteLocal() {
        assertCurrent();
        if (disposed || !audio || !target.canClaim()) return false;
        if (release) return true;
        const previousMuted = Boolean(audio.muted);
        let cleanup = capturePlaybackCleanup(playerStore), active = true;
        const capture = () => { if (isCurrent()) cleanup = capturePlaybackCleanup(playerStore); };
        const unsubscribe = playerStore.subscribe(capture);
        audio.addEventListener('loadstart', capture);
        audio.muted = true;
        release = ({ quiet = false } = {}) => {
          if (!active) return; active = false;
          unsubscribe(); audio.removeEventListener('loadstart', capture);
          if (quiet) cleanup();
          audio.muted = previousMuted; release = null;
        };
        return true;
      },
      restoreLocal(options) { release?.(options); },
      dispose() {
        if (disposed) return; disposed = true;
        release?.({ quiet: true }); target.dispose();
        for (const [name, callbacks] of listeners) for (const guarded of callbacks.values()) audio.removeEventListener(name, guarded);
        listeners.clear();
      },
    });
  } });
}
