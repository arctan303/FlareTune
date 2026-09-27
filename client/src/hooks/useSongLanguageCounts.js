import React from 'react';
import { getApiBaseUrl } from '../services/apiBase.js';
import { authenticatedFetch } from '../services/authenticatedFetch.js';

const DIRECT_LANGUAGE_KEYS = new Set(['zh', 'en', 'ja', 'ko', 'instrumental', 'other']);

const normalizeCount = (value) => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null
);

export function normalizeSongLanguageCounts(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

  const counts = {};
  let all = 0;
  let other = 0;
  let hasCount = false;

  for (const [language, rawCount] of Object.entries(payload)) {
    const count = normalizeCount(rawCount);
    if (count === null) continue;
    hasCount = true;
    all += count;
    if (DIRECT_LANGUAGE_KEYS.has(language)) {
      counts[language] = count;
    } else {
      other += count;
    }
  }

  if (!hasCount) return null;
  counts.other = (counts.other || 0) + other;
  counts.all = all;
  return counts;
}

export function useSongLanguageCounts(isAuthenticated) {
  const [counts, setCounts] = React.useState(null);

  React.useEffect(() => {
    setCounts(null);
    if (!isAuthenticated) return undefined;

    const controller = new AbortController();
    const loadCounts = async () => {
      try {
        const response = await authenticatedFetch(`${getApiBaseUrl()}/api/songs?counts=language`, {
          credentials: 'include',
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) return;
        const payload = await response.json();
        if (payload?.code !== 200) return;
        const nextCounts = normalizeSongLanguageCounts(payload.data);
        if (nextCounts) setCounts(nextCounts);
      } catch (error) {
        if (error?.name !== 'AbortError') setCounts(null);
      }
    };

    void loadCounts();
    return () => controller.abort();
  }, [isAuthenticated]);

  return counts;
}
