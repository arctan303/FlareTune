import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// File identities are the existing scan identities, not audio fingerprints.
export class IngestHistory {
  constructor(database, scope) {
    this.db = database;
    this.scope = scope;
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS files (
        scope TEXT NOT NULL, id TEXT NOT NULL, location TEXT NOT NULL,
        metadata TEXT NOT NULL, seen_at INTEGER NOT NULL,
        PRIMARY KEY (scope, id)
      );
      CREATE INDEX IF NOT EXISTS files_location ON files(scope, location);
      CREATE TABLE IF NOT EXISTS transfers (
        scope TEXT NOT NULL, id TEXT NOT NULL, file_id TEXT NOT NULL, kind TEXT NOT NULL,
        result TEXT NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope, id)
      );
      CREATE INDEX IF NOT EXISTS transfers_file ON transfers(scope, file_id, kind, updated_at);
    `);
  }
  observe(files) {
    const insert = this.db.prepare(`INSERT INTO files VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(scope, id) DO UPDATE SET metadata = excluded.metadata, seen_at = excluded.seen_at`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const file of files) {
        const { ingest: _history, localLocation, ...metadata } = file;
        insert.run(this.scope, file.id, localLocation || file.path, JSON.stringify(metadata), Date.now());
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  record(job, result) {
    if (!['audio', 'cover'].includes(job.kind)) return;
    this.db.prepare(`INSERT INTO transfers VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope, id) DO UPDATE SET result = excluded.result, updated_at = excluded.updated_at`)
      .run(this.scope, job.id, job.fileId, job.kind,
        JSON.stringify({ id: job.id, status: result.status, url: result.url || null,
          message: result.message || '', mediaId: job.mediaId }), Date.now());
  }
  reconcile(catalog) {
    const byAudio = new Map(catalog.filter((song) => song.audio_url).map((song) => [song.audio_url, song]));
    const rows = this.db.prepare('SELECT id, result FROM transfers WHERE scope = ? AND kind = ?').all(this.scope, 'audio');
    const update = this.db.prepare('UPDATE transfers SET result = ? WHERE scope = ? AND id = ?');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        const transfer = JSON.parse(row.result);
        const song = transfer.status === 'done' ? byAudio.get(transfer.url) : null;
        update.run(JSON.stringify({ ...transfer, songId: song?.id || null,
          confirmedAt: song ? Date.now() : null }), this.scope, row.id);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  filesWithHistory(files) {
    const transfers = this.db.prepare(`SELECT result FROM transfers
      WHERE scope = ? AND file_id = ? AND kind = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1`);
    const previous = this.db.prepare(`SELECT 1 FROM files f
      WHERE f.scope = ? AND f.location = ? AND f.id != ? LIMIT 1`);
    return files.map((file) => {
      const { localLocation, ...visible } = file;
      const get = (kind) => {
        const row = transfers.get(this.scope, file.id, kind);
        return row ? JSON.parse(row.result) : null;
      };
      return { ...visible, ingest: { audio: get('audio'), cover: get('cover'),
        changed: Boolean(previous.get(this.scope, localLocation || file.path, file.id)) } };
    });
  }
  close() { this.db.close(); }
}

export async function openIngestHistory(path, baseUrl, accountId, deviceId = '') {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch { throw new Error('Local ingest history requires SQLite support. Start with npm run ingest or use Node.js 22.13+ .'); }
  if (path !== ':memory:') await mkdir(dirname(path), { recursive: true });
  const base = new URL(baseUrl);
  const scope = JSON.stringify([base.origin, base.pathname.replace(/\/$/, ''), accountId, deviceId]);
  const database = new DatabaseSync(path);
  try { return new IngestHistory(database, scope); }
  catch (error) { database.close(); throw error; }
}
