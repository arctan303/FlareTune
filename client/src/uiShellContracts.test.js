import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const readSource = (relativePath) => {
  const url = new URL(relativePath, import.meta.url);
  const content = readFileSync(url, 'utf8');
  if (relativePath.endsWith('.css')) {
    return content.replace(/@import\s+['"](\.[^'"]+)['"];/g, (_, importPath) => {
      const targetUrl = new URL(importPath, url);
      return readFileSync(targetUrl, 'utf8');
    });
  }
  return content;
};

test('XiaoA uses the music site API in both development and production', () => {
  const development = readSource('../../.env.development');
  const production = readSource('../../.env.production');
  assert.match(development, /^VITE_API_BASE_URL=$/m);
  assert.match(production, /^VITE_API_BASE_URL=$/m);
  assert.doesNotMatch(development, /VITE_XIAOA_API_BASE/);
  assert.doesNotMatch(production, /VITE_XIAOA_API_BASE/);
});
test('reduced-motion and hidden-page rules stop continuous shell animations', () => {
  const css = readSource('./index.css');

  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.playing-bars > div[\s\S]*animation: none !important/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\[style\*="text-scroll"\][\s\S]*animation: none !important/);
  assert.match(css, /html\[data-page-hidden='true'\][\s\S]*animation-play-state: paused !important/);
});

test('application shell does not render or track the retired pointer halo', () => {
  const css = readSource('./index.css');
  const environment = readSource('./components/ShellEnvironment.jsx');

  assert.doesNotMatch(css, /shell-halo-layer|shell-environment__halo|--pointer-x|--pointer-y/);
  assert.doesNotMatch(environment, /pointerHalo|haloLayerRef|shell-halo-layer|pointermove/);
  assert.equal(existsSync(new URL('./utils/pointerHalo.js', import.meta.url)), false);
  assert.match(environment, /document\.documentElement\.dataset\.pageHidden/);
});

