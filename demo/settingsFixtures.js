// Public, fictional examples. No credentials or real deployment/account data.
export const demoUser = (uiLanguage = 'auto') => ({ accountId: 'browser-demo', username: 'demo', displayName: 'Demo', role: 'admin', uiLanguage });
const assistant = { name: '小A', avatar_icon: 'Sparkles', welcome_message: '你好，我是小A。想听什么？',
  description: '音乐助手', persona: '帮助你探索音乐、管理歌单。', system_rules: '根据当前曲库提供音乐建议。', temperature: .7, revision: 1 };
const lyrics = { targetLanguage: 'zh', temperature: .2, styleRules: '', completionEnabled: true,
  automaticCompletionEnabled: false, cleanDirtyLyrics: true, translateLyrics: true, detectLanguage: true, referenceExistingTranslation: true };
const item = value => ({ value, revision: 1 });
export function settingsFixture(path) {
  const fixtures = {
    '/api/admin/settings': { settings: { 'instance.name': item('FlareTune · Demo'), 'cors.allowed_origins': item([]),
      'assistant.images_enabled': item(false), 'lyrics.ai': item(lyrics) }, assistant, defaults: { assistant, lyrics } },
    '/api/admin/accounts': { accounts: [{ ...demoUser(), status: 'active', updatedAt: 1 },
      { accountId: 'demo-member', username: 'listener', displayName: 'Listener', role: 'member', status: 'active', updatedAt: 1 }] },
    '/api/admin/system/migration': { state: 'ready', schemaVersion: 2, targetVersion: 2, supplementalPending: false,
      supplementalMigrations: ['ai_protocols','user_images','ai_feature_models','google_login'].map(id => ({ id, ready: true })) },
    '/api/admin/ai/providers': { ready: true, credentialReady: true,
      providers: [{ id: 'demo-provider', name: 'DeepSeek · Demo', source: 'deepseek', hasKey: true, revision: 1 }],
      features: Object.fromEntries(['assistant','lyrics'].map(feature => [feature, {
        providerId: 'demo-provider', model: 'deepseek-chat', supportsImages: false, revision: 1 }])) },
    '/api/admin/google': { ready: true, enabled: false, clientId: '', secretConfigured: false, secretReady: false, revision: 1, callbackOrigin: 'https://flaretune.arcinks.com' },
    '/api/account/google': { ready: true, bound: false, configured: false },
    '/api/account/subsonic': { enabled: false, revision: 1 },
  };
  return fixtures[path] ? structuredClone(fixtures[path]) : undefined;
}

const replies = {
  zh: '这是 Demo 的固定示例回复，不会调用 AI 模型。你可以播放曲库里的歌曲、收藏音乐和创建本地歌单。正式部署后，助手可以根据你的消息推荐音乐、控制播放并管理歌单。',
  'zh-Hant': '這是 Demo 的固定範例回覆，不會呼叫 AI 模型。你可以播放曲庫裡的歌曲、收藏音樂及建立本機歌單。正式部署後，助手可以根據你的訊息推薦音樂、控制播放並管理歌單。',
  en: 'This is a fixed demo reply; no AI model is called. You can play songs, save favorites and create local playlists. In your own deployment, the assistant can recommend music based on your messages, control playback and manage playlists.',
  ja: 'これはデモの固定返信です。AI モデルは呼び出しません。曲の再生、お気に入りへの追加、ローカルプレイリストの作成を体験できます。ご自身の環境では、メッセージに応じた音楽の推薦、再生操作、プレイリスト管理が可能です。',
  ko: '이것은 데모의 고정 답변이며 AI 모델을 호출하지 않습니다. 음악 재생, 즐겨찾기, 로컬 재생목록 만들기를 체험할 수 있습니다. 직접 배포하면 메시지에 따른 음악 추천, 재생 제어, 재생목록 관리가 가능합니다.',
  es: 'Esta es una respuesta fija de demostración; no se llama a ningún modelo de IA. Puedes reproducir música, guardar favoritos y crear listas locales. En tu propia instalación, el asistente puede recomendar música según tus mensajes, controlar la reproducción y gestionar listas.',
  fr: 'Ceci est une réponse de démonstration fixe ; aucun modèle d’IA n’est appelé. Vous pouvez écouter des titres, enregistrer des favoris et créer des playlists locales. Dans votre propre installation, l’assistant peut recommander de la musique selon vos messages, contrôler la lecture et gérer les playlists.',
  de: 'Dies ist eine feste Demo-Antwort; es wird kein KI-Modell aufgerufen. Du kannst Musik abspielen, Favoriten speichern und lokale Playlists erstellen. In deiner eigenen Installation kann der Assistent passend zu deinen Nachrichten Musik empfehlen, die Wiedergabe steuern und Playlists verwalten.',
  'pt-BR': 'Esta é uma resposta fixa de demonstração; nenhum modelo de IA é chamado. Você pode ouvir músicas, salvar favoritos e criar playlists locais. Na sua própria instalação, o assistente pode recomendar músicas com base nas suas mensagens, controlar a reprodução e gerenciar playlists.',
};
export const fixedAssistantReply = language => replies[language] || replies.en;
