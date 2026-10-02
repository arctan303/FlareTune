import { t } from '../i18n/index.js';

const names = { ai_protocols: 'AI 协议接入', user_images: '私有图片', ai_feature_models: '功能模型配置', google_login: 'Google 登录' };

export default function DatabaseMigrationStatus({ status, busy, onUpgrade }) {
  const known = Number.isSafeInteger(status?.schemaVersion) && Number.isSafeInteger(status?.targetVersion);
  const basePending = known && status.schemaVersion < status.targetVersion;
  const pending = known && (basePending || status.supplementalPending);
  const migrations = status?.supplementalMigrations;
  const complete = known && status.schemaVersion === status.targetVersion && status.supplementalPending === false;
  return <div className="mt-4 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4">
    <div className="flex items-center justify-between gap-4">
      <h3 className="text-sm font-semibold">{t('数据库更新')}</h3>
      <span role="status" className={`rounded-md px-2 py-1 text-xs font-medium ${pending ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300' : complete ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'text-[var(--muted)]'}`}>
        {t(pending ? '有待更新' : complete ? '已是最新' : '状态未知')}
      </span>
    </div>
    <dl className="mt-4 flex items-center justify-between gap-4 text-sm">
      <dt className="text-[var(--muted)]">{t('基础结构版本')}</dt>
      <dd className="font-medium">{status?.schemaVersion ?? t('未知')}{basePending && <span> → {status.targetVersion}</span>}</dd>
    </dl>
    <div className="mt-4 border-t border-[var(--line)] pt-4">
      <div className="flex items-center justify-between gap-4 text-sm">
        <h4 className="font-medium">{t('功能迁移')}</h4>
        {Array.isArray(migrations) && <span className="text-xs text-[var(--muted)]">{t('已完成 {done}/{total}', { done: migrations.filter(item => item.ready).length, total: migrations.length })}</span>}
      </div>
      {Array.isArray(migrations) ? <ul className="mt-3 space-y-2 text-sm">
        {migrations.map(item => <li key={item.id} className="flex items-center justify-between gap-4">
          <span>{t(names[item.id] || '功能更新')}</span>
          <span className={item.ready ? 'text-[var(--muted)]' : 'font-medium text-amber-700 dark:text-amber-300'}>{t(item.ready ? '已完成' : '待更新')}</span>
        </li>)}
      </ul> : <p className="mt-3 text-xs text-[var(--muted)]">{t(status?.supplementalPending ? '有功能迁移待完成。' : '功能迁移详情暂不可用，请刷新重试。')}</p>}
    </div>
    {pending && <button type="button" disabled={busy} onClick={onUpgrade} className="primary-button mt-4 min-h-11 rounded-xl px-4 text-sm font-semibold disabled:opacity-50">{t(busy ? '正在更新…' : '更新数据库')}</button>}
  </div>;
}
