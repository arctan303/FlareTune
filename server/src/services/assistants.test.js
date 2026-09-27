import assert from 'node:assert/strict';
import test from 'node:test';
import {
  exposeAssistantBootstrap,
  readMusicAssistantConfig,
  toAssistantManagementDto,
} from './assistants.js';

const row = {
  id: 'xiaoa',
  name: '小A',
  description: 'Tune 音乐助手',
  avatar_icon: 'bot',
  persona: '有人味的音乐伙伴',
  welcome_message: '欢迎回来',
  system_rules: '只根据可信现场回答',
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  temperature: 0.7,
  revision: 3,
  created_at: 1,
  updated_at: 2,
  updated_by: 'admin-1',
};

const db = (value = row) => ({
  prepare(sql) {
    assert.match(sql, /FROM music_assistant_configs/);
    return {
      bind(id) {
        assert.equal(id, 'xiaoa');
        return { first: async () => value };
      },
    };
  },
});

test('music assistant configuration reads model, persona, policy, and revision from music DB', async () => {
  const assistant = await readMusicAssistantConfig(db());
  assert.equal(assistant.model, 'deepseek-v4-flash');
  assert.equal(assistant.systemRules, '只根据可信现场回答');
  assert.equal(assistant.revision, 3);
});

test('bootstrap exposure excludes private prompt and model fields', async () => {
  const assistant = await readMusicAssistantConfig(db());
  assert.deepEqual(exposeAssistantBootstrap(assistant), {
    id: 'xiaoa',
    name: '小A',
    description: 'Tune 音乐助手',
    avatarIcon: 'bot',
    welcomeMessage: '欢迎回来',
  });
  assert.deepEqual(toAssistantManagementDto(assistant), {
    name: '小A',
    description: 'Tune 音乐助手',
    welcomeMessage: '欢迎回来',
    persona: '有人味的音乐伙伴',
    systemRules: '只根据可信现场回答',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    revision: 3,
  });
});

test('missing or incomplete local assistant configuration fails closed', async () => {
  await assert.rejects(() => readMusicAssistantConfig(db(null)), /assistant_configuration_unavailable/);
  await assert.rejects(() => readMusicAssistantConfig(db({ ...row, system_rules: '' })), /assistant_configuration_unavailable/);
  await assert.rejects(() => readMusicAssistantConfig(db({ ...row, provider: 'bogus' })), /assistant_configuration_unavailable/);
  await assert.rejects(() => readMusicAssistantConfig(db({ ...row, model: '' })), /assistant_configuration_unavailable/);
  await assert.rejects(() => readMusicAssistantConfig(db({ ...row, temperature: 3 })), /assistant_configuration_unavailable/);
});
