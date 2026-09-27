import React from 'react';
import { Bot, Save } from 'lucide-react';

const EDITABLE_FIELDS = [
  {
    key: 'description',
    label: '对外简介',
    rows: 3,
    maxLength: 500,
    hint: '显示在助手入口与介绍区域的简短说明。',
  },
  {
    key: 'welcomeMessage',
    label: '欢迎语',
    rows: 4,
    maxLength: 1000,
    hint: '新对话尚无历史消息时展示。',
  },
  {
    key: 'persona',
    label: '助手人设',
    rows: 9,
    maxLength: 12000,
    hint: '定义小A的身份、语气与协作方式。',
  },
  {
    key: 'systemRules',
    label: '系统准则',
    rows: 12,
    maxLength: 24000,
    hint: '定义必须遵守的行为边界和回答规则。',
  },
];

export default function AdminAssistantSection({
  assistant,
  loading,
  saving,
  onChange,
  onSave,
}) {
  if (loading && !assistant) {
    return <div className="py-16 text-center text-xs text-[var(--muted)]">正在加载助手配置...</div>;
  }

  if (!assistant) {
    return (
      <div className="wallpaper-content-surface rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-8 text-center text-sm text-[var(--muted)]">
        助手配置暂不可用，请刷新后重试。
      </div>
    );
  }

  return (
    <form className="space-y-5" onSubmit={onSave}>
      <div className="wallpaper-content-surface flex flex-wrap items-start justify-between gap-4 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 shadow-xs">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--accent)_12%,var(--surface-raised))] text-[var(--accent-strong)]">
            <Bot size={20} />
          </div>
          <div className="min-w-0">
            <h3 className="text-base font-bold text-[var(--ink)]">{assistant.name || '小A'}</h3>
            <p className="mt-1 text-xs text-[var(--muted)]">
              运行模型 {assistant.provider || '—'} / {assistant.model || '—'} · 修订 {assistant.revision}
            </p>
            <p className="mt-1 text-[11px] text-[var(--faint)]">身份与模型由服务端固定；此处只维护内容配置。</p>
          </div>
        </div>
        <button
          type="submit"
          disabled={saving}
          className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-[var(--accent)] px-4 py-2 text-xs font-semibold text-white shadow-xs transition hover:bg-[var(--accent-strong)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Save size={14} />
          <span>{saving ? '保存中...' : '保存配置'}</span>
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {EDITABLE_FIELDS.map((field) => (
          <label
            key={field.key}
            className={`wallpaper-content-surface rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 shadow-xs ${field.rows >= 9 ? 'xl:col-span-2' : ''}`}
          >
            <span className="block text-sm font-semibold text-[var(--ink)]">{field.label}</span>
            <span className="mb-3 mt-1 block text-[11px] text-[var(--faint)]">{field.hint}</span>
            <textarea
              value={assistant[field.key] || ''}
              rows={field.rows}
              required
              maxLength={field.maxLength}
              onChange={(event) => onChange(field.key, event.target.value)}
              disabled={saving}
              className="w-full resize-y rounded-xl border border-[var(--line)] bg-[var(--surface-raised)] px-3.5 py-3 text-sm leading-relaxed text-[var(--ink)] outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--accent)_18%,transparent)] disabled:opacity-60"
            />
          </label>
        ))}
      </div>
    </form>
  );
}
