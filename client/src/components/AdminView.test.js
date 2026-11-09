import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./AdminView.jsx', import.meta.url), 'utf8');
const accountSource = readFileSync(new URL('./AdminAccountRow.jsx', import.meta.url), 'utf8');

test('instance management replaces the retired Admin Key console', () => {
  for (const label of ['常规', '访问', '曲库', '账号', '系统']) assert.match(source, new RegExp(label));
  assert.doesNotMatch(source, /AI 与助手|AiProfilesPanel|putAssistant/);
  assert.match(source, /getAdminOverview\(csrfToken\)/);
  assert.match(source, /getAdminMigrationStatus\(csrfToken\)/);
  assert.match(source, /DatabaseMigrationStatus status=\{status\} busy=\{busy\}/);
  assert.match(source, /authSession\.user\?\.role === 'admin'/);
  assert.doesNotMatch(source, /manageApi|AdminAuthPanel|setAdminKey|adminKeyInput|ADMIN_API_KEY/);
});

test('host settings and accounts retain their local session CSRF contract', () => {
  assert.match(source, /putAdminSetting\(key, value, expectedRevision, csrfToken\)/);
  assert.match(source, /createManagedAccount\([^;]+csrfToken\)/s);
  assert.match(accountSource, /patchManagedAccount\([^;]+csrfToken\)/s);
  assert.match(accountSource, /resetManagedPassword\([^;]+csrfToken\)/s);
  assert.match(source, /parseExactHttpsOrigins/);
});

test('host management keeps plugin provider controls out and never persists temporary passwords', () => {
  assert.doesNotMatch(source, /localStorage|sessionStorage|setItem\(/);
  assert.doesNotMatch(source, /apiKeyInput|saveApiKey|type="text" name="apiKey"/);
  assert.match(source, /type="password" name="temporaryPassword"/);
});
