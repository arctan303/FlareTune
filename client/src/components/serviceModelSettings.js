export const serviceModelMessages = Object.freeze({
  zh: { title: 'AI 模型', update: '需要完成插件更新。管理员完成更新后才可使用 AI。', initialize: '完成插件更新', unavailable: 'AI 网关不可用，请安装或更新 AI 网关。', missing: '已保存的供应商不存在，请重新选择。', unconfigured: '尚未配置 AI 模型，请选择供应商和模型并保存。', invalid: 'AI 模型配置已失效，请重新选择并保存。', temperature: '温度（留空使用系统默认值 0.2）' },
  'zh-Hant': { title: 'AI 模型', update: '需要完成外掛更新。管理員完成更新後才能使用 AI。', initialize: '完成外掛更新', unavailable: 'AI 閘道無法使用，請安裝或更新 AI 閘道。', missing: '已儲存的供應商不存在，請重新選擇。', unconfigured: '尚未設定 AI 模型，請選擇供應商和模型並儲存。', invalid: 'AI 模型設定已失效，請重新選擇並儲存。', temperature: '溫度（留空使用系統預設值 0.2）' },
  en: { title: 'AI model', update: 'Complete the plugin update before using AI. An administrator must finish this step.', initialize: 'Complete plugin update', unavailable: 'AI gateway is unavailable. Install or update AI gateway.', missing: 'The saved provider no longer exists. Select a provider again.', unconfigured: 'No AI model is configured. Select a provider and model, then save.', invalid: 'The AI model configuration is no longer valid. Select it again and save.', temperature: 'Temperature (leave blank for the system default of 0.2)' },
  ja: { title: 'AI モデル', update: 'AI を使用するには、管理者がプラグインの更新を完了する必要があります。', initialize: 'プラグインの更新を完了', unavailable: 'AI ゲートウェイを利用できません。インストールまたは更新してください。', missing: '保存されたプロバイダーがありません。選択し直してください。', unconfigured: 'AI モデルが未設定です。プロバイダーとモデルを選択して保存してください。', invalid: 'AI モデルの設定が無効になりました。選択し直して保存してください。', temperature: '温度（空欄の場合はシステムの既定値 0.2）' },
  ko: { title: 'AI 모델', update: 'AI를 사용하려면 관리자가 플러그인 업데이트를 완료해야 합니다.', initialize: '플러그인 업데이트 완료', unavailable: 'AI 게이트웨이를 사용할 수 없습니다. 설치하거나 업데이트하세요.', missing: '저장된 공급자가 없습니다. 공급자를 다시 선택하세요.', unconfigured: 'AI 모델이 설정되지 않았습니다. 공급자와 모델을 선택하고 저장하세요.', invalid: 'AI 모델 설정이 더 이상 유효하지 않습니다. 다시 선택하고 저장하세요.', temperature: '온도 (비워 두면 시스템 기본값 0.2 사용)' },
});

export const serviceModelDraft = value => ({ providerId: value?.selection?.providerId ?? '', model: value?.selection?.model || '',
  supportsImages: value?.selection?.supportsImages === true, generationOptions: { ...value?.selection?.generationOptions } });
export function changeServiceModel(draft, field, value) {
  if (!['providerId', 'model'].includes(field)) throw new TypeError('invalid_model_field');
  return { ...draft, [field]: value, ...(value !== draft[field] ? { supportsImages: false } : {}) };
}
export function serviceModelError(error, locale = 'en') {
  const messages = serviceModelMessages[locale] || serviceModelMessages.en;
  const code = error?.code || error?.message;
  if (code === 'PLUGIN_UPDATE_REQUIRED') return messages.update;
  if (code === 'AI_PROVIDER_MISSING') return messages.missing;
  if (code === 'AI_PROVIDER_UNCONFIGURED') return messages.unconfigured;
  if (code === 'AI_CONFIG_INVALID') return messages.invalid;
  if (/^PLUGIN_(?:DEPENDENCY|SERVICE|NOT_INSTALLED|API|VERSION)/u.test(code || '')) return messages.unavailable;
  return null;
}
