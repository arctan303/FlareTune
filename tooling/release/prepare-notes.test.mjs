import test from 'node:test';
import assert from 'node:assert/strict';
import { createReleaseNotes } from './prepare-notes.mjs';

const fixture = () => ({ tag: '1.1.3', packageJson: { version: '1.1.3' },
  lockfile: { version: '1.1.3', packages: { '': { version: '1.1.3' } } },
  chinese: '# 更新日志\r\n\r\n## 1.1.3 — 2026-10-03\r\n\r\n新增功能。\r\n\r\n### 修复\r\n\r\n- 修复一项。\r\n\r\n## 1.1.2 — 2026-10-02\r\n\r\n旧内容',
  english: '# Changelog\n\n## 1.1.3 — 2026-10-03\n\nNew features.\n\n### Fixes\n\n- A fix.\n\n## 1.1.2 — 2026-10-02\n\nOld content' });

test('release notes retain both complete UTF-8 sections without older releases', () => {
  const notes = createReleaseNotes(fixture());
  assert.match(notes, /新增功能。\n\n### 修复\n\n- 修复一项。/);
  assert.match(notes, /## English\n\nNew features\.\n\n### Fixes/);
  assert.doesNotMatch(notes, /旧内容|Old content|\r/);
});

test('noncanonical or executable tag names are rejected', () => {
  for (const tag of ['v1.1.3', '01.1.3', '1.1.3-beta', '1.1.3\n', '1.1.3;echo x', undefined]) {
    assert.throws(() => createReleaseNotes({ ...fixture(), tag }), /stable X.Y.Z/);
  }
});

test('each package and lockfile version is an independent release guard', () => {
  for (const change of [
    { packageJson: { version: '1.1.2' } },
    { lockfile: { ...fixture().lockfile, version: '1.1.2' } },
    { lockfile: { version: '1.1.3', packages: { '': { version: '1.1.2' } } } },
    { lockfile: { version: '1.1.3' } },
  ]) assert.throws(() => createReleaseNotes({ ...fixture(), ...change }), /must match/);
});

test('missing, duplicate, stale, empty or malformed changelog entries prevent publishing', () => {
  for (const chinese of ['# empty',
    '## 1.1.3 — 2026-10-03\nA\n## 1.1.3 — 2026-10-03\nB',
    '## 1.1.4 — 2026-10-04\nA\n' + fixture().chinese,
    '## 1.1.3 — 2026-10-03\n\n## 1.1.2 — 2026-10-02\nOld',
    '## 1.1.3 — tomorrow\nA']) {
    assert.throws(() => createReleaseNotes({ ...fixture(), chinese }));
  }
  assert.throws(() => createReleaseNotes({ ...fixture(), english: '# missing' }));
  assert.throws(() => createReleaseNotes({ ...fixture(), english: fixture().english.replace('2026-10-03', '2026-10-04') }), /dates must match/);
});
