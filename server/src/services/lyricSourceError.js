export const safeLyricRetryAfterSeconds = (value) => (
  Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647 ? value : undefined
);

export const lyricSourceErrorCode = (error) => (
  error?.stage === 'budget' ? 'request_budget_exceeded' : error?.kind
);

export class LyricSourceError extends Error {
  constructor(kind, provider, stage, message, options = {}) {
    super(message, options);
    this.name = 'LyricSourceError';
    this.kind = kind;
    this.provider = provider;
    this.stage = stage;
    const retryAfterSeconds = safeLyricRetryAfterSeconds(options.retryAfterSeconds);
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}
