import { localizeUnknownArtist, t } from '../../i18n/index.js';
import React from 'react';
import LazyImage from '../LazyImage';

/**
 * 3D 双面连续硬币翻面组件（零闪烁、无限平滑自转）
 * 采用双槽位（Slot 0 & Slot 1）连续累加旋转角度模型，杜绝任何动画重置与 DOM 突变闪烁
 */
export default function CoinFlipCover({ currentSong, isExpanded, switchDirection }) {
    const [slot0Song, setSlot0Song] = React.useState(currentSong);
    const [slot1Song, setSlot1Song] = React.useState(null);
    const [activeSlot, setActiveSlot] = React.useState(0); // 0 或 1
    const [rotation, setRotation] = React.useState(0);
    const [isTransitioning, setIsTransitioning] = React.useState(false);
    const lastSongIdRef = React.useRef(currentSong?.id);
    const lastCoverUrlRef = React.useRef(currentSong?.cover_url);

    React.useEffect(() => {
        if (!currentSong) return;

        // 同一首歌更换封面时更新可见槽位，不触发切歌翻面。
        if (lastSongIdRef.current === currentSong.id) {
            if (lastCoverUrlRef.current !== currentSong.cover_url) {
                lastCoverUrlRef.current = currentSong.cover_url;
                if (activeSlot === 0) setSlot0Song(currentSong);
                else setSlot1Song(currentSong);
            }
            return;
        }
        lastSongIdRef.current = currentSong.id;
        lastCoverUrlRef.current = currentSong.cover_url;

        const isNext = (switchDirection || 'next') !== 'prev';
        const delta = isNext ? -180 : 180; // 下一首向左翻 (-180°)，上一首向右翻 (+180°)

        if (activeSlot === 0) {
            setSlot1Song(currentSong);
            setActiveSlot(1);
        } else {
            setSlot0Song(currentSong);
            setActiveSlot(0);
        }

        setIsTransitioning(true);
        setRotation((prev) => prev + delta);
    }, [currentSong?.id, currentSong?.cover_url, switchDirection, activeSlot]);

    const getImgClass = () => (
        `${isExpanded ? 'shadow-inner' : 'player-console__cover'} transition-all duration-300 ${
            isExpanded ? 'h-[48px] w-[48px] rounded-xl' : 'h-[52px] w-[52px] rounded-[14px]'
        }`
    );

    return (
        <div className={`player-cover-coin-wrap relative z-20 flex-shrink-0 flex items-center justify-center ${isExpanded ? 'w-12 h-12' : 'w-[52px] h-[52px]'}`}>
            <div
                className="player-cover-coin w-full h-full"
                style={{
                    transform: `rotateY(${rotation}deg)`,
                    transition: isTransitioning
                        ? 'transform 800ms cubic-bezier(0.16, 0.95, 0.3, 1)'
                        : 'none',
                }}
            >
                {/* 槽位 0：位于 0° */}
                <div className="player-cover-coin__face player-cover-coin__face--front">
                    {slot0Song && (
                        <LazyImage
                            eager
                            src={slot0Song.cover_url || '/placeholder-album.svg'}
                            fallback="/placeholder-album.svg"
                            className={getImgClass()}
                            alt={slot0Song.title ? t("{p0} - {p1} 专辑封面", { p0: slot0Song.title, p1: localizeUnknownArtist(slot0Song.artist) }) : t("专辑封面")}
                        />
                    )}
                </div>

                {/* 槽位 1：位于 180°（背面） */}
                <div className="player-cover-coin__face player-cover-coin__face--back">
                    {slot1Song && (
                        <LazyImage
                            eager
                            src={slot1Song.cover_url || '/placeholder-album.svg'}
                            fallback="/placeholder-album.svg"
                            className={getImgClass()}
                            alt={slot1Song.title ? t("{p0} - {p1} 专辑封面", { p0: slot1Song.title, p1: localizeUnknownArtist(slot1Song.artist) }) : t("专辑封面")}
                        />
                    )}
                </div>
            </div>
        </div>
    );
}
