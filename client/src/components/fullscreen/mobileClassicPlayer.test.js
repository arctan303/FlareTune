import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readClassicPlayer = () => readFileSync(new URL('./MobileClassicPlayer.jsx', import.meta.url), 'utf8');
const readClassicBackground = () => readFileSync(new URL('./MobileClassicBackground.jsx', import.meta.url), 'utf8');
const readClassicPanes = () => readFileSync(new URL('./MobileClassicPanes.jsx', import.meta.url), 'utf8');
const readClassicCss = () => readFileSync(new URL('./classic-player.css', import.meta.url), 'utf8');
const readMobileCss = () => readFileSync(new URL('./classic-mobile.css', import.meta.url), 'utf8');
const readDesktopLayout = () => readFileSync(new URL('./ClassicDesktopLayout.jsx', import.meta.url), 'utf8');
const readMobileLayout = () => readFileSync(new URL('./ClassicMobileLayout.jsx', import.meta.url), 'utf8');
const readSharedMobileLayout = () => readFileSync(new URL('./MobilePlayerLayout.jsx', import.meta.url), 'utf8');
const readArtistMobileLayout = () => readFileSync(new URL('./ArtistMobileLayout.jsx', import.meta.url), 'utf8');
const readClassicArtwork = () => readFileSync(new URL('./ClassicArtwork.jsx', import.meta.url), 'utf8');
const readArtistArtwork = () => readFileSync(new URL('./ArtistArtwork.jsx', import.meta.url), 'utf8');
const readMoreMenu = () => readFileSync(new URL('../PlayerMoreMenu.jsx', import.meta.url), 'utf8');

