export function makeSong(overrides = {}) {
  return {
    id: 'song-1',
    title: 'Night Song',
    artist: 'Singer',
    album: 'Album',
    duration: 255,
    language: 'en',
    ...overrides,
  };
}

export function makeSongDb(songs = [makeSong()]) {
  const byId = new Map(songs.map((song) => [song.id, song]));
  return {
    prepare(sql) {
      return {
        args: [],
        bind(...args) { this.args = args; return this; },
        async first() {
          if (/FROM Songs/u.test(sql)) return byId.get(this.args[0]) || null;
          return null;
        },
      };
    },
  };
}

export function makeLyricDocument(overrides = {}) {
  return {
    version: 2,
    source: 'kugou',
    format: 'krc',
    syncMode: 'word',
    lrc: '[00:01.000]Hello',
    lines: [{
      time: 1,
      endTime: 2,
      text: 'Hello',
      words: [{ text: 'Hello', startTime: 1, endTime: 2 }],
    }],
    providerMeta: {
      providerLyricId: 'kg-1',
      matchedTitle: 'Night Song',
      matchedArtist: 'Singer',
      matchedDuration: 255,
      durationDelta: 0,
    },
    ...overrides,
  };
}

export function makeReadyArtifact(overrides = {}) {
  return {
    schemaVersion: 1,
    songId: 'song-1',
    status: 'ready',
    original: {
      source: 'kugou',
      format: 'krc',
      syncMode: 'word',
      lines: [{
        time: 1,
        endTime: 2,
        text: 'Hello',
        words: [{ text: 'Hello', startTime: 1, endTime: 2 }],
      }],
    },
    translation: null,
    aiCompletion: null,
    offsetMs: 0,
    textHash: 'a'.repeat(64),
    provenance: {
      providerLyricId: 'kg-1',
      matchedTitle: 'Night Song',
      matchedArtist: 'Singer',
      matchedDuration: 43,
    },
    updatedAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  };
}

export function createMemoryLyricStore(initialArtifact = null) {
  let artifact = initialArtifact;
  let etagVersion = initialArtifact ? 1 : 0;
  const calls = { get: 0, create: 0, put: 0, delete: 0 };
  const snapshot = () => artifact ? structuredClone(artifact) : null;
  return {
    calls,
    key: (songId) => `media/lyrics/${songId}.json`,
    async get() {
      calls.get += 1;
      return artifact
        ? { state: 'found', artifact: snapshot(), etag: `etag-${etagVersion}` }
        : { state: 'missing', artifact: null, etag: null };
    },
    async createIfAbsent(_songId, value) {
      calls.create += 1;
      if (artifact) return { state: 'conflict', artifact: null, etag: null };
      artifact = structuredClone(value);
      etagVersion += 1;
      return { state: 'created', artifact: snapshot(), etag: `etag-${etagVersion}` };
    },
    async putIfMatch(_songId, value, etag) {
      calls.put += 1;
      if (!artifact || etag !== `etag-${etagVersion}`) {
        return { state: 'conflict', artifact: null, etag: null };
      }
      artifact = structuredClone(value);
      etagVersion += 1;
      return { state: 'updated', artifact: snapshot(), etag: `etag-${etagVersion}` };
    },
    async delete() {
      calls.delete += 1;
      artifact = null;
      etagVersion += 1;
      return { state: 'deleted' };
    },
    singleflight(_songId, task) { return task(); },
    current() { return snapshot(); },
  };
}

export function createMemoryR2Bucket({
  initialObjects = {},
  onGet,
  onPut,
  onDelete,
} = {}) {
  const objects = new Map(Object.entries(initialObjects).map(([key, value]) => [key, {
    text: typeof value === 'string' ? value : JSON.stringify(value),
    etag: 'etag-0',
  }]));
  let etagVersion = 0;
  const calls = { get: [], put: [], delete: [] };
  return {
    calls,
    objects,
    async get(key) {
      calls.get.push(key);
      await onGet?.(key, this);
      const stored = objects.get(key);
      if (!stored) return null;
      return {
        size: new TextEncoder().encode(stored.text).byteLength,
        etag: stored.etag,
        text: async () => stored.text,
      };
    },
    async put(key, value, options = {}) {
      calls.put.push({ key, value: String(value), options });
      await onPut?.(key, value, options, this);
      const existing = objects.get(key);
      if (options.onlyIf?.etagDoesNotMatch === '*' && existing) return null;
      if (options.onlyIf?.etagMatches !== undefined
        && (!existing || existing.etag !== options.onlyIf.etagMatches)) return null;
      const etag = `etag-${++etagVersion}`;
      objects.set(key, { text: String(value), etag });
      return { etag };
    },
    async delete(key) {
      calls.delete.push(key);
      await onDelete?.(key, this);
      objects.delete(key);
    },
    json(key) {
      const stored = objects.get(key);
      return stored ? JSON.parse(stored.text) : null;
    },
  };
}
