import React from 'react';
import { t } from '../../i18n/index.js';
import CatalogSkeleton from './CatalogSkeleton.jsx';

export default function CatalogReadState({ resource, type, overview = false, emptyLabel, children }) {
  const failed = resource.status === 'error' || resource.requestError;
  return <>
    {resource.refreshing && <p role="status" className="mb-3 text-sm text-[var(--muted)]">{t('刷新中…')}</p>}
    {failed && <div role="alert" className="app-inline-notice mb-4">
      <span>{t('{p0}加载失败', { p0: t(type === 'artists' ? '歌手' : type === 'albums' ? '专辑' : '歌曲') })}</span>
      <button type="button" className="app-section-link" onClick={resource.requestError === 'more' ? resource.loadMore : resource.retry}
        disabled={resource.loadingMore || resource.refreshing}>{t('重试')}</button>
    </div>}
    {resource.status === 'loading' ? <CatalogSkeleton type={type} overview={overview} />
      : resource.status !== 'error' && (resource.items.length > 0 ? children
        : emptyLabel ? <p className="theme-empty py-10 text-sm text-[var(--muted)]">{emptyLabel}</p> : null)}
  </>;
}