test('mobile artist photos are enabled only by the artist player entry', () => {
    const src = readClassicPlayer();
    assert.match(src, /import \{ useArtistPhotos \} from '\.\.\/\.\.\/hooks\/useArtistPhotos'/);
    assert.match(src, /const isArtistMode = mobileVisual === 'artist' && isMobile/);
    assert.match(readFileSync(new URL('./MobileArtistPlayer.jsx', import.meta.url), 'utf8'), /mobileVisual="artist"/);
    assert.match(src, /useArtistPhotos\(\{/);
    assert.ok(
        src.indexOf('} = useFullscreenTransition({') < src.indexOf('const suspendPlayerEffects = isClosing'),
        'fullscreen transition state must be initialized before it gates artist effects',
    );
});

test('MobileClassicPlayer renders frameless artist photo with linear vertical mask and blurred ambient fill', () => {
    const src = `${readClassicPlayer()}\n${readClassicBackground()}\n${readClassicPanes()}`;
    assert.match(src, /filter blur-\[40px\] brightness-\[0\.45\]/);
    assert.match(src, /maskImage: 'linear-gradient\(to bottom/);
    assert.match(src, /kenburnsZoomIn/);
    assert.match(src, /canShowLyrics && hasValidLyrics/);
    assert.doesNotMatch(src, /isPaperTheme/);
});

test('MobileClassicPlayer renders full screen blurred artist photo backdrop in multi-line lyric mode', () => {
    const src = readClassicBackground();
    assert.match(src, /filter blur-\[24px\] brightness-\[0\.38\]/);
    assert.match(src, /bg-gradient-to-b from-black\/40/);
});

test('PlayerMoreMenu offers explicit mode choices only when requested by the mobile player', () => {
    const src = readMoreMenu();
    assert.match(src, /歌词工作台/);
    assert.match(src, /showPlayerModes = false/);
    assert.match(src, /showPlayerModes && \(/);
    assert.match(src, /<PlayerModeChoices/);
    assert.doesNotMatch(src, /playerModeAction|nextPlayerMode|切换到：/);
    assert.match(readClassicPanes(), /<PlayerMoreMenu[\s\S]*?showPlayerModes \/>/);
    assert.match(readClassicPanes(), /showPlayerModes=\{isMobile\}/);
});

test('MobileClassicPlayer isolates lyric translation and volume tool interactions from auto-hide wake', () => {
    const src = readClassicPanes();
    assert.match(src, /target\?\.closest\?\.?\(['"]\.classic-lyrics__tools-wrapper, \.classic-lyrics__tool['"]\)/);
    assert.match(src, /event\.target\?\.closest\?\.?\(['"]\.classic-lyrics__tools-wrapper, \.classic-lyrics__tool['"]\)/);
});

test('MobileClassicPlayer exposes the lyric view only for non-instrumental language', () => {
    const src = `${readClassicPlayer()}\n${readClassicPanes()}`;
    assert.match(src, /songLanguageHasLyrics\(currentSong\?\.language\)/);
    assert.match(src, /if \(!isMobile \|\| !canShowLyrics \|\| fullScreenMobileView === 'lyrics'\) return/);
    assert.match(src, /!canShowLyrics && fullScreenMobileView === 'lyrics'/);
    assert.match(src, /role=\{isMobile && canShowLyrics \? 'button' : undefined\}/);
    assert.match(src, /canShowLyrics && hasValidLyrics/);
});

test('classic player mounts one layout for each viewport while sharing state and the current cover URL', () => {
    const player = readClassicPlayer();
    const desktop = readDesktopLayout();
    const mobile = readMobileLayout();
    const sharedMobile = readSharedMobileLayout();
    assert.match(player, /const MobileLayout = isArtistMode \? ArtistMobileLayout : ClassicMobileLayout/);
    assert.match(player, /isMobile \? \([\s\S]*?<MobileLayout[\s\S]*?\) : \([\s\S]*?<ClassicDesktopLayout/);
    assert.match(sharedMobile, /<MobileLyricsPane/);
    assert.match(mobile, /<MobileSongPane/);
    assert.match(readArtistMobileLayout(), /<MobileSongPane/);
    assert.match(mobile, /artwork=\{<ClassicArtwork/);
    assert.match(readArtistMobileLayout(), /artwork=\{<ArtistArtwork showPhotos=\{showMobilePhotos\}/);
    assert.match(readClassicArtwork(), /classic-player__cover/);
    assert.match(readArtistArtwork(), /if \(!showPhotos\) return <ClassicArtwork/);
    assert.doesNotMatch(readClassicArtwork(), /showPhotos|photoLayers/);
    assert.match(desktop, /<MobileSongPane/);
    assert.match(desktop, /<DesktopLyricsPane/);
    assert.doesNotMatch(desktop, /<MobileLyricsPane/);
    assert.doesNotMatch(sharedMobile, /<DesktopLyricsPane/);
    assert.match(player, /resolveCoverUrl\(currentSong\?\.cover_url \|\| ''\)/);
    assert.doesNotMatch(player, /const currentLyric =|const primaryLine =|`cover\/\$\{currentSong\.id\}\.jpg`/);
});

test('classic player passes lyric sync and intro data through to both complete and preview panes', () => {
    const player = readClassicPlayer();
    const panes = readClassicPanes();
    assert.match(player, /lyricSyncMode: state\.lyricSyncMode/);
    assert.match(player, /lyricIntro: state\.lyricIntro/);
    assert.match(player, /const lyricsScrollerProps = \{[\s\S]*?lyricSyncMode,[\s\S]*?lyricIntro,/);
    assert.match(player, /const songPaneProps = \{[\s\S]*?lyricIntro,[\s\S]*?lyricSyncMode,/);
    assert.match(readMobileLayout(), /<MobileSongPane[\s\S]*?\{\.\.\.songPaneProps\}/);
    assert.match(readDesktopLayout(), /<MobileSongPane[\s\S]*?\{\.\.\.songPaneProps\}/);
    assert.match(panes, /<SyncedLyricText[\s\S]*?line=\{displayLine\}[\s\S]*?visible=\{surfaceVisible\}[\s\S]*?syncMode=\{lyricSyncMode\}/);
});

test('CSS-hidden classic panes cannot subscribe to the shared lyric clock', () => {
    const player = readClassicPlayer();
    const panes = readClassicPanes();
    assert.match(player, /const mobileLyricsSurfaceVisible = playerSurfaceVisible[\s\S]*?fullScreenMobileView === 'lyrics'/);
    assert.match(player, /const mobileSongSurfaceVisible = playerSurfaceVisible[\s\S]*?fullScreenMobileView === 'song'/);
    assert.match(player, /const desktopLyricsSurfaceVisible = playerSurfaceVisible && !isMobile/);
    assert.match(readSharedMobileLayout(), /<MobileLyricsPane[\s\S]*?surfaceVisible=\{mobileLyricsSurfaceVisible\}/);
    assert.match(readDesktopLayout(), /<DesktopLyricsPane[\s\S]*?surfaceVisible=\{desktopLyricsSurfaceVisible\}/);
    assert.match(panes, /<LyricsScroller \{\.\.\.lyricsScrollerProps\}[\s\S]*?surfaceVisible=\{surfaceVisible\}/);
});

test('mobile song pane has one keyboard activation owner and timing spans do not own events', () => {
    const panes = readClassicPanes();
    assert.match(panes, /event\.preventDefault\(\);\s*onEnterLyrics\(\);/);
    assert.match(panes, /role=\{isMobile && canShowLyrics \? 'button' : undefined\}/);
    assert.doesNotMatch(panes, /paper-mobile-lyric-preview[^>]*role="button"/);
    assert.doesNotMatch(panes, /paper-mobile-lyric-preview[^>]*onKeyDown/);
});

test('mobile preview leaves translation static and intro does not offset canonical rows', () => {
    const panes = readClassicPanes();
    assert.match(panes, /lyricPresentation\.kind === 'intro' && index === 0/);
    assert.match(panes, /const displayLine = isIntroRow \? lyricPresentation\.line : lyric/);
    assert.match(panes, /const translation = !isIntroRow && translationEnabled/);
    assert.match(panes, /paper-mobile-lyric-preview__translation truncate">\{translation\}/);
    assert.match(panes, /!displayLine\.text\.includes\('\\n'\)[\s\S]*?\? displayLine\.text/);
    assert.doesNotMatch(panes, /unshift|splice|\[lyricIntro,\s*\.\.\./);
});

test('mobile lyric pane keeps its slide animation normally and exposes the final state for reduced motion', () => {
    const panes = readClassicPanes();
    const mobileCss = readMobileCss();
    const reducedMotionStart = mobileCss.indexOf('@media (prefers-reduced-motion: reduce)');
    const reducedMotionEnd = mobileCss.indexOf('/* =========================================================================', reducedMotionStart);
    const reducedMotionBlock = mobileCss.slice(reducedMotionStart, reducedMotionEnd);

    assert.match(
        panes,
        /className=\{`classic-lyrics__pane-motion[^`]*\$\{isExitingLyrics \? 'animate-lyrics-slide-out' : 'animate-lyrics-slide-in'\}`\}/,
    );
    assert.match(mobileCss, /\.animate-lyrics-slide-in \{\s*animation: lyricsFadeSlideIn 400ms/);
    assert.match(mobileCss, /\.animate-lyrics-slide-out \{\s*animation: lyricsFadeSlideOut 320ms/);
    assert.match(
        reducedMotionBlock,
        /\.paper-classic-player \.classic-lyrics__pane-motion \{[\s\S]*?animation: none !important;[\s\S]*?opacity: 1 !important;[\s\S]*?transform: none !important;/,
    );
});

test('MobileClassicPlayer routes missing translation clicks through the member completion action', () => {
    const src = readClassicPlayer();
    assert.match(src, /requestLyricsTranslationCompletion/);
    assert.match(src, /authenticated: Boolean\(state\.authSession\?\.authenticated\)/);
    assert.match(src, /translationState: state\.translationState/);
    assert.match(src, /canTranslate: translationState !== 'unavailable'/);
    assert.match(src, /translationState,[\s\S]*toggleTranslation: handleTranslationAction/);
    assert.match(src, /role="status" aria-live="polite" aria-atomic="true"/);
    assert.match(src, /translationState === 'failed'[\s\S]*歌词翻译补全失败，可以点击重试/);
    assert.match(src, /if \(translationPending\) return;/);
    assert.match(src, /if \(translationReady\) \{[\s\S]*toggleTranslation\(\)/);
    assert.match(src, /setTranslationEnabled\(true\)/);
});

test('classic translation pending animation stays on the outer ring and failed state is visible', () => {
    const css = readClassicCss();
    assert.match(css, /lyrics-translation-action\[data-translation-state='pending'\]::after[\s\S]*animation: lyrics-translation-breathe/);
    assert.doesNotMatch(css, /lyrics-translation-action\[data-translation-state='pending'\]\s*\{[^}]*animation:/);
    assert.match(css, /lyrics-translation-action\[data-translation-state='failed'\]::before[\s\S]*content: '!'/);
});
