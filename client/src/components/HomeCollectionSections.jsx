import { t } from '../i18n/index.js';
import React from 'react';
import { ChevronRight } from 'lucide-react';
import HorizontalScrollButtons from './catalog/HorizontalScrollButtons.jsx';
import { horizontalScrollState, moveHorizontalScroll } from './catalog/horizontalScroll.js';

export function HomeExploreSection({ items = [], langCounts, onOpen }) {
    const scrollRef = React.useRef(null);
    const [canScrollLeft, setCanScrollLeft] = React.useState(false);
    const [canScrollRight, setCanScrollRight] = React.useState(false);
    const [isOverflowing, setIsOverflowing] = React.useState(false);

    const updateScrollState = React.useCallback(() => {
        const el = scrollRef.current;
        if (!el) return;
        const { overflow, left, right } = horizontalScrollState(el, 4);
        setIsOverflowing(overflow);
        setCanScrollLeft(left);
        setCanScrollRight(right);
    }, []);

    React.useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        updateScrollState();
        el.addEventListener('scroll', updateScrollState, { passive: true });
        let observer;
        if (typeof ResizeObserver !== 'undefined') {
            observer = new ResizeObserver(() => updateScrollState());
            observer.observe(el);
        }
        return () => {
            el.removeEventListener('scroll', updateScrollState);
            observer?.disconnect();
        };
    }, [updateScrollState, items]);

    const handleScroll = (direction) => {
        const el = scrollRef.current;
        if (!el) return;
        const scrollAmount = Math.max(160, Math.floor(el.clientWidth * 0.75));
        moveHorizontalScroll(el, direction, scrollAmount, { snap: false });
    };

    return (
        <section className="collection-section" aria-labelledby="explore-title">
            <div className="collection-section__header mb-5">
                <p className="collection-section__index whitespace-nowrap">03 / EXPLORE</p>
                <div className="flex items-center justify-between gap-3">
                    <h3 id="explore-title">{t("曲库探索")}</h3>
                    {isOverflowing && (
                        <HorizontalScrollButtons variant="header" label={t("曲库分类")}
                            canScroll={{ left: canScrollLeft, right: canScrollRight }} onMove={handleScroll} />
                    )}
                </div>
            </div>

            <div
                ref={scrollRef}
                className="explore-shelf"
                role="region"
                aria-label={t("曲库语种分类列表")}
                tabIndex={0}
            >
                {items.map((lang) => {
                    const count = langCounts?.[lang.key];
                    const countLabel = Number.isFinite(count) ? t(" ({p0} 首)", { p0: (count) }) : '';
                    return (
                        <button
                            key={lang.key}
                            type="button"
                            onClick={() => onOpen?.(lang)}
                            className={`explore-shelf__item group relative flex flex-col justify-between p-4 sm:p-5 rounded-2xl bg-gradient-to-br ${lang.gradient} text-white border border-white/15 shadow-xs hover:shadow-lg hover:-translate-y-1 transition-all duration-200 cursor-pointer overflow-hidden aspect-square w-full active:scale-[0.98] text-left shrink-0`}
                            title={t("点击进入{p0}曲库{p1}", { p0: (lang.label), p1: (countLabel) })}
                        >
                            <div className="flex items-start justify-between w-full z-10">
                                <span className="text-xs font-mono tracking-wider text-white/80 leading-none">
                                    {lang.subtitle}
                                </span>
                                <span className="text-xs font-mono font-bold tracking-wider px-2 py-0.5 rounded-md bg-black/20 text-white/90 border border-white/10 leading-none">
                                    {lang.tag}
                                </span>
                            </div>

                            <div className="absolute -right-4 -bottom-4 w-24 h-24 rounded-full border-2 border-white/10 pointer-events-none flex items-center justify-center">
                                <div className="w-16 h-16 rounded-full border border-white/10" />
                            </div>

                            <div className="flex items-end justify-between w-full z-10">
                                <span className="text-base sm:text-lg lg:text-xl font-black tracking-tight text-white leading-none">
                                    {lang.label}
                                </span>
                                <div className="w-7 h-7 rounded-full bg-white/20 backdrop-blur-xs flex items-center justify-center text-white/90 group-hover:bg-white/35 group-hover:scale-110 group-hover:translate-x-0.5 transition-all">
                                    <ChevronRight size={15} />
                                </div>
                            </div>
                        </button>
                    );
                })}
            </div>
        </section>
    );
}