test('immersive spectrum renderer resets and reacquires analysis on media source changes', () => {
  const resource = readSource('./components/fullscreen/audioAnalyserResource.js');
  const immersive = readSource('./components/fullscreen/ImmersiveAudioAura.jsx');
  const app = readSource('./app.jsx');
  const audioEngine = readSource('./hooks/useAudioEngine.js');

  assert.match(resource, /resource\.mediaKey === getAudioSourceKey\(audio\)/);
  assert.match(resource, /track\.readyState !== 'ended'/);
  assert.match(resource, /resource\.context\.state !== 'closed'/);
  assert.match(resource, /export const refreshAudioAnalyser/);
  assert.match(resource, /export const markAudioAnalyserPlaying/);
  assert.match(resource, /if \(!hasAudioAnalyserEnteredPlaying\(audio\)\) return null/);
  assert.doesNotMatch(resource, /\.createMediaElementSource\s*\(/);
  assert.match(immersive, /invalidateAudioAnalyser/);
  assert.match(immersive, /refreshAudioAnalyser/);
  assert.match(immersive, /addEventListener\('loadstart'/);
  assert.match(immersive, /addEventListener\('emptied'/);
  assert.match(immersive, /addEventListener\('playing'/);
  assert.match(immersive, /markAudioAnalyserPlaying/);
  assert.match(immersive, /hasAudioAnalyserEnteredPlaying/);
  assert.match(immersive, /audio(?:El)?\.paused/);
  assert.match(immersive, /HTMLMediaElement\.HAVE_CURRENT_DATA/);
  assert.doesNotMatch(immersive, /addEventListener\('play'/);
  assert.doesNotMatch(immersive, /addEventListener\('canplay'/);
  assert.match(app, /\.\.\.audioHandlers/);
  assert.match(audioEngine, /const handleLoadStart = useCallback\(\(e\) => \{[\s\S]*invalidateAudioAnalyser\(e\.currentTarget\)/);
  assert.match(audioEngine, /onLoadStart: handleLoadStart/);
  assert.match(audioEngine, /const handlePlaying = useCallback\(\(e\) => \{[\s\S]*markAudioAnalyserPlaying\(e\.currentTarget\)/);
  assert.match(audioEngine, /onPlaying: handlePlaying/);
});

test('application sidebar uses labeled desktop navigation and a focus-managed mobile panel', () => {
  const css = readSource('./index.css');
  const sidebar = readSource('./components/AppSidebar.jsx');
  const wordmark = readSource('./components/TuneWordmark.jsx');
  const queue = readSource('./components/PlaylistDrawer.jsx');

  assert.match(sidebar, /PRIMARY_ITEMS[\s\S]*主页[\s\S]*搜索[\s\S]*漫游[\s\S]*资料库/);
  assert.match(sidebar, /data-ai-entry="sidebar"/);
  assert.match(sidebar, /previousFocusRef/);
  assert.match(sidebar, /event\.key !== 'Tab'/);
  assert.match(sidebar, /mainContent\?\.setAttribute\('inert', ''\)/);
  assert.match(sidebar, /mainContent\?\.removeAttribute\('inert'\)/);
  assert.match(sidebar, /data-tooltip=\{label\}/);
  assert.match(sidebar, /<TuneWordmark \/>/);
  assert.match(wordmark, /<span className=\{`tune-wordmark/);
  assert.match(css, /\.app-nav-item \{[\s\S]*min-height: 44px/);
  assert.doesNotMatch(wordmark, /<path\b/);
  assert.match(css, /\.app-nav-item\[data-tooltip\]:focus-visible::after/);
  assert.match(css, /@media \(max-width: 639px\)[\s\S]*\.app-mobile-header \{[\s\S]*display: flex/);
  assert.match(css, /\.app-sidebar\.is-mobile-open \{[\s\S]*visibility: visible/);
  assert.match(css, /\.player-console__icon\s*\{[\s\S]*?min-width:\s*36px;[\s\S]*?min-height:\s*36px/);
  assert.match(css, /\.queue-row__remove\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px/);
  assert.doesNotMatch(queue, /queue-row__remove[^"\n]*hidden/);
  assert.match(queue, /theme-drawer__close/);
});

test('sidebar account entry revalidates local session and opens account settings', () => {
  const sidebar = readSource('./components/AppSidebar.jsx');
  const accountMenu = readSource('./components/AccountMenu.jsx');
  const accountSettings = readSource('./components/AccountSettings.jsx');

  assert.match(sidebar, /<AccountMenu onNavigate=\{navigate\} \/>/);
  assert.match(sidebar, /app-sidebar__logout-btn/);
  assert.match(sidebar, /onClick=\{\(\) => navigate\('settings'\)\}/);
  assert.match(sidebar, /logout\(authSession\?\.csrfToken\)/);
  assert.match(accountMenu, /onNavigate\?\.\('settings', 'personal'\)/);
  assert.match(accountMenu, /getSession\(\)/);
  assert.match(accountSettings, /logout\(authSession\.csrfToken\)/);
  assert.match(accountMenu, /AUTH_SESSION_INVALIDATED_EVENT/);
  assert.match(accountMenu, /requestId !== authRequestRef\.current/);
  assert.doesNotMatch(accountMenu, /account-popover|role="dialog"/);
  assert.doesNotMatch(accountMenu, /\/api\/ai\/auth|beginAuthLogin|sso_attempted|yifang_error/);
});

test('identity-sensitive music data waits for session discovery and always revalidates', () => {
  const store = readSource('./store/useUIStore.js');
  const musicData = readSource('./hooks/useMusicData.js');
  const main = readSource('./components/MainContent.jsx');
  const playlistLoader = readSource('./services/playlistPayloadLoader.js');
  const songApi = readSource('./services/songApi.js');
  const asyncCache = readSource('./utils/expiringAsyncCache.js');
  const app = readSource('./app.jsx');

  assert.match(store, /authSession: \{ authenticated: false, user: null, initialized: false \}/);
  assert.match(store, /accountPlaylistsStore\.getState\(\)\.setSubject\(nextAccountId\)/);
  assert.match(store, /previousAccountId !== nextAccountId/);
  assert.match(musicData, /if \(!authInitialized \|\| !authenticated \|\| !accountId\) \{/);
  assert.match(musicData, /setMyPlaylists\(\[\]\)[\s\S]{0,180}setIsLoading\(false\)/);
  assert.doesNotMatch(musicData, /inspectMusicDataCache|localStorage/);
  assert.match(musicData, /credentials: 'include',[\s\S]{0,80}cache: 'no-store'/);
  assert.match(app, /accountPlaylistsStore\.getState\(\)\.setSubject\(subject\)/);
  assert.match(app, /accountPlaylistsStore\.getState\(\)\.refresh\(\)/);
  assert.match(playlistLoader, /apiUrl, \{ credentials: 'include', cache: 'no-store' \}/);
  assert.match(playlistLoader, /revalidateExpiringCache\(cache, cacheKey, loader/);
  assert.match(playlistLoader, /const cacheKey = `lang::\$\{langKey\}::\$\{sort\}::\$\{page\}::\$\{limit\}::\$\{authTag\}`/);
  assert.doesNotMatch(playlistLoader, /const cacheKey = `\$\{playlist\.id\}::\$\{authed\}`/);
  assert.match(asyncCache, /const refreshPromise = cache\.refresh\(key, loader\)/);
  assert.match(main, /previousViewerKeyRef\.current === viewerKey/);
  assert.match(main, /previousViewerKeyRef\.current = viewerKey;[\s\S]{0,120}requestGuardRef\.current\.next\(\)/);
  assert.match(main, /viewingPlaylistData \|\| playlistLoadState\.playlist/);
  assert.match(main, /clearSkeletonTimer\(\);[\s\S]{0,100}closeViewingPlaylist\(\)/);
  assert.match(main, /playlist\.source === 'member'[\s\S]{0,120}status: 'idle', playlist: null/);
  assert.match(main, /playlist\.source === 'member'[\s\S]{0,220}return;[\s\S]{0,80}status: 'skeleton'/);
  const identityRefresh = main.slice(
    main.indexOf('loadPlaylistPayload(playlist, authUser, {', main.indexOf('previousViewerKeyRef.current === viewerKey')),
    main.indexOf('}, [authUser, closeViewingPlaylist', main.indexOf('previousViewerKeyRef.current === viewerKey')),
  );
  assert.match(identityRefresh, /revalidate: true/);
  assert.doesNotMatch(identityRefresh, /staleWhileRevalidate|onRefresh/);
  assert.match(main, /登录状态变化后刷新歌单失败:[\s\S]{0,180}closeViewingPlaylist\(\);[\s\S]{0,120}status: 'error'/);
  assert.match(main, /登录状态变化后刷新歌单失败/);
  assert.match(songApi, /credentials: 'include',[\s\S]{0,80}cache: 'no-store'/);
});

test('assistant page owns input, messages and pending state', () => {
  const page = readSource('./components/AssistantView.jsx');

  assert.match(page, /const \[inputText, setInputText\] = React\.useState\(''\);/);
  assert.match(page, /const \[messages, setMessages\] = React\.useState\(\[\]\);/);
  assert.match(page, /const \[isLoading, setIsLoading\] = React\.useState\(false\);/);
});

test('assistant page stops its stream and typewriter when cancelled', () => {
  const page = readSource('./components/AssistantView.jsx');

  assert.match(page, /const handleStopGeneration = React\.useCallback/);
  assert.match(page, /abortControllerRef\.current\.abort\(\)/);
  assert.match(page, /typewriter\?\.cancel\(\)/);
  assert.match(page, /if \(!completed \|\| !canonicalThread\)/);
});

test('assistant page retains stream and composer without reply song cards or retired prompt chips', () => {
  const page = readSource('./components/AssistantView.jsx');
  const chrome = readSource('./components/AiReviewChrome.jsx');
  const conversation = readSource('./components/AiReviewConversation.jsx');

  assert.equal(existsSync(new URL('./aiPromptChips.js', import.meta.url)), false);
  assert.equal(existsSync(new URL('./aiPromptChips.test.js', import.meta.url)), false);
  assert.doesNotMatch(`${page}\n${conversation}`, /getAiPromptChips|resolveAiPromptChipText|PROMPT_CHIP_ICONS|activeChips|shouldShowChips|快捷 Prompt Chips/);
  assert.match(page, /event\.type === 'thread_state'/);
  assert.match(page, /event\.type === 'content'/);
  assert.match(page, /event\.type === 'done'/);
  assert.match(chrome, /placeholder="聊聊音乐…"/);
  assert.equal(existsSync(new URL('./components/AssistantMusicCard.jsx', import.meta.url)), false);
  assert.doesNotMatch(conversation, /XiaoaMessageMusicCards|displaySongs|message\.songs/);
  assert.doesNotMatch(page, /displaySongs/);
});

test('home and playlist opening titles stay compact without scaling the page', () => {
  const css = readSource('./index.css');
  const detail = readSource('./components/PlaylistDetailView.jsx');
  const support = readSource('./components/PlaylistDetailSupport.jsx');

  assert.match(css, /\.app-page-heading h1 \{[\s\S]*font-size: clamp\(40px, 4vw, 48px\)/);
  assert.match(css, /\.playlist-loading-shell__copy h2 \{[\s\S]*font-size: clamp\(28px, 3\.6vw, 44px\)/);
  assert.match(css, /\.playlist-title \{[\s\S]*font-size: clamp\(28px, 3\.6vw, 44px\)/);
  assert.match(css, /@media \(max-width: 639px\)[\s\S]*\.app-page-heading h1,[\s\S]*font-size: 34px/);
  assert.match(support, /id="playlist-loading-title" tabIndex=\{-1\} className="line-clamp-2"/);
  assert.match(detail, /className="playlist-title mb-4 line-clamp-2 outline-none md:mb-6"/);
  assert.doesNotMatch(css, /\.collection-page\s*\{[^}]*\b(?:transform:\s*scale|zoom:)/);
  assert.doesNotMatch(css, /\.playlist-detail\s*\{[^}]*\b(?:transform:\s*scale|zoom:)/);
  const main = readSource('./components/MainContent.jsx');
  const search = readSource('./components/SearchView.jsx');
  assert.match(main, /className="collection-page app-content-canvas"/);
  assert.match(search, /className="app-page search-page"/);
  assert.doesNotMatch(search, /className="collection-scroll/);
  assert.match(css, /\.collection-page\s*\{[\s\S]*padding-bottom:\s*calc\(136px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(css, /@media \(max-width: 639px\)[\s\S]*\.collection-page\s*\{[\s\S]*padding-bottom:\s*24px/);
});

test('page navigation owns scroll restoration, admin priority, and playlist focus return', () => {
  const app = readSource('./app.jsx');
  const main = readSource('./components/MainContent.jsx');
  const home = readSource('./components/HomeOverview.jsx');
  const store = readSource('./store/useUIStore.js');

  assert.match(app, /routeScrollPositionsRef/);
  assert.match(app, /routeScrollPositionsRef\.current\[routeEntryRef\.current\] = contentScrollRef\.current\.scrollTop/);
  assert.match(app, /scrollContainerRef=\{contentScrollRef\}/);
  assert.ok(main.indexOf('isViewingAdmin ? (') < main.indexOf("activePage === 'search'"));
  assert.match(home, /data-playlist-id=\{leadPlaylist\?\.id\}/);
  assert.match(home, /openPlaylist\(leadPlaylist, event\)/);
  assert.doesNotMatch(store, /isViewingAllPlaylists|setIsViewingAllPlaylists/);
});

test('authenticated featured tracks play from the main row action while the secondary action only queues next', () => {
  const main = readSource('./components/MainContent.jsx');
  const homeFeatured = readSource('./components/HomeFeaturedSection.jsx');
  const trackRow = readSource('./components/TrackRow.jsx');
  const css = readSource('./index.css');
  assert.match(trackRow, /track-row__main-action"[\s\S]{0,220}onClick=\{\(\) => playSong\(song, songs\)\}/);
  assert.match(homeFeatured, /song=\{song\}[\s\S]{0,120}songs=\{songs\}/);
  assert.doesNotMatch(homeFeatured, /featured-track-list|精选单曲|SELECTED TRACKS/);
  assert.match(trackRow, /<SongActionsMenu[\s\S]*onToggleLiked=\{onToggleLiked \? toggleLiked : undefined\}/);
  const coverZone = trackRow.indexOf('track-row__cover');
  const actionsZone = trackRow.indexOf('track-row__actions');
  assert.ok(coverZone > -1);
  assert.ok(actionsZone > -1);
  assert.ok(trackRow.indexOf('className="playing-bars"', coverZone) < actionsZone);
  assert.equal(trackRow.indexOf('playing-bars', actionsZone), -1);
  assert.equal((trackRow.match(/className="playing-bars"/g) || []).length, 1);
  assert.doesNotMatch(trackRow, /track-cover-hover|group-hover:pointer-events-auto w-8 h-8/);
  assert.match(trackRow, /aria-haspopup="menu"[\s\S]{0,450}<MoreHorizontal size=\{18\}/);
  assert.match(css, /\.playing-bars\s*\{[\s\S]*position:\s*absolute;[\s\S]*right:\s*3px;[\s\S]*bottom:\s*3px;/);
  assert.match(css, /\.playing-bars\s*>\s*div\s*\{[\s\S]*background:\s*var\(--accent\);/);
  assert.match(css, /@media \(max-width: 599px\)[\s\S]*\.track-row__action \{ width: 44px; height: 44px; opacity: 1; \}/);
  assert.match(trackRow, /<SongActionsMenu[\s\S]*onInsertNext=\{onInsertNext\}/);
  assert.doesNotMatch(trackRow, /PlayCircle size=\{20\} className="track-row__play"/);
  assert.doesNotMatch(homeFeatured, /insertAndPlay/);
});

test('manual insert-next actions only show accurate feedback after a successful player update', () => {
  const main = readSource('./components/MainContent.jsx');
  const homeFeatured = readSource('./components/HomeFeaturedSection.jsx');
  const trackRow = readSource('./components/TrackRow.jsx');
  const playerActions = readSource('./services/playerActionsCore.js');

  assert.match(main, /import \{ insertNextWithFeedback \} from '\.\.\/services\/playerActions\.js'/);
  assert.match(playerActions, /if \(!player\.insertAndPlay\(song, null\)\) return false;/);
  assert.match(playerActions, /已将《\$\{song\.title\}》插播为下一首/);
  assert.match(playerActions, /已开始播放《\$\{song\.title\}》/);
  assert.match(trackRow, /onInsertNext=\{onInsertNext\}/);
  assert.equal((homeFeatured.match(/onInsertNext=\{insertNextWithFeedback\}/g) || []).length, 2);
  assert.match(homeFeatured, /onInsertNext=\{onInsertNext\}/);
});

test('homepage editorial cards replace the retired account favorite workspace', () => {
  const css = readSource('./index.css');
  const home = readSource('./components/HomeOverview.jsx');

  assert.match(home, /editorial-card editorial-card--library/);
  assert.match(home, /favoritePlaylist[\s\S]{0,80}source: 'member'[\s\S]{0,80}playlists\[0\]/);
  assert.match(css, /\.editorial-card \{[\s\S]*aspect-ratio: 1\.72 \/ 1/);
  assert.doesNotMatch(css, /\.xiaoa-workspace|\.collection-intro/);
});

test('an empty account playlist uses a compact actionable state without changing other empty playlists', () => {
  const detail = readSource('./components/PlaylistDetailView.jsx');
  const main = readSource('./components/MainContent.jsx');

  assert.match(detail, /isPersonalPlaylist \? \([\s\S]{0,900}className="local-playlist-empty mt-6"/);
  assert.match(detail, /账号歌单还是空的/);
  assert.match(detail, /onClick=\{onOpenAssistant\}[\s\S]{0,180}前往助手挑歌/);
  assert.match(main, /onOpenAssistant=\{\(\) => onNavigate\('assistant'\)\}/);
  assert.match(detail, /\) : \(\s*<section className="state-panel mt-6 p-8 text-center"/);
});

test('playlist drawer centers the active queue row once per open without following later updates', () => {
  const drawer = readSource('./components/PlaylistDrawer.jsx');

  assert.match(drawer, /ref=\{queueScrollRef\}/);
  assert.match(drawer, /ref=\{isActive \? activeRowRef : null\}/);
  assert.match(drawer, /if \(!isPlaylistOpen\) \{[\s\S]{0,100}positionedForOpenRef\.current = false/);
  assert.match(drawer, /if \(!mounted \|\| positionedForOpenRef\.current \|\| !queueScrollRef\.current\) return undefined/);
  assert.match(drawer, /getCenteredQueueScrollTop\(\{[\s\S]{0,240}viewportHeight: container\.clientHeight/);
  assert.match(drawer, /container\.scrollTo\(\{ top, behavior: 'auto' \}\)/);
  assert.match(drawer, /positionedForOpenRef\.current = true/);
});

test('retired public information drawers are absent from the application shell', () => {
  const app = readSource('./app.jsx');
  const store = readSource('./store/useUIStore.js');

  assert.doesNotMatch(app, /AboutDrawer|DmcaDrawer|isAboutOpen|isDmcaOpen/);
  assert.doesNotMatch(store, /isAboutOpen|setIsAboutOpen|isDmcaOpen|setIsDmcaOpen/);
});

test('displayed images own loading while explicit prefetch remains shared', () => {
  const css = readSource('./index.css');
  const lazyImage = readSource('./components/LazyImage.jsx');
  const cover = readSource('./components/PlaylistCover.jsx');
  const registry = readSource('./utils/imageLoadRegistry.js');

  assert.match(lazyImage, /imageLoadRegistry\.getReadySource/);
  assert.match(lazyImage, /imageLoadRegistry\.markReady/);
  assert.match(lazyImage, /imageLoadRegistry\.markError/);
  assert.doesNotMatch(lazyImage, /imageLoadRegistry\.loadWithFallback/);
  assert.doesNotMatch(lazyImage, /new Image\(|\.decode\(\)/);
  assert.doesNotMatch(lazyImage, /setTimeout\([^)]*150/);
  assert.match(cover, /getPlaylistCoverUrls\(playlist, songsMap\)\[0\]/);
  assert.match(cover, /<LazyImage/);
  assert.doesNotMatch(cover, /loadGroup\(fourCoverUrls|vinyl/);
  assert.doesNotMatch(cover, /PlaylistCoverSlot|loading="lazy"[\s\S]{0,180}transition-opacity/);
  assert.match(registry, /IMAGE_READY_TTL_MS = 10 \* 60 \* 1000/);
  assert.match(registry, /IMAGE_REGISTRY_MAX_ENTRIES = 160/);
  assert.match(registry, /IMAGE_LOAD_STALE_MS = 8000/);
  assert.match(registry, /const inflight = new Map\(\)/);
  assert.match(registry, /const active = inflight\.get\(url\);[\s\S]{0,120}return active\.promise/);
  assert.match(registry, /if \(entries\.get\(url\) === entry\) \{[\s\S]{0,120}entries\.delete\(url\);[\s\S]{0,120}notifyCapacityWaiters/);
  assert.doesNotMatch(registry, /Image load timed out|IMAGE_LOAD_TIMEOUT_ERROR_CODE/);
  assert.match(css, /\.lazy-image__asset\.is-revealing[\s\S]*image-reveal 220ms/);
  assert.match(css, /html\[data-page-hidden='true'\] \.image-loading-placeholder::after[\s\S]*animation-play-state: paused !important/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.image-loading-placeholder::after[\s\S]*animation: none !important/);
});
