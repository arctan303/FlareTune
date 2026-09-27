import { createToolResult } from './toolResult.js';

const ROAM_LANGUAGES = ['all', 'zh', 'en', 'ja', 'ko', 'instrumental', 'other'];
const LANGUAGE_LABELS = {
  all: '全库',
  zh: '华语',
  en: '欧美',
  ja: '日文',
  ko: '韩语',
  instrumental: '纯音乐',
  other: '其他语种',
};

// 浏览器侧没有回执通道，措辞必须停留在「已下发指令」，不得声称已经生效。
const instructionResult = ({ action, language }) => {
  const label = action === 'enable'
    ? `开启【${LANGUAGE_LABELS[language] || language}】随机漫游`
    : '关闭随机漫游';
  return createToolResult({
    modelText: `已下发${label}的指令，浏览器执行结果未知，是否生效待确认。`,
    summary: `播放器指令已生成：${label}`,
    eventData: {
      type: 'client_action',
      ok: true,
      action,
      ...(action === 'enable' ? { language } : {}),
      instruction_status: 'generated',
      browser_execution: 'unknown',
    },
    playerAction: {
      type: 'roam',
      action,
      ...(action === 'enable' ? { language } : {}),
    },
  });
};

export const roamControlTool = {
  name: 'roam_control',
  displayName: '随机漫游开关',
  description: '开启或关闭当前播放器的「随机漫游」（播放队列接近结束时自动补充同类歌曲），开启时可指定语种范围。工具只生成播放器指令，浏览器执行结果未知。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['enable', 'disable'],
        description: '动作类型：enable（开启随机漫游）、disable（关闭随机漫游）。',
      },
      language: {
        type: 'string',
        enum: ROAM_LANGUAGES,
        description: '漫游语种范围，仅 action=enable 时生效，默认 all（全库）。可选：all（全库）、zh（华语）、en（英语）、ja（日语）、ko（韩语）、instrumental（纯音乐）、other（其他语种）。',
      },
    },
    required: ['action'],
  },
  async execute(args) {
    const action = String(args?.action || '').trim().toLowerCase();
    if (!['enable', 'disable'].includes(action)) {
      return createToolResult({
        modelText: '随机漫游动作参数无效，仅支持 enable、disable。',
        summary: '随机漫游参数无效',
        eventData: { type: 'client_action', ok: false, error: { code: 'invalid_arguments' } },
        playerAction: null,
      });
    }

    if (action === 'disable') return instructionResult({ action });

    const rawLanguage = typeof args?.language === 'string' ? args.language.trim().toLowerCase() : '';
    const language = rawLanguage || 'all';
    if (!ROAM_LANGUAGES.includes(language)) {
      return createToolResult({
        modelText: '指定的漫游语种不支持，可选：all、zh、en、ja、ko、instrumental、other。',
        summary: '漫游语种参数无效',
        eventData: { type: 'client_action', ok: false, error: { code: 'invalid_language' } },
        playerAction: null,
      });
    }

    return instructionResult({ action, language });
  },
};
