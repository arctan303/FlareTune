import React from 'react';
import { t } from '../i18n/index.js';
import { DEFAULT_LYRIC_SOURCES, LYRIC_SOURCE_LABELS } from '../../../shared/lyricSources.js';
import Section from './SettingsSection.jsx';
import SettingsEditDialog from './SettingsEditDialog.jsx';
import { SettingsButton, SettingsActions, SettingsToggle } from './SettingsControls.jsx';
import { SettingsInput, useSettingsReadOnly } from './SettingsReadOnly.jsx';
import SelectControl from './SelectControl.jsx';
import { putAdminSetting, adminErrorMessage } from '../instance/adminApi.js';
import { ALL_LANGUAGES, getLanguageLabel } from '../constants/language.js';

const inputClass = 'w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]';
const cardClass = 'wallpaper-content-surface rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4 space-y-3';
const customIds = Object.keys(DEFAULT_LYRIC_SOURCES).filter(id => id !== 'lrclib');
const configured = source => Boolean(source.enabled || source.searchUrl || source.downloadUrl);

export default function LyricSourcesSettings({ setting, csrfToken, onSaved }) {
  const current = setting || { value: DEFAULT_LYRIC_SOURCES, revision: 0 };
  const readOnly = useSettingsReadOnly();
  const [editor, setEditor] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const added = customIds.filter(id => configured(current.value[id]));
  const available = customIds.filter(id => !configured(current.value[id]));
  function open(id, isNew = false) {
    setMessage('');
    setEditor({ id, isNew, revision: current.revision, snapshot: structuredClone(current.value),
      value: { ...current.value[id], ...(isNew ? { enabled: true } : {}) } });
  }
  const close = () => { if (!busy) { setEditor(null); setMessage(''); } };
  const change = (key, value) => setEditor(previous => ({ ...previous, value: { ...previous.value, [key]: value } }));
  async function persist(value, revision, closeEditor = false) {
    if (readOnly || busy) return;
    setBusy(true); setMessage('');
    try {
      const result = await putAdminSetting('lyrics.sources', value, revision, csrfToken);
      onSaved(result);
      if (closeEditor) setEditor(null);
    } catch (error) { setMessage(adminErrorMessage(error)); }
    finally { setBusy(false); }
  }
  function save(event) {
    event.preventDefault();
    return persist({ ...editor.snapshot, [editor.id]: editor.value }, editor.revision, true);
  }
  function remove(id) {
    if (readOnly || busy || !window.confirm(t('移除“{p0}”渠道？已保存的歌词不会删除。', { p0: t(LYRIC_SOURCE_LABELS[id]) }))) return;
    return persist({ ...current.value, [id]: { ...DEFAULT_LYRIC_SOURCES[id] } }, current.revision);
  }
  function card(id) {
    const source = current.value[id], label = t(LYRIC_SOURCE_LABELS[id]);
    return <div key={id} className={cardClass}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <strong className="min-w-0 break-words text-sm text-[var(--ink)]">{label}</strong>
        <SettingsActions>
          <SettingsButton aria-label={`${t('编辑')} ${label}`} disabled={busy} onClick={() => open(id)}>{t('编辑')}</SettingsButton>
          {id !== 'lrclib' && <SettingsButton variant="danger" aria-label={`${t('删除')} ${label}`} disabled={busy} onClick={() => void remove(id)}>{t('删除')}</SettingsButton>}
        </SettingsActions>
      </div>
      <SettingsToggle aria-label={label} label={t(source.enabled ? '已启用' : '未启用')} checked={source.enabled} disabled={busy}
        onChange={event => void persist({ ...current.value, [id]: { ...source, enabled: event.target.checked } }, current.revision)} />
    </div>;
  }
  return <>
    <Section title={t('歌词源')} action={<SettingsButton variant="primary" disabled={busy || !available.length} onClick={() => open(available[0], true)}>{t('添加自定义渠道')}</SettingsButton>}>
      <div className="space-y-5">
        <div className="space-y-3">
          <h3 className="text-xs font-semibold text-[var(--muted)]">{t('默认渠道')}</h3>
          <div className="grid gap-3 sm:grid-cols-2">{card('lrclib')}</div>
        </div>
        <div className="space-y-3">
          <h3 className="text-xs font-semibold text-[var(--muted)]">{t('自定义渠道')}</h3>
          {added.length ? <div className="grid gap-3 sm:grid-cols-2">{added.map(card)}</div>
            : <p className="text-xs text-[var(--muted)]">{t('尚未添加自定义渠道。')}</p>}
        </div>
      </div>
      {!editor && message && <p role="alert" className="mt-3 text-sm text-rose-600">{t(message)}</p>}
      {!editor && busy && <p role="status" className="mt-3 text-xs text-[var(--muted)]">{t('正在保存…')}</p>}
    </Section>
    {editor && <SettingsEditDialog title={editor.isNew ? t('添加自定义渠道') : t('配置{p0}', { p0: t(LYRIC_SOURCE_LABELS[editor.id]) })} busy={busy} message={message} onClose={close} size="medium">
      <form onSubmit={save} className="space-y-4">
        {editor.isNew && <label className="block space-y-1.5 text-xs font-semibold">
          {t('接入方案')}
          <SelectControl aria-label={t('接入方案')} className={inputClass} value={editor.id} disabled={busy} allowInReadOnly
            onChange={event => setEditor(previous => ({ ...previous, id: event.target.value, value: { ...DEFAULT_LYRIC_SOURCES[event.target.value], enabled: true } }))}>
            {customIds.filter(id => !configured(editor.snapshot[id])).map(id => <option key={id} value={id}>{t(LYRIC_SOURCE_LABELS[id])}</option>)}
          </SelectControl>
        </label>}
        <SettingsToggle label={t(LYRIC_SOURCE_LABELS[editor.id])} checked={editor.value.enabled} disabled={busy} onChange={event => change('enabled', event.target.checked)} />
        {(editor.id === 'lrclib' ? ['baseUrl'] : ['searchUrl', 'downloadUrl']).map(field => <label key={field} className="block space-y-1.5 text-xs text-[var(--ink)]">
          <span className="font-semibold">{t(field === 'baseUrl' ? '服务地址' : field === 'searchUrl' ? '搜索接口地址' : '下载接口地址')}</span>
          <SettingsInput className={inputClass} type="url" maxLength={2048} required={editor.isNew || editor.value.enabled} disabled={busy} value={editor.value[field]}
            placeholder={editor.id === 'lrclib' ? 'https://lrclib.net/api' : `https://lyrics.example.com/${field === 'searchUrl' ? 'search' : 'download'}`}
            onChange={event => change(field, event.target.value)} />
        </label>)}
        {editor.id !== 'lrclib' && <>
          <label className="block space-y-1.5 text-xs text-[var(--ink)]">
            <span className="font-semibold">{t('来源译文语言')}</span>
            <SelectControl aria-label={t('来源译文语言')} className={inputClass} value={editor.value.translationLanguage} disabled={busy} onChange={event => change('translationLanguage', event.target.value)}>
              {ALL_LANGUAGES.filter(language => !['instrumental', 'other'].includes(language.code)).map(language => <option key={language.code} value={language.code}>{getLanguageLabel(language.code)}</option>)}
            </SelectControl>
          </label>
          <p className="text-xs leading-relaxed text-[var(--muted)]">{t('自定义接口须符合歌词源协议，仅支持 HTTPS 地址。')}</p>
        </>}
        <SettingsActions className="pt-2 border-t border-[var(--line)]"><SettingsButton closeDialog disabled={busy}>{t('取消')}</SettingsButton><SettingsButton type="submit" variant="primary" disabled={busy}>{t(busy ? '正在保存…' : '保存')}</SettingsButton></SettingsActions>
      </form>
    </SettingsEditDialog>}
  </>;
}
