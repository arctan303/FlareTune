import React from 'react';
import { t } from '../i18n/index.js';
import { EXPLORE_CATEGORIES } from '../constants/explore.js';
import { usePluginContribution } from '../plugins/contributions.js';
import { formatPath, syncBrowserHistory } from '../utils/navigation.js';

export default function RoamBrowseView() {
    const contribution = usePluginContribution('roam', 'browse-header', null);
    const Header = contribution?.renderers?.header;

    return (
        <div className="app-page roam-page pb-16">
            <header className="app-page-heading">
                <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-[var(--ink)]">{t('漫游')}</h1>
            </header>
            {Header && <Header />}
            <section aria-labelledby="roam-explore-title" className="space-y-4">
                <div className="flex items-center justify-between">
                    <h2 id="roam-explore-title" className="text-lg font-bold text-[var(--ink)] tracking-tight">{t('曲库探索')}</h2>
                </div>
                <div className="roam-explore-grid">
                    {EXPLORE_CATEGORIES.map((lang) => {
                        const title = t(lang.subtitle || lang.label);
                        const imageUrl = lang.image || `/categories/${lang.key}.jpg`;
                        return (
                            <button
                                key={lang.key}
                                type="button"
                                onClick={() => syncBrowserHistory(formatPath({ type: 'explore', language: lang.key }))}
                                className={`group relative flex flex-col justify-end p-5 rounded-2xl bg-gradient-to-br ${lang.gradient} overflow-hidden aspect-[16/10] sm:aspect-[16/9] w-full text-left shadow-xs hover:shadow-xl hover:-translate-y-1 transition-all duration-300 cursor-pointer active:scale-[0.98] border border-black/5`}
                                title={t('点击进入{p0}曲库', { p0: title })}
                            >
                                <img
                                    src={imageUrl}
                                    alt=""
                                    className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-500 pointer-events-none select-none"
                                    loading="lazy"
                                />
                                <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/15 to-transparent pointer-events-none" />
                                <div className="absolute inset-0 rounded-2xl ring-1 ring-inset ring-white/15 pointer-events-none" />
                                <div className="relative z-10">
                                    <span className="block text-xl sm:text-2xl font-bold tracking-tight text-white drop-shadow-md leading-tight">
                                        {title}
                                    </span>
                                </div>
                            </button>
                        );
                    })}
                </div>
            </section>
        </div>
    );
}
