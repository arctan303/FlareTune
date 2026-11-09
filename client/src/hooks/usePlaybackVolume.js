import { useCallback, useRef } from 'react';
import { usePlayerStore } from '../store/usePlayerStore.js';
import { useOutputTargetStore } from '../store/useOutputTargetStore.js';

// Restore values before mute, keyed by target. Shared by every control so a
// mute from the dock can be undone from fullscreen, lyrics or the keyboard
// even when that control mounted after the volume reached zero.
const rememberedVolumes = new Map();

// A thin volume target boundary. Playback, queues and output lifecycle stay in
// their existing owners; callers never bypass the active output's audio gate.
export function usePlaybackVolume(localOverride = {}) {
  const localVolume = usePlayerStore(state => state.volume);
  const output = useOutputTargetStore(state => state.target);
  const enabled = Boolean(output);
  const outputError = output?.error || '';
  const overrideRef = useRef(localOverride);
  overrideRef.current = localOverride;
  const remembered = useRef(rememberedVolumes);
  const targetId = output?.id || 'local';
  const volume = enabled ? output.volume : localOverride.volume ?? localVolume;
  if (Number.isFinite(volume) && volume > 0) remembered.current.set(targetId, volume);

  const readTarget = () => {
    const output = useOutputTargetStore.getState().target;
    if (output) return output;
    const player = usePlayerStore.getState(), local = overrideRef.current;
    return { id: 'local', volume: local.volume ?? player.volume, fallback: 0.8,
      write(value) {
        (local.setVolume ?? player.setVolume)(value);
        const audio = (local.audioRef ?? player.audioRef)?.current;
        if (audio) audio.volume = value;
      } };
  };
  const write = (target, next) => {
    if (!Number.isFinite(next)) return;
    const value = Math.max(0, Math.min(1, next));
    if (value > 0) remembered.current.set(target.id, value);
    try { Promise.resolve(target.write(value)).catch(() => {}); } catch { /* Target owns safe errors. */ }
  };
  const setVolume = useCallback(value => write(readTarget(), value), []);
  const toggleMute = useCallback(() => {
    const target = readTarget();
    if (target.volume > 0) { remembered.current.set(target.id, target.volume); write(target, 0); }
    else write(target, remembered.current.get(target.id) ?? target.fallback);
  }, []);
  return { volume, setVolume, toggleMute, targetId, outputEnabled: enabled, outputError };
}
