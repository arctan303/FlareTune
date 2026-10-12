import React from 'react';
import { t } from '../i18n/index.js';
import { DEFAULT_LYRIC_SOURCES, LYRIC_SOURCE_LABELS } from '../../../shared/lyricSources.js';
import Section from './SettingsSection.jsx';
import SettingsEditDialog from './SettingsEditDialog.jsx';
import { SettingsButton, SettingsActions, SettingsToggle } from './SettingsControls.jsx';
import { SettingsInput } from './SettingsReadOnly.jsx';
import SelectControl from './SelectControl.jsx';
import { putAdminSetting, adminErrorMessage } from '../instance/adminApi.js';
import { ALL_LANGUAGES, getLanguageLabel } from '../constants/language.js';

const inputClass = 'w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3.5 py-2.5 text-xs text-[var(--ink)] outline-none focus:border-[var(--accent)] transition-colors';
export default function LyricSourcesSettings({ setting, csrfToken, onSaved }) {
  const current = setting || { value: DEFAULT_LYRIC_SOURCES, revision: 0 };
  const [draft, setDraft] = React.useState(null);
  const [revision, setRevision] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const change = (id, key, value) => setDraft(previous => ({ ...previous, [id]: { ...previous[id], [key]: value } }));
  const close = () => { if (!busy) { setDraft(null); setMessage(''); } };
  async function save(event) {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      const result = await putAdminSetting('lyrics.sources', draft, revision, csrfToken);
      onSaved(result); setDraft(null);
    } catch (error) { setMessage(adminErrorMessage(error)); }
    finally { setBusy(false); }
  }
  const enabled = Object.entries(current.value).filter(([, source]) => source.enabled).map(([id]) => t(LYRIC_SOURCE_LABELS[id]));
  return <>
    <Section title={t('歌词源')}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="min-w-0 text-sm text-[var(--ink)]">{enabled.join(' · ') || t('未启用歌词源')}</p>
        <SettingsButton onClick={() => { setDraft(structuredClone(current.value)); setRevision(current.revision); setMessage(''); }}>{t('配置歌词源')}</SettingsButton>
      </div>
    </Section>
    {draft && <SettingsEditDialog title={t('配置歌词源')} busy={busy} message={message} onClose={close}>
      <form onSubmit={save} className="space-y-6">
        {Object.entries(draft).map(([id, source]) => <div key={id} className="space-y-3">
          <SettingsToggle label={t(LYRIC_SOURCE_LABELS[id])} checked={source.enabled} disabled={busy} onChange={event => change(id, 'enabled', event.target.checked)} />
          {(id === 'lrclib' ? ['baseUrl'] : ['searchUrl', 'downloadUrl']).map(field => <label key={field} className="block space-y-1.5 text-xs text-[var(--ink)]">
            <span className="font-semibold">{t(field === 'baseUrl' ? '服务地址' : field === 'searchUrl' ? '搜索接口地址' : '下载接口地址')}</span>
            <SettingsInput className={inputClass} type="url" maxLength={2048} required={source.enabled} disabled={busy} value={source[field]} placeholder={id === 'lrclib' ? 'https://lrclib.net/api' : `https://lyrics.example.com/${field === 'searchUrl' ? 'search' : 'download'}`} onChange={event => change(id, field, event.target.value)} />
          </label>)}
          {id !== 'lrclib' && <label className="block space-y-1.5 text-xs text-[var(--ink)]">
            <span className="font-semibold">{t('来源译文语言')}</span>
            <SelectControl className={inputClass} value={source.translationLanguage} disabled={busy} onChange={event => change(id, 'translationLanguage', event.target.value)}>
              {ALL_LANGUAGES.filter(language => !['instrumental', 'other'].includes(language.code)).map(language => <option key={language.code} value={language.code}>{getLanguageLabel(language.code)}</option>)}
            </SelectControl>
          </label>}
        </div>)}
        <p className="text-xs leading-relaxed text-[var(--muted)]">{t('自定义接口须符合歌词源协议，仅支持 HTTPS 地址。')}</p>
        <SettingsActions><SettingsButton onClick={close} disabled={busy}>{t('取消')}</SettingsButton><SettingsButton type="submit" variant="primary" disabled={busy}>{t(busy ? '正在保存…' : '保存')}</SettingsButton></SettingsActions>
      </form>
    </SettingsEditDialog>}
  </>;
}
