import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const baseline = readFileSync(new URL('../db/migrations-flaretune/0001_baseline.sql', import.meta.url), 'utf8');
const upgrade = readFileSync(new URL('../db/migrations-flaretune/0003_upgrade_assistant_model.sql', import.meta.url), 'utf8');

test('assistant model migration upgrades only the legacy default', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(baseline);
    db.exec(upgrade);
    assert.deepEqual({ ...db.prepare("SELECT model, revision FROM music_assistant_configs WHERE id='xiaoa'").get() },
      { model: 'deepseek-flash', revision: 2 });
    db.exec(upgrade);
    assert.equal(db.prepare("SELECT revision FROM music_assistant_configs WHERE id='xiaoa'").get().revision, 2);
    db.prepare("UPDATE music_assistant_configs SET model='custom-model' WHERE id='xiaoa'").run();
    db.exec(upgrade);
    assert.equal(db.prepare("SELECT model FROM music_assistant_configs WHERE id='xiaoa'").get().model,
      'custom-model');
  } finally { db.close(); }
});
