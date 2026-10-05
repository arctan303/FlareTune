import React from 'react';
import { t } from '../i18n/index.js';

export default function SettingsSkeleton({ cards = 1, rows = 2, compact = false, label = '正在加载…' }) {
  return <div role="status" aria-label={t(label)} className={`settings-skeleton ${compact ? 'settings-skeleton--compact' : ''}`}>
    <div aria-hidden="true" inert="">
      {Array.from({ length: cards }, (_, card) => <div key={card} className="settings-skeleton__card">
        <div className="catalog-skeleton__block settings-skeleton__heading" />
        {Array.from({ length: rows }, (_, row) => <div key={row} className="settings-skeleton__row">
          <div className="min-w-0 flex-1 space-y-2"><div className="catalog-skeleton__block h-3 w-2/3" /><div className="catalog-skeleton__block h-2 w-1/3" /></div>
          <div className="catalog-skeleton__block h-6 w-10 shrink-0 rounded-full" />
        </div>)}
      </div>)}
    </div>
  </div>;
}
