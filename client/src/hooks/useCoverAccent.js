import React from 'react';
import {
  DEFAULT_COVER_ACCENT,
  extractCoverPalette,
  getPlayerThemeColors,
  rgbToHex,
} from '../utils/coverAccent';
import { usePlayerStore } from '../store/usePlayerStore';
import { useUIStore } from '../store/useUIStore';

import { resolveCoverUrl } from '../utils.js';

export function useCoverAccent() {
  const rawCoverUrl = usePlayerStore((state) => state.currentSong?.cover_url);
  const [accent, setAccent] = React.useState(DEFAULT_COVER_ACCENT);

  React.useEffect(() => {
    if (!rawCoverUrl || typeof window === 'undefined' || typeof Image === 'undefined') {
      setAccent(DEFAULT_COVER_ACCENT);
      return undefined;
    }

    const coverUrl = resolveCoverUrl(rawCoverUrl);
    if (!coverUrl || coverUrl === '/placeholder-album.svg') {
      setAccent(DEFAULT_COVER_ACCENT);
      return undefined;
    }

    let cancelled = false;
    const img = new Image();
    img.crossOrigin = 'Anonymous';

    img.onload = () => {
      if (cancelled) return;
      const palette = extractCoverPalette(img);
      if (palette) {
        setAccent(rgbToHex(palette));
      } else {
        setAccent(DEFAULT_COVER_ACCENT);
      }
    };

    img.onerror = () => {
      if (cancelled) return;
      setAccent(DEFAULT_COVER_ACCENT);
    };

    const tinyUrl = coverUrl.includes('size=600') ? coverUrl.replace('size=600', 'size=50') : coverUrl;
    img.src = tinyUrl;

    return () => {
      cancelled = true;
      img.onload = null;
      img.onerror = null;
    };
  }, [rawCoverUrl]);

  return accent || DEFAULT_COVER_ACCENT;
}

export function usePlayerBarThemeColors() {
  const rawCoverUrl = usePlayerStore((state) => state.currentSong?.cover_url);
  const isDarkMode = useUIStore((state) => state.isDarkMode);
  const [palette, setPalette] = React.useState(null);

  React.useEffect(() => {
    if (!rawCoverUrl || typeof window === 'undefined' || typeof Image === 'undefined') {
      setPalette(null);
      return undefined;
    }

    const coverUrl = resolveCoverUrl(rawCoverUrl);
    if (!coverUrl || coverUrl === '/placeholder-album.svg') {
      setPalette(null);
      return undefined;
    }

    let cancelled = false;
    const img = new Image();
    img.crossOrigin = 'Anonymous';

    img.onload = () => {
      if (cancelled) return;
      const extracted = extractCoverPalette(img);
      setPalette(extracted);
    };

    img.onerror = () => {
      if (cancelled) return;
      setPalette(null);
    };

    const tinyUrl = coverUrl.includes('size=600') ? coverUrl.replace('size=600', 'size=50') : coverUrl;
    img.src = tinyUrl;

    return () => {
      cancelled = true;
      img.onload = null;
      img.onerror = null;
    };
  }, [rawCoverUrl]);

  return React.useMemo(() => {
    return getPlayerThemeColors(palette, isDarkMode);
  }, [palette, isDarkMode]);
}
