import React from 'react';
import { getPlayerBarLyricLayout } from '../../utils/playerBarLyrics.js';
import QualityBadge from '../QualityBadge.jsx';
import ScrollingText from './ScrollingText.jsx';
import SyncedLyricText from '../lyrics/SyncedLyricText.jsx';
import { useLyricSurfacePresentation } from '../lyrics/lyricSurfacePresentation.js';

const WINDOW_BEFORE = 6;
const WINDOW_AFTER = 8;

export default function PlayerBarLyricPreview({
    currentSong,
    isHidden,
    isPlaying,
    showBuffering,
    lyrics,
    currentLyricIndex,
    translationEnabled,
    canTranslate,
    title,
    subtitle,
    lyricIntro = null,
    lyricSyncMode = 'line',
    surfaceVisible = true,
}) {
    const safeLyrics = Array.isArray(lyrics) ? lyrics : [];
    const lyricPresentation = useLyricSurfacePresentation({
        lyrics: safeLyrics,
        currentLyricIndex,
        lyricIntro,
        lyricSyncMode,
        surfaceVisible: surfaceVisible && !isHidden,
    });
    const displayedLyricIndex = lyricPresentation.index >= 0
        ? lyricPresentation.index
        : currentLyricIndex;
    const hasLyricPresentation = Boolean(lyricIntro) || safeLyrics.length > 1;

    if (isHidden || !hasLyricPresentation) {
        return (
            <div key={`${currentSong?.id}-meta`} className="player-console__lyric-content flex flex-col items-center justify-center text-center w-full max-w-xl animate-player-content-drift-in pointer-events-auto">
                <ScrollingText className="player-console__title w-full text-center text-[15px] sm:text-[16px] font-bold transition-colors">
                    {title}
                    {!showBuffering && (!isPlaying || safeLyrics.length <= 1) && <QualityBadge format={currentSong?.format} />}
                </ScrollingText>
                <ScrollingText className="transition-colors text-center w-full player-console__artist mt-0.5 text-[12px] sm:text-[12.5px] font-medium opacity-80">
                    {subtitle}
                </ScrollingText>
            </div>
        );
    }

    const { isBilingual, rowHeight, translateY } = getPlayerBarLyricLayout({
        translationEnabled,
        canTranslate,
        lyrics: safeLyrics,
        currentLyricIndex: displayedLyricIndex,
    });
    const windowStart = Math.max(0, displayedLyricIndex - WINDOW_BEFORE);
    const windowEnd = Math.min(safeLyrics.length - 1, displayedLyricIndex + WINDOW_AFTER);
    const windowLines = [];

    for (let index = windowStart; index <= windowEnd; index += 1) {
        const line = safeLyrics[index];
        const isActive = index === displayedLyricIndex;
        const isIntroRow = lyricPresentation.kind === 'intro' && index === 0;
        const displayLine = isIntroRow ? lyricPresentation.line : line;
        const opacityClass = isActive ? 'player-console__lyric--current opacity-100' : 'player-console__lyric opacity-70';

        if (isBilingual) {
            const primaryText = String(displayLine?.text || '').split('\n')[0] || '...';
            const translationText = isIntroRow ? '' : (line.translation || (line.text.split('\n')[1] || ''));
            windowLines.push(
                <div key={index} className="h-[36px] flex flex-col justify-center text-center">
                    <div className={`player-console__lyric-row h-[18px] leading-[18px] truncate transition-all duration-300 origin-center text-center text-[15px] sm:text-[15.5px] font-bold ${opacityClass}`}>
                        <SyncedLyricText
                            line={displayLine}
                            text={primaryText}
                            active={isActive}
                            visible={surfaceVisible && !isHidden}
                            syncMode={lyricSyncMode}
                            surface="playerbar"
                        />
                    </div>
                    <div className={`player-console__lyric-row h-[18px] leading-[18px] truncate transition-all duration-300 origin-center text-center text-[12px] sm:text-[12.5px] font-medium player-console__lyric ${isActive ? 'opacity-85' : 'opacity-60'}`}>
                        {translationText}
                    </div>
                </div>,
            );
        } else {
            const textLines = String(displayLine?.text || '').split('\n');
            const displayText = textLines.length > 1 ? `${textLines[0]} ${textLines[1]}` : textLines[0];
            windowLines.push(
                <div
                    key={index}
                    className={`player-console__lyric-row h-[18px] leading-[18px] truncate transition-all duration-300 origin-center text-center text-[15px] sm:text-[16px] font-bold ${
                        isActive ? 'player-console__lyric--current scale-100 opacity-100' : 'player-console__lyric scale-[0.88] opacity-70'
                    }`}
                >
                    <SyncedLyricText
                        line={displayLine}
                        text={displayText || '...'}
                        active={isActive}
                        visible={surfaceVisible && !isHidden}
                        syncMode={lyricSyncMode}
                        surface="playerbar"
                    />
                </div>,
            );
        }
    }

    return (
        <div key={`${currentSong?.id}-lyrics`} className="player-console__lyric-content absolute top-0 left-0 w-full animate-player-content-drift-in pointer-events-none">
            <div
                className="player-console__lyric-roller w-full transition-transform duration-300 ease-in-out flex flex-col pointer-events-auto text-center"
                style={{ transform: `translateY(-${translateY}px)` }}
            >
                {windowStart > 0 && <div aria-hidden="true" style={{ height: windowStart * rowHeight }} />}
                {windowLines}
            </div>
        </div>
    );
}
