import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceFolder, resolveDeviceLanguage } from './deviceFolderLanguage.js';

test('device language mapping applies only to the chosen directory', () => {
  const instrumental = { path: 'music/ambient/Track.mp3', common: { title: 'Track', artist: 'Artist' } };
  const chinese = { path: 'music/zh/另一首.mp3', common: { title: '另一首' } };
  assert.equal(deviceFolder(instrumental.path), 'music/ambient');
  assert.deepEqual(resolveDeviceLanguage(instrumental, { 'music/ambient': 'instrumental' }), {
    code: 'instrumental', source: 'folder', reason: '目录 music/ambient 人工映射',
  });
  assert.equal(resolveDeviceLanguage(chinese, { 'music/ambient': 'instrumental' }).code, 'zh');
});

test('automatic choice ignores the folder name and uses song metadata', () => {
  const file = { path: 'music/zh/English Song.mp3', common: { title: 'English Song', language: 'en' } };
  assert.equal(resolveDeviceLanguage(file).code, 'zh');
  assert.deepEqual(resolveDeviceLanguage(file, { 'music/zh': 'auto' }), {
    code: 'en', source: 'tag', reason: '音频语言标签',
  });
  assert.equal(deviceFolder('music/Direct.mp3'), 'music');
});
