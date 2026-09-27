import { useEffect, useRef } from 'react';

export function useWakeLock({ isFullScreen = false } = {}) {
  const wakeLockRef = useRef(null);

  useEffect(() => {
    if (typeof window === 'undefined' || !('wakeLock' in navigator)) {
      return undefined;
    }

    const isTouchDevice = window.matchMedia('(pointer: coarse), (hover: none)').matches;
    if (!isTouchDevice) {
      return undefined;
    }

    let isCancelled = false;

    const requestLock = async () => {
      if (
        isCancelled ||
        !isFullScreen ||
        document.visibilityState !== 'visible' ||
        wakeLockRef.current
      ) {
        return;
      }
      try {
        const lock = await navigator.wakeLock.request('screen');
        if (isCancelled) {
          lock.release().catch(() => {});
          return;
        }
        wakeLockRef.current = lock;
        lock.addEventListener('release', () => {
          if (wakeLockRef.current === lock) {
            wakeLockRef.current = null;
          }
        });
      } catch (err) {
        console.info('[WakeLock] 无法取得屏幕常亮锁:', err?.message || err);
      }
    };

    const releaseLock = async () => {
      if (wakeLockRef.current) {
        try {
          await wakeLockRef.current.release();
        } catch {
          // Ignore release errors
        } finally {
          wakeLockRef.current = null;
        }
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        requestLock();
      } else {
        releaseLock();
      }
    };

    if (isFullScreen && document.visibilityState === 'visible') {
      requestLock();
    } else {
      releaseLock();
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      isCancelled = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      releaseLock();
    };
  }, [isFullScreen]);
}
