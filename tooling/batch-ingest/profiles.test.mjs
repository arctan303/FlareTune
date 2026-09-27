import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProfileStore } from './profiles.mjs';

test('multiple profiles keep passwords outside metadata and remove credentials on deletion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flaretune-profiles-'));
  const stored = new Map();
  const vault = { set: async ({ name, value }) => { stored.set(name, value); },
    get: async ({ name }) => stored.get(name) || null,
    delete: async ({ name }) => { stored.delete(name); } };
  const profiles = new ProfileStore({ path: join(directory, 'profiles.json'), vault });
  try {
    const one = (await profiles.save({ name: '实例 01', baseUrl: 'https://one.example', username: 'admin',
      password: 'first-secret', rememberPassword: true })).profile;
    const two = (await profiles.save({ name: '实例 02', baseUrl: 'https://two.example', username: 'owner',
      password: 'second-secret', rememberPassword: true })).profile;
    assert.equal((await profiles.list()).length, 2);
    assert.equal(await profiles.password(one.id), 'first-secret');
    assert.equal(await profiles.password(two.id), 'second-secret');
    const file = await readFile(profiles.path, 'utf8');
    assert.ok(!file.includes('first-secret') && !file.includes('second-secret'));
    await profiles.remove(one.id);
    assert.equal(await profiles.password(one.id), null);
    assert.equal((await profiles.list())[0].id, two.id);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unavailable credential store keeps profile usable without falsely claiming password saved', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flaretune-profiles-'));
  const profiles = new ProfileStore({ path: join(directory, 'profiles.json'), vault: {
    set: async () => { throw new Error('unavailable'); }, get: async () => null, delete: async () => {},
  } });
  try {
    const { profile, warning } = await profiles.save({ name: '实例', baseUrl: 'https://one.example', username: 'admin',
      password: 'temporary-secret', rememberPassword: true });
    assert.equal(profile.savedPassword, false);
    assert.match(warning, /密码未保存/);
    assert.ok(!(await readFile(profiles.path, 'utf8')).includes('temporary-secret'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('failed password update preserves saved profile so deletion removes the old credential', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flaretune-profiles-'));
  const stored = new Map();
  let failNextSet = false;
  const profiles = new ProfileStore({ path: join(directory, 'profiles.json'), vault: {
    set: async ({ name, value }) => { if (failNextSet) throw new Error('credential write failed'); stored.set(name, value); },
    get: async ({ name }) => stored.get(name) || null,
    delete: async ({ name }) => { stored.delete(name); },
  } });
  try {
    const first = (await profiles.save({ name: '实例', baseUrl: 'https://one.example', username: 'admin',
      password: 'old-secret', rememberPassword: true })).profile;
    failNextSet = true;
    const attempt = await profiles.save({ id: first.id, name: '实例', baseUrl: first.baseUrl,
      username: 'admin', password: 'new-secret', rememberPassword: true });
    assert.match(attempt.warning, /旧凭据仍保留/);
    assert.equal((await profiles.list())[0].savedPassword, true);
    assert.equal(await profiles.password(first.id), 'old-secret');
    await profiles.remove(first.id);
    assert.equal(stored.size, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an existing profile can use a typed password when the credential store is temporarily unavailable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flaretune-profiles-'));
  let unavailable = false;
  const vault = { set: async () => {}, get: async () => { if (unavailable) throw new Error('unavailable'); return 'old'; },
    delete: async () => { if (unavailable) throw new Error('unavailable'); } };
  const profiles = new ProfileStore({ path: join(directory, 'profiles.json'), vault });
  try {
    const first = (await profiles.save({ name: '实例', baseUrl: 'https://one.example', username: 'admin',
      password: 'old', rememberPassword: true })).profile;
    unavailable = true;
    const temporary = await profiles.save({ id: first.id, name: first.name, baseUrl: first.baseUrl,
      username: first.username, password: 'new', rememberPassword: false });
    assert.equal(temporary.profile.id, first.id);
    assert.match(temporary.warning, /本次已登录/);
    assert.equal((await profiles.list())[0].savedPassword, true);
    const update = await profiles.save({ id: first.id, name: first.name, baseUrl: first.baseUrl,
      username: first.username, password: 'new', rememberPassword: true });
    assert.match(update.warning, /密码未更新/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
