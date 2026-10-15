import { LyricSourceError } from './lyricSourceError.js';

// One operation shares this allowance across all source adapters and downloads.
// Stay below Workers Free's 50 subrequests, leaving room for D1, R2 and AI.
export const LYRIC_REQUEST_LIMIT = 32;
const LRCLIB_RESERVED_REQUESTS = 2;

export function createLyricRequestBudget() {
  let used = 0;
  let customUsed = 0;
  return {
    consume(provider) {
      if (used >= LYRIC_REQUEST_LIMIT
        || (provider !== 'lrclib' && customUsed >= LYRIC_REQUEST_LIMIT - LRCLIB_RESERVED_REQUESTS)) {
        throw new LyricSourceError('rate_limited', provider, 'budget', 'Lyric operation request budget exceeded');
      }
      used += 1;
      if (provider !== 'lrclib') customUsed += 1;
    },
  };
}
