import React from 'react';
import { t } from '../client/src/i18n/index.js';
import { songs } from './localData.js';
import SettingsSection from '../client/src/components/SettingsSection.jsx';
import { usePlayerStore } from '../client/src/store/usePlayerStore.js';
export default function Showcase() {
  const [active, setActive] = React.useState('曲库管理');
  const tabs = ['曲库管理','音乐助手','实例设置','本地入库设备'];
  return <section className="app-page space-y-5 pb-24">
    <h1 className="app-page-title">{t('只读功能展示')}</h1>
    <p className="app-inline-notice">{t('演示模式下此功能只读。')}</p>
    <div className="flex flex-wrap gap-2" role="group" aria-label={t('只读功能展示')}>
      {tabs.map(tab => <button type="button" key={tab} className={active === tab ? 'primary-button' : 'secondary-button'} aria-pressed={active === tab} onClick={() => setActive(tab)}>{t(tab)}</button>)}
    </div>
    {active === '曲库管理' && <SettingsSection title={t('曲库管理')}>
      <p className="mb-4 text-sm text-[var(--muted)]">{t('上传歌曲、编辑歌曲信息、管理封面和歌词。')}</p>
      <button type="button" className="secondary-button mb-4" disabled>{t('上传歌曲')}</button>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th>{t('歌曲')}</th><th>{t('歌手')}</th><th>{t('操作')}</th></tr></thead>
        <tbody>{songs.slice(0,4).map(song => <tr className="border-t border-[var(--line)]" key={song.id}><td className="py-3">{song.title}</td><td>{song.artist}</td><td><button disabled className="secondary-button">{t('编辑')}</button></td></tr>)}</tbody></table></div>
    </SettingsSection>}
    {active === '音乐助手' && <SettingsSection title={t('音乐助手')}>
      <p className="rounded-xl border border-[var(--line)] p-4">{t('示例：找几首轻松的歌曲，并整理成歌单。')}</p>
      <div className="mt-4 space-y-2">{songs.slice(0,3).map(song => <button type="button" className="flex w-full items-center gap-3 rounded-xl border border-[var(--line)] p-3 text-left" key={song.id}
        onClick={() => usePlayerStore.getState().playSong(song, songs.slice(0,3))}>
        <img src={song.cover_url} alt="" className="h-10 w-10 rounded-lg"/><span>{song.title}<small className="block text-[var(--muted)]">{song.artist}</small></span></button>)}</div>
      <button className="secondary-button mt-4" type="button" disabled>{t('保存歌单')}</button>
    </SettingsSection>}
    {active === '实例设置' && <SettingsSection title={t('实例设置')}>
      <p className="mb-4 text-sm text-[var(--muted)]">{t('管理账号、配置可选AI供应商与Google登录。')}</p>
      <fieldset disabled className="space-y-4"><label className="block">{t('用户名')}<input className="mt-1 block w-full rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3" value="demo" readOnly /></label>
        <label className="block">{t('模型')}<input className="mt-1 block w-full rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3" value="—" readOnly /></label><button className="secondary-button">{t('保存')}</button></fieldset>
    </SettingsSection>}
    {active === '本地入库设备' && <SettingsSection title={t('本地入库设备')}>
      <p className="mb-4 text-sm text-[var(--muted)]">{t('扫描本地目录，预览元信息，核对重复后导入。')}</p>
      <div className="space-y-2">{songs.slice(0,3).map(song => <div key={song.id} className="flex items-center gap-3 border-b border-[var(--line)] py-3"><input type="checkbox" checked readOnly disabled aria-label={song.title} /><span>{song.title}.mp3<small className="block text-[var(--muted)]">{song.artist} · {Math.round(song.duration)}s</small></span></div>)}</div>
      <button disabled className="secondary-button mt-4" type="button">{t('导入')}</button>
    </SettingsSection>}
    <p className="text-sm text-[var(--muted)]">{t('AI案例为预置展示，不调用模型；上传和实例管理需部署自己的实例。')}</p>
    <a className="app-section-link" href="https://github.com/arctan303/FlareTune#readme" target="_blank" rel="noreferrer">{t('创建自己的音乐库')}</a>
  </section>;
}
