import { saveAssistantMemory, MemoryError } from '../services/assistantMemory.js';
import { createToolFailure, createToolResult } from './toolResult.js';

export const assistantMemoryTool = {
  name: 'remember_user',
  displayName: '记忆',
  description: '开启记忆后，自主保存值得跨会话记住的当前听众信息，或用已提供的记忆 ID 修正旧推测。可依据听众陈述或当前账号的真实收听统计合理推断；推断必须标注 inferred，不能编造、保存凭据或覆盖用户手动修改的记忆。无需为了保存记忆额外询问听众。',
  parameters: { type: 'object', properties: {
    content: { type: 'string', maxLength: 240, description: '简短、具体、可在未来对话使用的记忆。推断用可能/似乎等措辞。' },
    source: { type: 'string', enum: ['stated', 'inferred'], description: '用户明确陈述为 stated；由收听信息推断为 inferred。' },
    id: { type: 'string', description: '修正已有记忆时提供精确 ID；新记忆省略。' },
  }, required: ['content', 'source'] },
  async execute(args, context = {}) {
    try {
      const result = await saveAssistantMemory(context.db, context.accountId, {
        id: args.id, content: args.content, source: args.source, actor: 'assistant',
      });
      return createToolResult({ modelText: result.action === 'unchanged' ? '这条记忆已经存在，无需重复记录。'
        : `记忆已${result.action === 'created' ? '保存' : '更新'}。`,
      summary: result.action === 'unchanged' ? '记忆已存在' : '已记住',
      eventData: { ok: true, type: 'assistant_memory', ...result } });
    } catch (error) {
      const code = error instanceof MemoryError ? error.code : 'storage_unavailable';
      return createToolFailure({ modelText: '这条记忆未保存，请不要声称已经记住。',
        summary: '记忆未保存', type: 'assistant_memory', code,
        message: code });
    }
  },
};
