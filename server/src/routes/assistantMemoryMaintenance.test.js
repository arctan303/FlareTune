import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './localAssistant.fixture.js';
import { saveAssistantMemory, mergeAssistantMemories, deleteAssistantMemory } from '../services/assistantMemory.js';
import { assistantMemoryTool } from '../tools/assistantMemory.js';

test('assistant list/delete/merge release capacity and protect disabled, foreign and manually edited records', async () => {
  const { sqlite, db, route } = fixture();
  try {
    await route('/api/ai/memory', 'PATCH', { enabled: true });
    const context = { db, accountId: 'account-A' };
    const records = [];
    for (let index = 0; index < 30; index++) records.push((await saveAssistantMemory(db, 'account-A',
      { content: `稳定偏好 ${index}`, source: 'stated', actor: 'assistant' })).memory);
    const listed = await assistantMemoryTool.execute({ action: 'list' }, context);
    assert.equal(JSON.parse(listed.modelText).memories.length, 30);
    assert.equal((await assistantMemoryTool.execute({ action: 'save', content: '第31条', source: 'stated' }, context)).eventData.ok, false);
    await mergeAssistantMemories(db, 'account-A', { id: records[0].id,
      merge_ids: [records[1].id, records[2].id], content: '合并稳定偏好', source: 'stated' });
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM assistant_memories').get().count, 28);
    await saveAssistantMemory(db, 'account-A', { content: '新的稳定偏好', source: 'stated', actor: 'assistant' });
    assert.equal((await assistantMemoryTool.execute({ action: 'delete', id: records[3].id }, context)).eventData.action, 'deleted');
    const manual = (await saveAssistantMemory(db, 'account-A', { content: '用户手动编辑' })).memory;
    await assert.rejects(deleteAssistantMemory(db, 'account-A', manual.id, { actor: 'assistant' }), /memory_not_found/);
    const foreign = (await saveAssistantMemory(db, 'account-B', { content: '其他账号' })).memory;
    const before = sqlite.prepare('SELECT content FROM assistant_memories WHERE id=?').get(records[0].id).content;
    for (const invalidId of [manual.id, foreign.id, crypto.randomUUID()]) {
      await assert.rejects(mergeAssistantMemories(db, 'account-A', { id: records[0].id,
        merge_ids: [records[4].id, invalidId], content: '不能部分更新', source: 'stated' }), /memory_not_found/);
      assert.equal(sqlite.prepare('SELECT content FROM assistant_memories WHERE id=?').get(records[0].id).content, before);
      assert.ok(sqlite.prepare('SELECT id FROM assistant_memories WHERE id=?').get(records[4].id));
    }
    await route('/api/ai/memory', 'PATCH', { enabled: false });
    for (const args of [{ action: 'list' }, { action: 'delete', id: records[0].id },
      { action: 'merge', id: records[0].id, merge_ids: [records[4].id], content: '禁止', source: 'stated' }]) {
      assert.equal((await assistantMemoryTool.execute(args, context)).eventData.error.code, 'memory_disabled');
    }
    assert.ok(sqlite.prepare('SELECT id FROM assistant_memories WHERE id=?').get(records[0].id));
  } finally { sqlite.close(); }
});
