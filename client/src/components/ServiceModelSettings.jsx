import React from 'react';
import { t, useLocale } from '../i18n/index.js';
import SettingsSection from './SettingsSection.jsx';
import SettingsEditDialog from './SettingsEditDialog.jsx';
import SelectControl from './SelectControl.jsx';
import { SettingsActions, SettingsButton, SettingsToggle } from './SettingsControls.jsx';
import { SettingsInput, useSettingsReadOnly } from './SettingsReadOnly.jsx';
import { changeServiceModel, serviceModelDraft, serviceModelError, serviceModelMessages } from './serviceModelSettings.js';

// Provider/model interaction shared with Gateway: fetch a bounded list, choose
// from that list or type an ID, then explicitly save with the displayed revision.
export default function ServiceModelSettings({ host }) {
  const locale = useLocale(), labels = serviceModelMessages[locale] || serviceModelMessages.en;
  const readOnly = useSettingsReadOnly();
  const [data, setData] = React.useState(null), [draft, setDraft] = React.useState(null);
  const [error, setError] = React.useState(''), [busy, setBusy] = React.useState(false);
  const [models, setModels] = React.useState([]), [loadingModels, setLoadingModels] = React.useState(false);
  const [listMessage, setListMessage] = React.useState('');
  const generation = React.useRef(0), loadGeneration = React.useRef(0), pendingWrite = React.useRef(false);
  const active = React.useRef(true), modelFieldRef = React.useRef(null);
  const editingRevision = React.useRef(0);
  const current = () => active.current && host.isCurrent();
  const failureText = failure => serviceModelError(failure, locale)
    || t(failure?.status === 409 ? '配置已更新，请刷新后确认再保存。' : '操作未完成，请重试。');
  const load = React.useCallback(async () => {
    const token = ++loadGeneration.current;
    try {
      const result = await host.request('model', { admin: true });
      if (active.current && host.isCurrent() && loadGeneration.current === token) { setData(result); setError(''); }
    } catch (failure) { if (active.current && host.isCurrent() && loadGeneration.current === token) setError(failureText(failure)); }
  }, [host, locale]);
  React.useEffect(() => { active.current = true; setData(null); setDraft(null); void load();
    return () => { active.current = false; generation.current += 1; loadGeneration.current += 1; }; }, [load]);
  const resetModels = () => { generation.current += 1; setModels([]); setLoadingModels(false); setListMessage(''); };
  const open = () => { if (!current() || readOnly) return; editingRevision.current = data.revision;
    resetModels(); setDraft(serviceModelDraft(data.value)); setError(''); };
  const close = () => { if (busy) return; resetModels(); setDraft(null); setError(''); };
  const provider = data?.providers?.find(item => item.id === draft?.providerId);
  const change = (field, value) => { resetModels(); setDraft(previous => changeServiceModel(previous, field, value)); };
  const readModels = async () => {
    if (!current() || !provider || busy || loadingModels) return;
    const token = ++generation.current; setLoadingModels(true); setListMessage('');
    try {
      const result = await host.request('model/models', { admin: true, method: 'POST',
        body: { providerId: provider.id, expectedRevision: provider.revision } });
      if (!current() || generation.current !== token) return;
      setModels(result.models || []);
      if (!result.models?.length || result.hasMore) setListMessage(t('列表为空或未列出全部模型，仍可手动填写模型 ID。'));
    } catch (failure) { if (current() && generation.current === token) setListMessage(failureText(failure)); }
    finally { if (current() && generation.current === token) setLoadingModels(false); }
  };
  const initialize = async () => {
    if (!current() || readOnly || pendingWrite.current) return;
    pendingWrite.current = true; loadGeneration.current += 1; setBusy(true); setError('');
    try {
      const result = await host.request('model/initialize', { admin: true, method: 'POST', body: { expectedRevision: 0 } });
      if (current()) { setData(result); host.notify(t('设置已成功保存。')); }
    } catch (failure) { if (current()) setError(failureText(failure)); }
    finally { pendingWrite.current = false; if (current()) setBusy(false); }
  };
  const save = async event => {
    event.preventDefault(); if (!current() || readOnly || pendingWrite.current) return;
    pendingWrite.current = true; loadGeneration.current += 1; setBusy(true); setError(''); generation.current += 1;
    try {
      const result = await host.request('model', { admin: true, method: 'PUT', body: {
        ...draft, providerId: draft.providerId || null, expectedRevision: editingRevision.current,
        providerRevision: provider?.revision || 0 } });
      if (current()) { setData(result); setDraft(null); resetModels(); host.notify(t('设置已成功保存。')); }
    } catch (failure) { if (current()) setError(failureText(failure)); }
    finally { pendingWrite.current = false; if (current()) setBusy(false); }
  };
  const selection = data?.value?.selection;
  const selectedProvider = data?.providers?.find(item => item.id === selection?.providerId);
  return <SettingsSection title={labels.title} action={data && !data.updateRequired
    ? <SettingsButton disabled={readOnly || busy} onClick={open}>{t('配置方案')}</SettingsButton> : null}>
    {error && !draft && <p role="alert">{error}</p>}
    {!data && <SettingsButton onClick={() => void load()}>{t('重试')}</SettingsButton>}
    {data?.updateRequired ? <div className="space-y-3"><p role="status">{labels.update}</p>
      <SettingsButton disabled={readOnly || busy} onClick={() => void initialize()}>{labels.initialize}</SettingsButton></div>
      : data && <div className="space-y-2 text-sm"><p>{selection ? `${selectedProvider?.name || (selection.providerId ? labels.missing : t('原有部署配置'))} · ${selection.model}` : labels.unconfigured}</p>
        {selection && <p>{t(selection.supportsImages ? '支持视觉' : '仅文本')}</p>}</div>}
    {draft && <SettingsEditDialog title={labels.title} busy={busy} message={error} onClose={close}>
      <form className="space-y-4" onSubmit={save}>
        <label className="block space-y-2">{t('供应商')}
          <SelectControl aria-label={t('供应商')} value={draft.providerId} disabled={readOnly || busy}
            onChange={event => change('providerId', event.target.value)}>
            {data.value?.selection?.providerId === null || data.value?.migration?.deployment
              ? <option value="">{t('原有部署配置')}</option> : <option disabled value="">{t('未设置')}</option>}
            {data.providers.map(item => <option key={item.id} value={item.id}>{item.name || item.source}{!item.hasKey ? ` · ${t('密钥需重新录入')}` : ''}</option>)}
          </SelectControl></label>
        <div className="flex items-center justify-between gap-3"><label htmlFor="service-model-id">{t('模型')}</label>
          <SettingsButton disabled={readOnly || busy || loadingModels || !provider?.hasKey} onClick={() => void readModels()}>
            {t(loadingModels ? '正在获取模型…' : '获取模型')}</SettingsButton></div>
        <div ref={modelFieldRef} className="model-input"><SettingsInput id="service-model-id" aria-label={t('模型 ID')}
          required maxLength={160} value={draft.model} disabled={readOnly || busy} placeholder={t('获取模型后选择，或手动填写模型 ID')}
          onChange={event => change('model', event.target.value)} />
          {models.length > 0 && <SelectControl aria-label={t('选择模型')} className="model-input__choices" menuAnchorRef={modelFieldRef}
            disabled={readOnly || busy} value={models.includes(draft.model) ? draft.model : ''}
            onChange={event => setDraft(previous => changeServiceModel(previous, 'model', event.target.value))}>
            <option disabled value="">{t('选择模型')}</option>{models.map(model => <option key={model} value={model}>{model}</option>)}
          </SelectControl>}</div>
        {listMessage && <p role="status" className="text-sm">{listMessage}</p>}
        <SettingsToggle label={t('此模型支持视觉')} checked={draft.supportsImages} disabled={readOnly || busy || !draft.model.trim()}
          onChange={event => setDraft(previous => ({ ...previous, supportsImages: event.target.checked }))} />
        <label className="block space-y-2">{labels.temperature}<SettingsInput type="number" min="0" max="2" step="0.1"
          value={draft.generationOptions.temperature ?? ''} disabled={readOnly || busy}
          onChange={event => { const value = event.target.value; setDraft(previous => {
            const generationOptions = { ...previous.generationOptions };
            if (value === '') delete generationOptions.temperature; else generationOptions.temperature = Number(value);
            return { ...previous, generationOptions }; }); }} /></label>
        <SettingsActions><SettingsButton disabled={busy} onClick={close}>{t('取消')}</SettingsButton>
          <SettingsButton type="submit" disabled={readOnly || busy}>{t('保存')}</SettingsButton></SettingsActions>
      </form></SettingsEditDialog>}
  </SettingsSection>;
}
