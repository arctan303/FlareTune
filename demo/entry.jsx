import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '../client/src/app.jsx';
import { useLocale, setUiLanguage, t } from '../client/src/i18n/index.js';
import LanguagePicker from '../client/src/components/LanguagePicker.jsx';
import { useUIStore } from '../client/src/store/useUIStore.js';
import { accountPlaylistsStore } from '../client/src/accountPlaylists.js';
import { demoData, runtimeFetch } from './transport.js';
import { DEMO_ACCOUNT, DEMO_KEY, songs } from './localData.js';
import Showcase from './Showcase.jsx';
import SettingsEditDialog from '../client/src/components/SettingsEditDialog.jsx';
import { DEMO_STORAGE_PREFIX, DEMO_DATABASES } from './storageNamespace.js';
import { imageLoadRegistry } from '../client/src/utils/imageLoadRegistry.js';
import '../client/src/index.css';
import './style.css';

const session = { authenticated: true, mustChangePassword: false, csrfToken: 'local-demo',
  user: { accountId: DEMO_ACCOUNT, username: 'demo', displayName: 'Demo', role: 'member', uiLanguage: demoData.read().uiLanguage } };
useUIStore.getState().setAuthSession({ ...session, initialized: true, error: null });
imageLoadRegistry.setSessionScope(session);
const changeLanguage = async value => {
  await runtimeFetch('/api/account/ui-language', { method: 'PATCH', body: JSON.stringify({ uiLanguage: value }) });
  await setUiLanguage(value);
};
function Demo() {
  useLocale();
  const temporary = React.useSyncExternalStore(demoData.subscribe, demoData.isTemporary, () => false);
  const [panel, setPanel] = React.useState(null), [resetting, setResetting] = React.useState(false);
  const [resetBusy, setResetBusy] = React.useState(false);
  React.useEffect(() => {
    const sync = event => {
      if (event.key === `${DEMO_STORAGE_PREFIX}reset` && event.newValue) { location.reload(); return; }
      if (event.key !== DEMO_KEY) return;
      // Storage events are read-only: writing here would bounce between tabs.
      void setUiLanguage(demoData.read().uiLanguage);
      const store = accountPlaylistsStore.getState();
      void store.refresh().then(() => Promise.all(accountPlaylistsStore.getState().playlists.map(p => accountPlaylistsStore.getState().loadDetail(p.id))));
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  const reset = async () => {
    setResetBusy(true);
    await new Promise(requestAnimationFrame);
    // Exact ownership prefixes; never localStorage.clear(). Separate demo origin.
    demoData.reset();
    try { for (const key of Object.keys(localStorage)) if (key === DEMO_KEY || key.startsWith(DEMO_STORAGE_PREFIX)) localStorage.removeItem(key); } catch { /* temporary session */ }
    try { localStorage.setItem(`${DEMO_STORAGE_PREFIX}reset`, crypto.randomUUID()); } catch { /* temporary session */ }
    // Stop and close the two owned DBs so pending playback writes cannot restore them.
    await Promise.all(DEMO_DATABASES.map(name => new Promise(resolve => {
      try { const req = indexedDB.deleteDatabase(name); req.onsuccess = req.onerror = req.onblocked = resolve; } catch { resolve(); }
    })));
    location.reload();
  };
  return <div className="demo-root">
    <header className="demo-toolbar">
      <strong className="text-sm">FlareTune · Demo</strong>
      <LanguagePicker onChange={changeLanguage} />
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <button className="app-section-link" onClick={() => setPanel('sources')}>{t('素材与体验边界')}</button>
        <button className="app-section-link" onClick={() => setPanel('showcase')}>{t('只读功能展示')}</button>
        <button className="app-section-link" onClick={() => setResetting(true)}>{t('重置演示数据')}</button>
      </div>
    </header>
    {temporary && <p className="app-inline-notice" role="status">{t('浏览器存储不可用，本次体验的数据仅临时保留。')}</p>}
    <div className="demo-app">{!resetBusy && <App validatedSession={session} />}</div>
    {(panel || resetting) && <SettingsEditDialog title={t(resetting ? '重置演示数据' : panel === 'showcase' ? '只读功能展示' : '素材与体验边界')}
      onClose={() => { setPanel(null); setResetting(false); }} closeOnBackdrop>
        {resetting ? <><p>{t('只清除本浏览器的演示收藏、歌单、历史和偏好。确定重置？')}</p><button className="primary-button mt-4" onClick={reset}>{t('确认重置')}</button></>
          : panel === 'showcase' ? <Showcase /> : <>
            <h1 className="text-2xl font-bold">{t('素材与体验边界')}</h1>
            <p className="my-4">{t('演示数据仅保存在当前浏览器，不需要登录。')}</p>
            <p className="my-4">{t('可以播放、搜索、收藏、编辑本地歌单和切换外观；共享曲库、账号与AI功能只读。')}</p>
            <p className="my-4">{t('同步歌词为预置人工时间轴，不在演示中联网搜词。')}</p>
            <a className="app-section-link" href="https://github.com/arctan303/FlareTune#readme" target="_blank" rel="noreferrer">{t('创建自己的音乐库')}</a>
            <ul className="mt-5 space-y-4">{songs.map(song => <li key={song.id} className="text-sm">
              <a href={song.source} target="_blank" rel="noreferrer" className="app-section-link">{song.title} — {song.artist}</a>
              <p><a href={song.licenseUrl} target="_blank" rel="noreferrer">{song.license}</a> · {song.modifications}</p>
            </li>)}</ul>
          </>}
    </SettingsEditDialog>}
  </div>;
}
void setUiLanguage(demoData.read().uiLanguage).then(() => createRoot(document.getElementById('root')).render(<Demo />));
