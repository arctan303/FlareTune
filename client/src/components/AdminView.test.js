import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./AdminView.jsx', import.meta.url), 'utf8');

test('instance management replaces the retired Admin Key console', () => {
  for (const label of ['常规', '访问', 'AI 与助手', '曲库', '账号', '系统']) assert.match(source, new RegExp(label));
  assert.match(source, /getAdminOverview\(csrfToken\)/);
  assert.match(source, /getAdminMigrationStatus\(csrfToken\)/);
  assert.match(source, /DatabaseMigrationStatus status=\{status\} busy=\{busy\}/);
  assert.match(source, /authSession\.user\?\.role === 'admin'/);
  assert.doesNotMatch(source, /manageApi|AdminAuthPanel|setAdminKey|adminKeyInput|ADMIN_API_KEY/);
});

test('setting, assistant and account mutations use the local session CSRF token', () => {
  assert.match(source, /putAdminSetting\(key, value, overview\.settings\[key\]\.revision, csrfToken\)/);
  assert.match(source, /putAssistant\([^;]+revision, csrfToken\)/s);
  assert.match(source, /createManagedAccount\([^;]+csrfToken\)/s);
  assert.match(source, /patchManagedAccount\([^;]+csrfToken\)/s);
  assert.match(source, /resetManagedPassword\([^;]+csrfToken\)/s);
  assert.match(source, /parseExactHttpsOrigins/);
});

test('AI model profiles have their own panel and temporary passwords are not persisted', () => {
  assert.match(source, /AiProfilesPanel/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|setItem\(/);
  assert.doesNotMatch(source, /apiKeyInput|saveApiKey|type="text" name="apiKey"/);
  assert.match(source, /type="password" name="temporaryPassword"/);
});
