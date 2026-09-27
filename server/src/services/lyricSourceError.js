export class LyricSourceError extends Error {
  constructor(kind, provider, stage, message, options = {}) {
    super(message, options);
    this.name = 'LyricSourceError';
    this.kind = kind;
    this.provider = provider;
    this.stage = stage;
  }
}
