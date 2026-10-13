import React from 'react';
import { t } from '../i18n/index.js';
import { DEFAULT_LYRIC_CHANNELS, MAX_LYRIC_SOURCES, normalizeLyricChannels } from '../../../shared/lyricSources.js';
import Section from './SettingsSection.jsx';
import SettingsEditDialog from './SettingsEditDialog.jsx';
import { SettingsButton, SettingsActions, SettingsToggle } from './SettingsControls.jsx';
import { SettingsInput, SettingsTextarea, useSettingsReadOnly } from './SettingsReadOnly.jsx';
import SelectControl from './SelectControl.jsx';
import { putAdminSetting, adminErrorMessage } from '../instance/adminApi.js';
import { ALL_LANGUAGES, getLanguageLabel } from '../constants/language.js';

const inputClass = 'w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]';
const cardClass = 'wallpaper-content-surface rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4 space-y-3';
const protocols = { custom_krc: '逐字协议', custom_lrc: '逐行协议' };

export default function LyricSourcesSettings({ setting, csrfToken, onSaved }) {
  const current = setting || { value: DEFAULT_LYRIC_CHANNELS, revision: 0 };
  const value = React.useMemo(() => normalizeLyricChannels(current.value, { migrateLegacy: true }), [current.value]);
  const readOnly = useSettingsReadOnly();
  const [editor, setEditor] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState('');
  function open(source = null) {
    setMessage('');
    setEditor({ isNew: !source, revision: current.revision, snapshot: structuredClone(value),
      value: source ? { ...source } : { id: 'lyric_' + crypto.randomUUID().replaceAll('-', ''), name: '', note: '',
        protocol: 'custom_krc', enabled: true, searchUrl: '', downloadUrl: '', translationLanguage: 'zh' } });
  }
  const close = () => { if (!busy) { setEditor(null); setMessage(''); } };
  const change = (key, next) => setEditor(previous => ({ ...previous, value: { ...previous.value, [key]: next } }));
  async function persist(next, revision, closeEditor = false) {
    if (readOnly || busy) return;
    setBusy(true); setMessage('');
    try {
      const result = await putAdminSetting('lyrics.sources', next, revision, csrfToken);
      onSaved(result);
      if (closeEditor) setEditor(null);
    } catch (error) { setMessage(adminErrorMessage(error)); }
    finally { setBusy(false); }
  }
  function save(event) {
    event.preventDefault();
    const sources = editor.isNew ? [...editor.snapshot.sources, editor.value]
      : editor.snapshot.sources.map(source => source.id === editor.value.id ? editor.value : source);
    return persist({ version: 2, sources }, editor.revision, true);
  }
  function remove(source) {
    if (readOnly || busy || !window.confirm(t('移除“{p0}”歌词源？已保存的歌词不会删除。', { p0: source.name }))) return;
    return persist({ version: 2, sources: value.sources.filter(item => item.id !== source.id) }, current.revision);
  }
  return <>
    <Section title={t('歌词源')} action={<SettingsButton variant="primary" disabled={busy || value.sources.length >= MAX_LYRIC_SOURCES} onClick={() => open()}>{t('添加源')}</SettingsButton>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className={cardClass}>
          <strong className="block text-sm text-[var(--ink)]">LRCLIB</strong>
          <p className="text-xs text-[var(--muted)]">{t('内置')}</p>
        </div>
        {value.sources.map(source => <div key={source.id} className={cardClass}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <strong className="min-w-0 break-words text-sm text-[var(--ink)]">{source.name}</strong>
            <SettingsActions>
              <SettingsButton aria-label={t('编辑') + ' ' + source.name} disabled={busy} onClick={() => open(source)}>{t('编辑')}</SettingsButton>
              <SettingsButton variant="danger" aria-label={t('删除') + ' ' + source.name} disabled={busy} onClick={() => void remove(source)}>{t('删除')}</SettingsButton>
            </SettingsActions>
          </div>
          <p className="text-xs text-[var(--muted)]">{t(protocols[source.protocol])}</p>
          {source.note && <p className="break-words text-xs text-[var(--muted)]">{t('备注')}：{source.note}</p>}
          <SettingsToggle aria-label={source.name} label={t(source.enabled ? '已启用' : '未启用')} checked={source.enabled} disabled={busy}
            onChange={event => void persist({ version: 2, sources: value.sources.map(item => item.id === source.id ? { ...source, enabled: event.target.checked } : item) }, current.revision)} />
        </div>)}
      </div>
      {value.sources.length >= MAX_LYRIC_SOURCES && <p className="mt-3 text-xs text-[var(--muted)]">{t('最多添加 {count} 个歌词源。', { count: MAX_LYRIC_SOURCES })}</p>}
      {!editor && message && <p role="alert" className="mt-3 text-sm text-rose-600">{t(message)}</p>}
      {!editor && busy && <p role="status" className="mt-3 text-xs text-[var(--muted)]">{t('正在保存…')}</p>}
    </Section>
    {editor && <SettingsEditDialog title={editor.isNew ? t('添加源') : t('配置{p0}', { p0: editor.value.name })} busy={busy} message={message} onClose={close} size="medium">
      <form onSubmit={save} className="space-y-4">
        <label className="block space-y-1.5 text-xs font-semibold"><span>{t('名称')}</span>
          <SettingsInput className={inputClass} required maxLength={80} disabled={busy} value={editor.value.name} onChange={event => change('name', event.target.value)} />
        </label>
        <label className="block space-y-1.5 text-xs font-semibold"><span>{t('备注')}</span>
          <SettingsTextarea className={inputClass} rows={2} maxLength={500} disabled={busy} value={editor.value.note} onChange={event => change('note', event.target.value)} />
        </label>
        {editor.isNew ? <label className="block space-y-1.5 text-xs font-semibold"><span>{t('协议')}</span>
          <SelectControl aria-label={t('协议')} className={inputClass} value={editor.value.protocol} disabled={busy} allowInReadOnly onChange={event => change('protocol', event.target.value)}>
            {Object.entries(protocols).map(([id, label]) => <option key={id} value={id}>{t(label)}</option>)}
          </SelectControl>
        </label> : <p className="text-xs text-[var(--muted)]">{t('协议')}：{t(protocols[editor.value.protocol])}</p>}
        {['searchUrl', 'downloadUrl'].map(field => <label key={field} className="block space-y-1.5 text-xs text-[var(--ink)]">
          <span className="font-semibold">{t(field === 'searchUrl' ? '搜索接口地址' : '下载接口地址')}</span>
          <SettingsInput className={inputClass} type="url" maxLength={2048} required={editor.isNew || editor.value.enabled} disabled={busy} value={editor.value[field]}
            placeholder={'https://lyrics.example.com/' + (field === 'searchUrl' ? 'search' : 'download')} onChange={event => change(field, event.target.value)} />
        </label>)}
        <label className="block space-y-1.5 text-xs text-[var(--ink)]"><span className="font-semibold">{t('来源译文语言')}</span>
          <SelectControl aria-label={t('来源译文语言')} className={inputClass} value={editor.value.translationLanguage} disabled={busy} onChange={event => change('translationLanguage', event.target.value)}>
            {ALL_LANGUAGES.filter(language => !['instrumental', 'other'].includes(language.code)).map(language => <option key={language.code} value={language.code}>{getLanguageLabel(language.code)}</option>)}
          </SelectControl>
        </label>
        <p className="text-xs leading-relaxed text-[var(--muted)]">{t('自定义接口须符合歌词源协议，仅支持 HTTPS 地址。')}</p>
        <SettingsActions className="pt-2 border-t border-[var(--line)]"><SettingsButton closeDialog disabled={busy}>{t('取消')}</SettingsButton><SettingsButton type="submit" variant="primary" disabled={busy}>{t(busy ? '正在保存…' : '保存')}</SettingsButton></SettingsActions>
      </form>
    </SettingsEditDialog>}
  </>;
}
