import test from 'node:test';
import assert from 'node:assert/strict';
import { currentTimeTool } from './currentTime.js';
import { buildUnifiedAiSystemPrompt } from '../utils/unifiedAiSystemPrompt.js';

test('current_time uses the same stable time contract', async () => {
  const now = new Date('2026-08-24T00:00:00.000Z');
  const singapore = await currentTimeTool.execute({}, { now });
  assert.deepEqual(
    { zone: singapore.eventData.time_zone, date: singapore.eventData.date, time: singapore.eventData.time, offset: singapore.eventData.utc_offset },
    { zone: 'Asia/Singapore', date: '2026-08-24', time: '08:00:00', offset: '+08:00' },
  );
  const invalid = await currentTimeTool.execute({ timezone: 'Mars/Olympus' }, { now });
  assert.equal(invalid.eventData.error.code, 'invalid_timezone');
});

test('current_time defaults to the listener browser time zone when available', async () => {
  const result = await currentTimeTool.execute({}, {
    now: new Date('2026-09-24T12:00:00.000Z'), timeZone: 'Europe/London',
  });
  assert.equal(result.eventData.time_zone, 'Europe/London');
  assert.equal(result.eventData.time, '13:00:00');
});

test('unified prompt exposes facts without administrator behavior branches', () => {
  const prompt = buildUnifiedAiSystemPrompt({
    persona: 'PERSONA_MARKER', systemRules: 'GLOBAL_RULES_MARKER',
    siteName: 'FlareTune', siteUrl: 'flaretune.local', location: '/', playback: '无',
    currentUser: { subject: 'u1', name: '站长', role: 'admin' },
    availableTools: [{ type: 'function', function: {
      name: currentTimeTool.name,
      description: currentTimeTool.description,
      parameters: currentTimeTool.parameters,
    } }],
  });
  const indices = ['[助手 Persona]', '[全局系统准则]', '[当前用户事实]', '[当前站点与现场]', '[本轮实际注册工具]'].map((part) => prompt.indexOf(part));
  assert.deepEqual(indices, [...indices].sort((a, b) => a - b));
  assert.match(prompt, /- role: admin/);
  assert.doesNotMatch(prompt, /无需客套|尊重站长的指令与主权/);
  assert.match(prompt, /current_time/);
});
