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

test('closed lazy drawers and dead visual layers do not perform startup work', () => {
  const app = readSource('./app.jsx');
  const environment = readSource('./components/ShellEnvironment.jsx');
  const css = readSource('./index.css');
  const lyricCss = readSource('./theme-animations.css');

  assert.match(app, /const useOpenedOnce = \(isOpen\)/);
  assert.doesNotMatch(app, /AiReviewDrawer|hasOpenedAiDrawer/);
  assert.match(app, /hasOpenedPlaylistDrawer && <PlaylistDrawer/);
  assert.doesNotMatch(app, /AboutDrawer|DmcaDrawer|isAboutOpen|isDmcaOpen/);
  assert.doesNotMatch(environment, /PAPER_DUST_COUNT|shell-environment__paper|shell-environment__sound|shell-environment__dust|data-playing/);
  assert.doesNotMatch(css, /shell-environment__(?:paper|sound|dust)|fluid-aurora-drift|lazy-fade-in|slide-out-left|account-popover-sheet-in|immersive-lyric-(?:text|enter|drift)/);
  assert.doesNotMatch(lyricCss, /lyric-side-line-enter|lyric-multi-|lyric-single-(?:drift|blur-focus|spring|breathe|wind|dew|rain|firefly)-exit/);
  assert.equal(existsSync(new URL('../public/artist-photo-test.html', import.meta.url)), false);
  assert.equal(existsSync(new URL('../../tooling/diagnostics/artist-photo-test.html', import.meta.url)), true);
});

test('playlist navigation has immediate feedback, delayed skeleton, no hover fetch, and stale-request protection', () => {
  const main = readSource('./components/MainContent.jsx');
  const shelf = readSource('./components/PlaylistShelfGrid.jsx');
  const card = readSource('./components/catalog/CollectionCard.jsx');
  const detail = readSource('./components/PlaylistDetailView.jsx');
  const detailSupport = readSource('./components/PlaylistDetailSupport.jsx');

  assert.match(main, /status: 'opening'/);
  assert.match(main, /status: 'skeleton'/);
  assert.match(main, /}, 100\);/);
  assert.match(card, /record-card__opening/);
  assert.doesNotMatch(main, /onPrefetch=\{prefetchPlaylist\}/);
  assert.doesNotMatch(main, /imageLoadRegistry\.loadGroup/);
  assert.match(main, /createLatestRequestGuard/);
  assert.match(main, /requestGuardRef\.current\.isCurrent/);
  assert.match(detail, /PendingPlaylistDetail/);
  assert.match(detailSupport, /playlist-load-error/);
  assert.doesNotMatch(main, /homeKey|shouldCancelPlaylistNavigation/);
  assert.match(main, /const isHomeConcealed = isViewingPlaylist \|\| \['skeleton', 'error'\]\.includes\(playlistLoadState\.status\)/);
  assert.match(main, /const isHomeConcealed = isViewingPlaylist/);
  assert.match(main, /<PlaylistDetailView[\s\S]*isViewingPlaylist=\{isViewingPlaylist && activeRoute\?\.type === 'playlist'\}/);
  assert.match(main, /activeRoute\?\.type === 'playlist'/);
});

test('dock progress stays on the bottom edge and progressBar debounces commits', () => {
  const app = readSource('./app.jsx');
  const playerBar = readSource('./components/PlayerBar.jsx');
  const desktopImmersive = readSource('./components/fullscreen/DesktopImmersivePlayer.jsx');
  const immersiveChrome = readSource('./components/fullscreen/ImmersiveChrome.jsx');
  const progressBar = readSource('./components/playerbar/ProgressBar.jsx');

  assert.match(playerBar, /player-console__progress/);
  assert.match(playerBar, /relative flex items-center w-full[\s\S]*justify-between/);
  assert.doesNotMatch(playerBar, /relative z-20 flex items-center w-full/);
  assert.match(playerBar, /relative z-20 flex items-center flex-shrink-0/);
  assert.match(progressBar, /absolute bottom-0 inset-x-0 z-10 h-3 w-full/);
  assert.doesNotMatch(progressBar, /-inset-y-3/);
  assert.doesNotMatch(desktopImmersive, /musicPlayer_immersive_theme|showThemeMenu|setThemeId/);
  assert.doesNotMatch(immersiveChrome, /Palette|切换沉浸主题|IMMERSIVE_THEMES/);
  assert.match(progressBar, /createDebouncedCommit/);
  assert.match(progressBar, /SEEK_DEBOUNCE_MS = 120/);
  assert.match(progressBar, /onPointerUp=\{flushPendingSeek\}/);
  assert.match(progressBar, /onPointerCancel=\{flushPendingSeek\}/);
  assert.match(progressBar, /onBlur=\{flushPendingSeek\}/);
  assert.match(progressBar, /RANGE_SEEK_KEYS\.has\(event\.key\)/);
  assert.match(progressBar, /pendingSeekRef\.current = null/);
  assert.match(progressBar, /\[activeSongKey, audioRef\]/);
  assert.match(progressBar, /Math\.max\(0, Math\.min\(100,/);
  assert.match(progressBar, /createPortal\(/);
  assert.match(progressBar, /document\.body/);
  assert.match(progressBar, /clientX: e\.clientX/);
});

test('touch tablets keep desktop visual quality while expensive work remains serialized', () => {
  const app = readSource('./app.jsx');
  const desktopPlayer = readSource('./components/fullscreen/DesktopImmersivePlayer.jsx');
  const mobilePlayer = readSource('./components/fullscreen/MobileClassicPlayer.jsx');
  const uiStore = readSource('./store/useUIStore.js');
  const themeHook = readSource('./hooks/useTheme.js');
  const css = readSource('./index.css');
  const drawer = readSource('./components/PlaylistDrawer.jsx');
  const drawerFrame = readSource('./components/drawers/DrawerFrame.jsx');
  const drawerTransition = readSource('./components/drawers/useDrawerTransition.js');
  const mobileBackground = readSource('./components/fullscreen/MobileClassicBackground.jsx');
  const fullscreenTransition = readSource('./hooks/useFullscreenTransition.js');
  const background = readSource('./components/fullscreen/ImmersiveBackground.jsx');
  const trackRow = readSource('./components/TrackRow.jsx');
  const motionProfileHook = readSource('./hooks/useVisualMotionProfile.js');
  const aura = readSource('./components/fullscreen/ImmersiveAudioAura.jsx');

  assert.match(app, /const loadFullScreenPlayer = \(\) => import/);
  assert.match(app, /requestIdleCallback\(warmPlayerCode/);
  assert.match(app, /loadFullScreenPlayer\(\)\.catch/);
  assert.match(app, /data-motion-phase=\{visualMotionPhase\}/);
  assert.match(uiStore, /getPlaylistVisibilityUpdate\(get\(\)\.isPlaylistOpen, val\)/);

  assert.doesNotMatch(themeHook, /getVisualMotionProfile\(window\)/);
  assert.match(themeHook, /const THEME_TRANSITION_MS = 360/);
  assert.match(themeHook, /motionProfile = VISUAL_MOTION_PROFILE\.FULL/);
  assert.match(themeHook, /current === VISUAL_MOTION_PHASE\.THEME[\s\S]{0,120}VISUAL_MOTION_PHASE\.IDLE/);
  assert.doesNotMatch(themeHook, /runInPlaceThemeTransition|runLightweightThemeTransition/);
  assert.match(motionProfileHook, /visualMotionPhaseRef\.current = visualMotionPhase/);
  assert.match(motionProfileHook, /window\.visualViewport\.addEventListener\('resize'/);
  assert.match(motionProfileHook, /'\(pointer: fine\)'/);
  assert.match(motionProfileHook, /'\(hover: hover\)'/);
  assert.match(motionProfileHook, /}, 100\)/);
  assert.match(motionProfileHook, /}, \[\]\);/);
  assert.doesNotMatch(themeHook, /TABLET_IN_PLACE|fade-only/);
  assert.doesNotMatch(css, /tablet-in-place/);
  assert.doesNotMatch(css, /\.theme-transition-overlay/);
  assert.doesNotMatch(css, /lightweight-theme-circle-cover/);
  assert.doesNotMatch(css, /lightweight-theme-paper-cover/);
  assert.doesNotMatch(trackRow, /track-cover-hover|group-hover:pointer-events-auto w-8 h-8/);

  const coverAccentHook = readSource('./hooks/useCoverAccent.js');
  assert.match(coverAccentHook, /DEFAULT_COVER_ACCENT/);
  assert.match(app, /const \{[\s\S]*toggleTheme[\s\S]*\} = useTheme\(isDarkMode, setIsDarkMode, motionProfile\);/);
  assert.match(app, /const coverAccent = useCoverAccent\(\);/);


  assert.match(desktopPlayer, /mediaEnabled=\{hasEntered\}\s+active=\{hasEntered && !isClosing\}/);
  assert.doesNotMatch(desktopPlayer, /deferMedia=/);
  assert.match(desktopPlayer, /const shouldMountAudioAura = hasEntered/);
  assert.match(desktopPlayer, /\{shouldMountAudioAura && <ImmersiveAudioAura/);
  assert.match(desktopPlayer, /enabled=\{hasEntered && immersiveAmbientEnabled/);
  assert.match(desktopPlayer, /suspended=\{suspendPlayerEffects \|\| !hasEntered\}/);
  assert.match(desktopPlayer, /presentationReady=\{hasEntered\}/);
  assert.doesNotMatch(desktopPlayer, /isTabletQuality|qualityProfile|tablet-in-place/);
  assert.match(fullscreenTransition, /setVisualMotionPhase\(VISUAL_MOTION_PHASE\.FULLSCREEN_ENTER\)/);
  assert.match(fullscreenTransition, /setVisualMotionPhase\(VISUAL_MOTION_PHASE\.FULLSCREEN_EXIT\)/);
  assert.match(background, /useArtistPhotos\(\{/);
  assert.doesNotMatch(background, /<video|sampleBrightness/);
  assert.match(aura, /!suspended && \(enabled \|\| isNoLyricsMode\)/);
  assert.doesNotMatch(aura, /qualityProfile|isTabletQuality|tablet-in-place/);
  assert.match(aura, /const maxWidth = 1920/);
  assert.match(aura, /const visible = presentationReady &&/);
  assert.match(aura, /if \(renderPaused\) \{\s*context\.clearRect/);
  assert.match(background, /\{showPhotos && renderArtistPhotoLayer\(\)\}/);
  assert.match(mobileBackground, /coverUrl && hasEntered \? \([\s\S]*<AppleFluidCanvas/);
  assert.match(mobilePlayer, /cubic-bezier\(0\.22,1,0\.36,1\)/);
  assert.match(mobilePlayer, /visualMotionPhase === VISUAL_MOTION_PHASE\.DRAWER/);
  assert.match(desktopPlayer, /visualMotionPhase === VISUAL_MOTION_PHASE\.DRAWER/);

  assert.match(drawer, /<DrawerFrame/);
  assert.match(drawerFrame, /onTransitionEnd=\{onPanelTransitionEnd\}/);
  assert.match(drawerFrame, /duration-\[420ms\]/);
  assert.match(drawerTransition, /secondFrameRef\.current = requestAnimationFrame\(\(\) => setVisible\(true\)\)/);
  assert.match(drawerTransition, /document\.body\.offsetHeight/);
  assert.doesNotMatch(drawer, /cubic-bezier\(0\.34,1\.56,0\.64,1\)/);
  assert.doesNotMatch(drawer, /setTimeout\(\(\) => setMounted\(false\), 350\)/);
});

test('theme switching interpolates semantic colors without snapshots, clipping, or pointer coordinates', () => {
  const themeHook = readSource('./hooks/useTheme.js');
  const css = readSource('./index.css');

  assert.match(themeHook, /const THEME_TRANSITION_MS = 360/);
  assert.match(themeHook, /Object\.entries\(colors\)\.forEach[\s\S]*root\.style\.setProperty\(`--\$\{name\}`, value\)/);
  assert.match(themeHook, /const nextIsDark = !document\.documentElement\.classList\.contains\('dark'\)/);
  assert.match(themeHook, /motionProfile !== VISUAL_MOTION_PROFILE\.REDUCED[\s\S]*setVisualMotionPhase\(VISUAL_MOTION_PHASE\.THEME\)/);
  assert.doesNotMatch(themeHook, /startViewTransition|getEventCoordinates|clipPath|pseudoElement|nativeEvent|flushSync/);

  assert.match(css, /@property --page \{[\s\S]*syntax: '<color>';[\s\S]*inherits: true;/);
  assert.match(css, /:root,[\s\S]*\.music-shell \{[\s\S]*--page 360ms ease,[\s\S]*--drawer-line 360ms ease/);
  assert.match(css, /html,[\s\S]*body,[\s\S]*#root \{[\s\S]*background: var\(--page\)/);
  assert.doesNotMatch(css, /transition: background-color 360ms ease, color 360ms ease/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*:root,[\s\S]*\.music-shell \{[\s\S]*transition: none !important/);
  assert.doesNotMatch(css, /::view-transition|view-transition-name|--vt-|--theme-origin-|in-place-mode-glow|data-theme-to/);
});

test('the confirmed brand name is consistent across metadata, the unique sidebar wordmark, and player titles', () => {
  const html = readSource('../index.html');
  const app = readSource('./app.jsx');
  const sidebar = readSource('./components/AppSidebar.jsx');
  const wordmark = readSource('./components/TuneWordmark.jsx');
  const home = readSource('./components/HomeOverview.jsx');
  const manifest = readSource('../public/manifest.json');
  const playbackPresentation = readSource('./hooks/usePlaybackPresentation.js');

  assert.match(html, /<title>FlareTune<\/title>/);
  assert.match(app, /usePlaybackPresentation\(currentSong, isPlaying\)/);
  assert.match(playbackPresentation, /const DEFAULT_TITLE = 'FlareTune'/);
  assert.match(sidebar, /<TuneWordmark \/>/);
  assert.match(wordmark, />Tune<\/span>/);
  assert.match(home, /<h1>\{t\("主页"\)\}<\/h1>/);
  assert.doesNotMatch(app, /HeaderNav/);

  assert.match(manifest, /"name": "FlareTune"/);
  assert.match(manifest, /"short_name": "Tune"/);
});

test('artist player removes video gating while PlayerBar consumes motionProfile', () => {
  const desktopPlayer = readSource('./components/fullscreen/DesktopImmersivePlayer.jsx');
  const background = readSource('./components/fullscreen/ImmersiveBackground.jsx');
  const playerBar = readSource('./components/PlayerBar.jsx');

  assert.match(desktopPlayer, /const shouldMountAudioAura = hasEntered/);
  assert.doesNotMatch(desktopPlayer, /settledVideoSrc|activeVideoSrc/);
  assert.doesNotMatch(background, /<video|videoSrc/);

  assert.match(playerBar, /export default function PlayerBar\(\{\s*motionProfile\s*=\s*'full',\s*activePage\s*\}\)/);
  assert.match(playerBar, /motionProfile !== VISUAL_MOTION_PROFILE\.COMPACT_TOUCH/);
  assert.match(playerBar, /case 'glass-invisible':/);
  assert.doesNotMatch(playerBar, /player-console--immersive/);
});

test('fluid classic player mounts AppleFluidCanvas for immersive experience', () => {
  const player = readSource('./components/fullscreen/MobileClassicBackground.jsx');

  assert.match(player, /coverUrl && hasEntered \? \([\s\S]*<AppleFluidCanvas/);
});

test('fullscreen locks the root scroller so Chromium does not reserve a black gutter', () => {
  const app = readSource('./app.jsx');
  const css = readSource('./index.css');

  assert.match(app, /useLayoutEffect\(\(\) => \{\s*setFullscreenRootScrollLock/);
  assert.match(app, /setFullscreenRootScrollLock\(document\.documentElement, isFullScreen\)/);
  assert.match(app, /clearFullscreenRootScrollLock\(document\.documentElement\)/);
  assert.match(css, /html\[data-fullscreen-open\][\s\S]*overflow:\s*hidden/);
  assert.match(css, /html\[data-fullscreen-open\]::-webkit-scrollbar[\s\S]*display:\s*none/);
  assert.doesNotMatch(css, /data-fullscreen-open='true'/);
});
test('player surfaces omit collection and assistant entries', () => {
  const playerBar = readSource('./components/PlayerBar.jsx');
  const moreMenu = readSource('./components/PlayerMoreMenu.jsx');
  const chrome = readSource('./components/fullscreen/ImmersiveChrome.jsx');
  const immersive = readSource('./components/fullscreen/DesktopImmersivePlayer.jsx');
  const mobile = readSource('./components/fullscreen/MobileClassicPlayer.jsx');
  const translationIndex = playerBar.indexOf('{showTranslationButton && (');

  assert.ok(translationIndex >= 0, 'expanded controls should retain the translation entry');
  assert.doesNotMatch(playerBar, /toggleFavorite|<Heart|<Star/);
  for (const surface of [playerBar, moreMenu, chrome, immersive, mobile]) {
    assert.doesNotMatch(surface, /data-ai-entry|onOpenAssistant|setIsAiReviewOpen|AiReviewDrawer/);
  }
});

test('PlayerBar separates lyric entry animation from dynamic translateY scroll container', () => {
  const playerBar = readSource('./components/PlayerBar.jsx');
  const lyricPreview = readSource('./components/playerbar/PlayerBarLyricPreview.jsx');
  assert.doesNotMatch(
    lyricPreview,
    /className="[^"]*animate-player-content-drift-in[^"]*"[^>]*style=\{\{\s*transform:\s*`translateY\(-/s,
    'animate-player-content-drift-in must not be placed directly on the element with dynamic transform: translateY style',
  );
  assert.match(
    lyricPreview,
    /key=\{`\$\{currentSong\?\.id\}-lyrics`\}[\s\S]*?className="player-console__lyric-content absolute top-0 left-0 w-full animate-player-content-drift-in/s,
    'lyrics wrapper should host the song transition drift-in animation',
  );
  assert.match(
    lyricPreview,
    /style=\{\{\s*transform:\s*`translateY\(-\$\{translateY\}px\)`\s*\}\}/,
    'inner scrolling container must retain dynamic translateY transform',
  );
  assert.match(playerBar, /<PlayerBarLyricPreview/);
});

test('player surfaces share distinct playback-mode icons and keep the queue icon separate', () => {
  const controls = readSource('./components/PlayerControls.jsx');
  const toggle = readSource('./components/playerbar/PlayModeToggle.jsx');
  const modeIcons = readSource('./components/playerbar/PlaybackModeIcon.jsx');

  for (const [mode, icon] of [
    ['sequence', 'SequenceArrowsIcon'],
    ['loop', 'Repeat'],
    ['single', 'Repeat1'],
    ['random', 'Shuffle'],
  ]) {
    assert.match(
      modeIcons,
      new RegExp(`${mode}: ${icon}`),
      `${mode} should retain its own icon`,
    );
  }

  assert.match(controls, /<PlaybackModeIcon mode=\{playMode\}/);
  assert.match(toggle, /<PlaybackModeIcon mode=\{playMode\}/);
  assert.match(controls, /<ListMusic size=\{22\}/);
});

test('assistant page follows rendered updates while preserving manual history scrolling', () => {
  const page = readSource('./components/AssistantView.jsx');

  assert.match(page, /const shouldFollowMessagesRef = React\.useRef\(true\)/);
  assert.match(page, /const pendingAutoScrollRef = React\.useRef\(false\)/);
  assert.match(page, /const scheduleScrollToLatest = React\.useCallback/);
  assert.match(page, /if \(!pendingAutoScrollRef\.current\) \{/);
  assert.match(page, /if \(shouldFollowMessagesRef\.current\) \{\s*scrollToBottom\(\);/);
});

test('assistant visitor template is retired in favor of the standalone instance gate', () => {
  const app = readSource('./app.jsx');
  const gate = readSource('./instance/InstanceGate.jsx');
  const page = readSource('./components/AssistantView.jsx');
  const conversation = readSource('./components/AiReviewConversation.jsx');
  const chrome = readSource('./components/AiReviewChrome.jsx');

  assert.doesNotMatch(app, /AuthGateView/);
  assert.match(gate, /current === 'app'/);
  assert.doesNotMatch(gate, /小A/);
  assert.doesNotMatch(conversation, /!authenticated|登录后开启|立即登录|onLogin/);
  assert.doesNotMatch(chrome, /登录后发送消息|onLogin/);
  assert.doesNotMatch(page, /handleLogin|onLogin/);
  assert.match(page, /setMessages\(\[\]\);/);
  assert.match(page, /if \(!isAuthed\) \{\s*setPhase\('ready'\);/);
  assert.match(page, /abortControllerRef\.current\?\.abort\(\)/);
  assert.match(page, /if \(!isAuthed \|\| !text \|\| isLoading \|\| phase !== 'ready'\) return;/);
  assert.doesNotMatch(page, /localStorage|Turnstile|turnstile|captcha/i);
});

test('Song/music search only enters through the authenticated application shell', () => {
  const sidebar = readSource('./components/AppSidebar.jsx');
  const app = readSource('./app.jsx');
  const gate = readSource('./instance/InstanceGate.jsx');
  assert.match(sidebar, /\{ id: 'search', label: '搜索'/);
  assert.doesNotMatch(app, /AuthGateView/);
  assert.match(gate, /current === 'app'[\s\S]*<App validatedSession=\{session\}/);
  assert.match(gate, /getInstanceStatus\(\)[\s\S]*getSession\(\)/);
});

test('account playlists remain independent while the assistant page uses account threads', () => {
  const main = `${readSource('./components/MainContent.jsx')}\n${readSource('./components/HomeOverview.jsx')}`;
  const detail = readSource('./components/PlaylistDetailView.jsx');
  const search = readSource('./components/SearchView.jsx');
  const moreMenu = readSource('./components/PlayerMoreMenu.jsx');
  const addToPlaylistModal = readSource('./components/AddToPlaylistModal.jsx');
  const favoriteAction = readSource('./hooks/useFavoriteSongAction.js');
  const assistant = readSource('./components/AssistantView.jsx');
  const conversation = readSource('./components/AiReviewConversation.jsx');
  const eventStream = readSource('./services/aiEventStream.js');
  const playerActionDispatch = readSource('./services/aiPlayerActionDispatch.js');
  const threadSync = readSource('./services/aiThreadSync.js');
  const accountStore = `${readSource('./accountPlaylists.js')}\n${readSource('./services/accountApiRequest.js')}`;
  const accountOrdering = readSource('./accountPlaylistOrdering.js');
  const manageTool = readSource('../../server/src/tools/managePlaylist.js');
  const worker = readSource('../../server/src/routes/localAssistant.js');

  assert.match(main, /favoritePlaylist/);
  assert.match(main, /favoritePlaylist[\s\S]{0,80}source: 'member'[\s\S]{0,80}playlists\[0\]/);
  assert.match(main, /resolveVisibleShelfPlaylists\(\{/);
  assert.match(main, /accountStatus === 'error'/);
  assert.match(accountOrdering, /if \(!authenticated\) return \[\]/);
  assert.match(accountOrdering, /Array\.isArray\(shelf\?\.items\)/);
  assert.match(accountOrdering, /source: 'member'/);
  assert.match(main, /useFavoriteSongAction\(\)/);
  assert.match(main, /onToggleLiked=\{toggleLikedWithFeedback\}/);
  assert.doesNotMatch(detail, /\?list=|分享歌单|Share2/);
  assert.match(detail, /onPlaySong\(playlistSongs\[0\], playlistSongs\)/);
  assert.match(search, /openAddToPlaylist\(selectedSong\)/);
  assert.doesNotMatch(search, /selectedPickerSongIds|selectedTargetIds|addSelectionToPlaylists/);
  assert.match(addToPlaylistModal, /aria-label=\{t\("选择目标歌单"\)\}/);
  assert.match(addToPlaylistModal, /addSongs\(targets, songIds\)/);
  assert.match(addToPlaylistModal, /songIds\.length \* selectedTargetIds\.length > 500/);
  assert.match(addToPlaylistModal, /playlist\.kind === 'favorite'/);
  assert.match(addToPlaylistModal, /accountShelf\?\.items/);
  assert.match(addToPlaylistModal, /playlist\.songCount \|\| 0/);
  assert.match(search, /\{songs\.length > 0 && \(/);
  assert.match(readSource('./components/PlayerControls.jsx'), /toggleFavorite\(currentSong, event\)/);
  assert.doesNotMatch(moreMenu, /setIsAiReviewOpen|data-ai-entry|助手/);
  assert.match(favoriteAction, /accountPlaylistsStore\.getState\(\)\.removeSong/);
  assert.match(favoriteAction, /accountPlaylistsStore\.getState\(\)\.addSongs/);
  assert.match(favoriteAction, /isAccountPlaylistStaleError/);
  assert.match(favoriteAction, /showToast/);
  assert.doesNotMatch(`${main}\n${search}\n${moreMenu}\n${readSource('./components/PlayerControls.jsx')}`, /accountPlaylistsStore\.getState\(\)\.(?:removeSong|addSongs)/);
  const homeOverview = readSource('./components/HomeOverview.jsx');
  assert.match(homeOverview, /onClick=\{\(event\) => leadPlaylist && openPlaylist\(leadPlaylist, event\)\}/);
  assert.match(homeOverview, /onClick=\{\(event\) => leadSong && handleOpenDailyRecommend\(event\)\}/);
  assert.match(homeOverview, /openPlaylist\(\{[\s\S]*id:\s*'daily-recommend'/);

  assert.match(assistant, /consumeSseJsonStream\(response\.body/);
  assert.match(eventStream, /buffer\.split\('\\n'\)/);
  assert.match(playerActionDispatch, /export async function dispatchAiPlayerAction/);
  assert.match(assistant, /event\.type === 'player_action'/);
  assert.match(conversation, /role="status" aria-live="polite"/);
  assert.doesNotMatch(assistant, /client_tool_request/);
  assert.doesNotMatch(assistant, /compactXiaoaHistoryForStorage|GUEST_CHAT_STORAGE_KEY|readGuestMessages/);
  assert.match(conversation, /text-\[var\(--danger\)\]/);
  assert.doesNotMatch(assistant, /playlistProposal|playlist_proposal|localPlaylist:|确认生成小A歌单/);
  assert.doesNotMatch(assistant, /handleSaveSong|加入小A歌单|newPlaylistName|创建并加入/);

  assert.match(accountStore, /credentials: 'include'/);
  assert.match(accountStore, /'X-Requested-With': 'FlareTune'/);
  assert.match(accountStore, /'X-CSRF-Token': csrfToken/);
  assert.match(accountStore, /generation/);
  assert.match(accountStore, /REVISION_CONFLICT|AccountPlaylistRequestError/);
  assert.match(accountStore, /throwBatchFailure\(data\)/);
  assert.match(accountStore, /refreshFailed/);
  assert.match(accountStore, /retainCurrentDetails/);
  for (const action of ['list', 'read', 'create', 'add_songs', 'remove_songs', 'clear', 'replace_songs', 'reorder_songs', 'update_metadata', 'delete']) {
    assert.match(manageTool, new RegExp(`'${action}'`));
  }
  assert.match(assistant, /import \{ getApiBaseUrl \} from '\.\.\/services\/apiBase\.js'/);
  assert.doesNotMatch(assistant, /getXiaoaApiBase|if \(!xiaoaApiBase\)|getApiBaseUrl\(\) \|\| ''/);
  assert.match(threadSync, /authenticatedFetch\(`\$\{apiBase\}\/api\/ai\/thread`/);
  assert.doesNotMatch(assistant, /site: 'music'/);
  assert.doesNotMatch(assistant, /capabilities:\s*\[/);
  assert.doesNotMatch(assistant, /role:\s*['"]system['"]/);
  assert.match(assistant, /message: text/);
  assert.match(assistant, /revision: threadRevisionRef\.current/);
  assert.doesNotMatch(assistant, /messages: normalizeXiaoaMessages/);
  assert.match(assistant, /client_message_id: clientMessageId/);
  assert.match(assistant, /localAssistantMutationHeaders\(authSession\?\.csrfToken\)/);
  assert.doesNotMatch(assistant, /X-XiaoA-CSRF|context: normalizeXiaoaContext/);
  assert.doesNotMatch(assistant, /XiaoaArticleCardGroup|assistantArticles|msg\.articles/);
  assert.match(assistant, /`\$\{getApiBaseUrl\(\)\}\/api\/ai\/chat`/);
  assert.match(worker, /\/api\/ai\/chat/);
  assert.doesNotMatch(assistant, /applyPlaySongNow|insertAndPlay|applyReplacePlayerQueue|applyPlayerQueueEdit|applyPlayerControl/);
  assert.doesNotMatch(worker, /playlist_proposal|normalizeLocalPlaylistContext|isPlaylistGenerationRequest/);
  assert.doesNotMatch(worker, /localStorage/);
  assert.doesNotMatch(worker, /\/api\/ai\/playlist/);
});

test('Xiaoa chat and bootstrap are authenticated-only and no longer ship visitor verification', () => {
  const page = readSource('./components/AssistantView.jsx');
  const worker = readSource('../../server/src/instance/httpRouter.js');
  const assistantRoute = readSource('../../server/src/routes/localAssistant.js');

  assert.match(page, /if \(!isAuthed\) return undefined;[\s\S]*?\/api\/ai\/bootstrap/);
  assert.match(page, /if \(!isAuthed \|\| !text \|\| isLoading \|\| phase !== 'ready'\) return;/);
  assert.doesNotMatch(page, /Turnstile|turnstile|captcha|cf_turnstile_response|PUBLIC_TURNSTILE_SITEKEY/i);
  assert.match(worker, /decideApiAccess\(\{ path, method: request\.method, instanceState: instance\.state, session \}\)/);
  assert.match(worker, /if \(!session && access\.category !== 'setup'/);
  assert.match(assistantRoute, /path === '\/api\/ai\/chat' && request\.method === 'POST'/);
});

test('player mode stays a persisted runtime state independent from shell theme', () => {
  const modes = readSource('./constants/playerModes.js');
  const store = readSource('./store/useUIStore.js');
  const router = readSource('./components/FullScreenPlayer.jsx');

  assert.match(modes, /PLAYER_MODE_STORAGE_KEY = 'musicPlayer_player_mode_v1'/);
  assert.match(modes, /DEFAULT_PLAYER_MODE = PLAYER_MODES\.CLASSIC/);
  assert.doesNotMatch(modes, /PORTRAIT|portrait/);
  assert.match(modes, /getInitialPlayerMode\(\)/);

  assert.match(store, /playerMode: getInitialPlayerMode\(\)/);
  assert.match(store, /setPlayerMode: \(mode\) => \{[\s\S]*if \(!isPlayerMode\(mode\)\) return;[\s\S]*writeStoredPlayerMode\(mode\)[\s\S]*set\(\{ playerMode: mode \}\)/);

  assert.match(router, /playerMode === PLAYER_MODES\.CINEMATIC && isDesktop/);
  assert.doesNotMatch(router, /if \(shellThemeId === 'fluid' \|\| shellThemeId === 'paper'\) \{/);
});

test('current-only frontend rejects retired shell, URL, origin, storage, and player action formats', () => {
  const index = readSource('../index.html');
  const app = readSource('./app.jsx');
  const headers = readSource('../public/_headers');
  const theme = readSource('./hooks/useTheme.js');
  const musicCache = readSource('./musicDataCache.js');
  const randomCache = readSource('./randomSongCache.js');
  const playerContext = readSource('./playerContext.js');
  const playerStore = readSource('./store/usePlayerStore.js');
  const uiStore = readSource('./store/useUIStore.js');
  const drawer = readSource('./components/AssistantView.jsx');
  const playerActions = readSource('./assistantPlayerActions.js');

  assert.doesNotMatch(index, /musicPlayer_shell_theme_v2|soundscape|shellThemes\.paper/);
  assert.doesNotMatch(headers, /https:\/\/(?:www\.|blog\.)?arctan\.top|arcinks\.com/);
  assert.doesNotMatch(theme, /stored === 'dark' \|\| stored === 'light'/);
  assert.doesNotMatch(musicCache, /LEGACY_MUSIC_DATA_CACHE_KEYS|musicPlayer_api_init_v[5-8]/);
  assert.doesNotMatch(musicCache, /MUSIC_DATA_CACHE_KEY|inspectMusicDataCache/);
  assert.doesNotMatch(randomCache, /LEGACY_RANDOM_SONGS_CACHE_KEYS|musicPlayer_xiaoa_random_songs_v1/);
  assert.doesNotMatch(playerContext, /LEGACY_STORAGE_KEY|readLegacyContext|musicPlayer_player|songId|song_id|audioKey|coverKey|current_song_id|session_id|seed_queue|updated_at/);
  assert.match(playerContext, /value\.schema !== PLAYER_CONTEXT_SCHEMA/);
  assert.doesNotMatch(playerStore, /showTranslation|netease/);
  assert.match(playerStore, /name: 'musicPlayer_player',[\s\S]{0,100}version: 1,[\s\S]{0,100}migrate: \(\) => undefined/);
  assert.match(uiStore, /name: 'musicPlayer_ui',[\s\S]{0,100}version: 1,[\s\S]{0,100}migrate: \(\) => undefined/);
  assert.doesNotMatch(uiStore, /migrate:\s*\(persistedState\)/);
  assert.doesNotMatch(drawer, /const action = eventData\.action|eventData\.song \|\||eventData\.songs/);
  assert.doesNotMatch(playerActions, /player_seek|seek_seconds|seek_percent|position_seconds \?\?|position_percent \?\?/);
});

test('all current overlays participate in inertness and browser-back closing', () => {
  const app = readSource('./app.jsx');
  for (const stateKey of [
    'isAddToPlaylistOpen',
    'isBackgroundDrawerOpen',
    'isAccountPlaylistOpen',
  ]) {
    assert.match(app, new RegExp(`\\['${stateKey}',`));
    assert.match(app, new RegExp(`secondaryModalOpen =[\\s\\S]*${stateKey}`));
  }
  assert.match(app, /if \(!closeTopOverlay\(state\)\)/);
});

test('desktop mode icon shows current state and mobile more menu holds explicit choices', () => {
  const entry = readSource('./components/PlayerSkinEntry.jsx');
  const classic = readSource('./components/fullscreen/ClassicDesktopLayout.jsx');
  const mobile = readSource('./components/fullscreen/MobilePlayerLayout.jsx');
  const panes = readSource('./components/fullscreen/MobileClassicPanes.jsx');
  const immersive = readSource('./components/fullscreen/DesktopImmersivePlayer.jsx');
  const chrome = readSource('./components/fullscreen/ImmersiveChrome.jsx');

  assert.match(entry, /aria-label=\{t\("当前\{p0\}，点击切换到\{p1\}", \{ p0: \(currentLabel\), p1: \(nextLabel\) \}\)\}/);
  assert.match(entry, /onClick=\{\(\) => setPlayerMode\(nextMode\)\}/);
  assert.match(entry, /group-hover:opacity-100/);
  assert.doesNotMatch(entry, /aria-haspopup|<PlayerModeChoices/);
  assert.match(entry, /type="button"/);

  assert.match(classic, /<PlayerSkinEntry variant="classic" \/>/);
  assert.doesNotMatch(mobile, /PlayerSkinEntry/);
  assert.match(panes, /<PlayerMoreMenu[\s\S]*?showPlayerModes \/>/);
  assert.match(immersive, /modeSwitcher=\{<PlayerSkinEntry variant="immersive" \/>\}/);
  assert.match(chrome, /modeSwitcher = null/);
  assert.match(chrome, /stopPropagation\(\)/);
  assert.doesNotMatch(classic, /PlayerModeSwitcher/);
});

test('fullscreen lyric entry opens the shared workspace without a tools drawer', () => {
  const moreMenu = readSource('./components/PlayerMoreMenu.jsx');
  const toolsEntry = readSource('./components/LyricsWorkspaceEntry.jsx');
  const lyricsWorkspace = readSource('./components/LyricsManagementWorkspace.jsx');
  const app = readSource('./app.jsx');
  const chrome = readSource('./components/fullscreen/ImmersiveChrome.jsx');
  const immersive = readSource('./components/fullscreen/DesktopImmersivePlayer.jsx');

  assert.match(moreMenu, /歌词工作台/);
  assert.match(moreMenu, /openLyricsWorkspace\(currentSong\)/);
  assert.match(moreMenu, /Boolean\(state\.authSession\.authenticated\)/);

  assert.match(toolsEntry, /Boolean\(state\.authSession\.authenticated\)/);
  assert.match(toolsEntry, /if \(!isAuthenticated \|\| !currentSong\?\.id\) return null;/);
  assert.match(toolsEntry, /openLyricsWorkspace\(currentSong\)/);
  assert.match(lyricsWorkspace, /managed\.saveDocument/);
  assert.match(lyricsWorkspace, /managed\.shiftTimeline/);
  assert.match(lyricsWorkspace, /managed\.importLrc/);
  assert.doesNotMatch(lyricsWorkspace, /updateSongLanguage|歌曲语言<select/);
  assert.match(lyricsWorkspace, /authenticated && managed\.aiCompletionEnabled && \(!editing \|\| isAdmin\) && <button/);
  assert.match(lyricsWorkspace, /managed\.isAiCompleting/);
  assert.doesNotMatch(lyricsWorkspace, /manageApi\.updateSong/);
  assert.match(lyricsWorkspace, /lyricsWorkspaceApi\.getLyricsCandidates\(song\.id/);
  assert.match(lyricsWorkspace, /managed\.completeTranslation\(\)/);
  assert.doesNotMatch(app, /PlayerToolsDrawer/);
  assert.match(readSource('./components/MainContent.jsx'), /<LyricsManagementWorkspace route=\{activeRoute\}/);
  assert.doesNotMatch(app, /isLyricsWorkspaceOpen/);

  assert.match(chrome, /toolEntry = null/);
  assert.match(immersive, /toolEntry=\{<LyricsWorkspaceEntry variant="immersive" \/>\}/);
});

test('random suggestions stay auth-gated and persist a single local cache key', () => {
  const mainContent = readSource('./components/MainContent.jsx');
  const home = readSource('./components/HomeOverview.jsx');
  const hook = readSource('./hooks/useRandomSongs.js');
  const cache = readSource('./randomSongCache.js');
  const request = readSource('./randomSongRequest.js');
  const worker = readSource('../../server/src/instance/httpRouter.js');
  const songs = readSource('../../server/src/routes/localMusicDiscovery.js');

  assert.match(cache, /RANDOM_SONGS_CACHE_KEY = 'musicPlayer_xiaoa_random_songs_v2'/);
  assert.match(cache, /isValidRandomSongCache\(payload\?\.songs\)/);
  assert.match(cache, /isValidSongLanguage\(song\.language\)/);
  assert.match(request, /\/api\/songs\/random/);
  assert.match(hook, /buildRandomSongsUrl\(apiBase, excludeIds\)/);
  assert.match(hook, /requestSongs\(songs\.map\(\(song\) => String\(song\?\.id \|\| ''\)\)\)/);
  assert.match(songs, /CASE WHEN s\.id IN/);
  assert.match(hook, /credentials: 'include'/);
  assert.match(hook, /import \{ getApiBaseUrl \} from '\.\.\/services\/apiBase\.js'/);
  assert.match(hook, /getApiBaseUrl\(\)/);
  assert.match(hook, /loadRandomSongs\(\)/);
  assert.match(hook, /saveRandomSongs\(/);
  assert.match(mainContent, /useRandomSongs\(isAuthenticated\)/);
  assert.match(mainContent, /handleRefreshRandomSongs/);
  assert.match(mainContent, /randomSongs=\{randomSongs\}/);
  assert.match(home, /const pool = randomSongs\?\.length \? randomSongs : likedSongs/);
  assert.match(worker, /handleLocalMusicDiscoveryRoute\(request/);
  assert.match(worker, /decideApiAccess\(/);
  assert.match(songs, /isRandom = pathname === '\/api\/songs\/random' && request\.method === 'GET'/);
  assert.match(songs, /if \(isRandom\) return randomSongs/);
  assert.match(songs, /s\.audio_url IS NOT NULL AND TRIM\(s\.audio_url\) <> ''/);
});

test('stale queue resolves authoritative language before playback', () => {
  const playerContext = readSource('./hooks/usePlayerContext.js');
  const resolver = readSource('./resolveSongs.js');

  assert.match(playerContext, /repairSongLanguages\(queue/);
  assert.match(playerContext, /patchPlayerContextSongMetadata\(authoritativeSongs\)/);
  assert.match(resolver, /isValidSongLanguage\(song\.language\)/);
  assert.doesNotMatch(resolver, /has_lyrics|needs_translation/);
});

test('player context waits for identity and never repairs or persists an anonymous queue', () => {
  const playerContext = readSource('./hooks/usePlayerContext.js');

  assert.match(playerContext, /if \(!authInitialized\) return undefined/);
  assert.match(playerContext, /if \(!authenticated\) \{[\s\S]*await clearPlayerContext\(\)/);
  assert.match(playerContext, /if \(!useUIStore\.getState\(\)\.authSession\?\.authenticated\) return/);
  assert.ok(
    playerContext.indexOf('if (!authenticated)')
      < playerContext.indexOf('repairSongLanguages(queue'),
  );
});

test('random roam has a home entry, queue switch, app-level continuation and local player persistence', () => {
  const main = readSource('./components/MainContent.jsx');
  const home = readSource('./components/HomeOverview.jsx');
  const roam = readSource('./components/RoamOverview.jsx');
  const queue = readSource('./components/PlaylistDrawer.jsx');
  const app = readSource('./App.jsx');
  const hook = readSource('./hooks/useRandomRoam.js');
  const store = readSource('./store/usePlayerStore.js');
  const worker = readSource('../../server/src/instance/httpRouter.js');
  const songs = readSource('../../server/src/routes/localMusicDiscovery.js');

  assert.match(home, /onClick=\{onToggleRoam\}/);
  assert.match(main, /startRandomRoam\(randomSongs/);
  assert.match(main, /setRandomRoamEnabled/);
  assert.match(roam, /aria-label=\{randomRoam\.enabled \? t\("暂停漫游"\) : t\("开启漫游电台"\)\}/);
  assert.match(queue, /队尾随机续播/);
  assert.match(queue, /role="switch"/);
  assert.match(queue, /retryRandomRoam/);
  assert.match(app, /useRandomRoam\(\{ authenticated, isPlayerContextReady \}\)/);
  assert.match(hook, /shouldPrefetchRandomRoam/);
  assert.match(hook, /credentials: 'include'/);
  assert.match(hook, /method: 'POST'/);
  assert.match(store, /randomRoam: \{[\s\S]{0,120}\.\.\.state\.randomRoam[\s\S]{0,180}resumeWhenAppended: false/);
  assert.match(store, /waitingAtQueueEnd/);
  assert.match(store, /resumeWhenAppended/);
  assert.match(store, /removePlaylistSong/);
  assert.match(store, /本轮已漫游完整个曲库/);
  assert.match(worker, /handleLocalMusicDiscoveryRoute\(request/);
  assert.match(songs, /isRoam = pathname === '\/api\/songs\/roam' && request\.method === 'POST'/);
  assert.match(songs, /totalPlayable: playable\.length/);
  assert.match(songs, /remainingPlayable/);
  assert.match(songs, /exhausted: remainingPlayable === 0/);
  assert.match(songs, /s\.audio_url IS NOT NULL AND TRIM\(s\.audio_url\) <> ''/);
});

test('playlist requests live in the DOM-free payload loader while MainContent keeps navigation orchestration', () => {
  const main = readSource('./components/MainContent.jsx');
  const home = readSource('./components/HomeOverview.jsx');
  const homeCollections = readSource('./components/HomeCollectionSections.jsx');
  const playlistLoader = readSource('./services/playlistPayloadLoader.js');
  const cover = readSource('./components/PlaylistCover.jsx');
  const trackRow = readSource('./components/TrackRow.jsx');
  const shelf = readSource('./components/PlaylistShelfGrid.jsx');
  const detail = readSource('./components/PlaylistDetailView.jsx');

  assert.match(main, /import PlaylistDetailView from '.\/PlaylistDetailView\.jsx'/);
  assert.match(home, /import TrackRow from '.\/TrackRow\.jsx'/);
  assert.match(main, /import \{ createMemberPlaylistInfo, loadPlaylistPayload \} from '\.\.\/services\/playlistPayloadLoader\.js'/);
  assert.match(main, /createLatestRequestGuard/);
  assert.match(main, /loadPlaylistPayload/);
  assert.doesNotMatch(main, /const loadPlaylistPayload|playlistDataCache|revalidateExpiringCache/);
  assert.match(playlistLoader, /createExpiringAsyncCache/);
  assert.match(playlistLoader, /accountPlaylistsStore\.getState\(\)\.loadDetail/);
  assert.match(playlistLoader, /playlist\.type === 'library' \|\| playlist\.id\?\.startsWith\('lang-'\)/);
  assert.match(playlistLoader, /playlist\.preloadedSongs/);
  assert.match(playlistLoader, /playlist\.songs/);
  assert.doesNotMatch(playlistLoader, /\/api\/playlists\/\$\{playlist\.id\}/);
  assert.match(playlistLoader, /throw new Error\('歌单不存在'\)/);
  assert.match(main, /<PlaylistDetailView/);
  assert.match(home, /<TrackRow/);
  assert.match(detail, /<TrackRow/);
  assert.match(shelf, /<CollectionCard/);
  assert.match(readSource('./components/catalog/CollectionCard.jsx'), /<PlaylistCover/);
  assert.match(cover, /<LazyImage/);
  for (const presentational of [cover, detail, shelf, trackRow, homeCollections]) {
    assert.doesNotMatch(presentational, /\bfetch\s*\(/);
    assert.doesNotMatch(presentational, /createLatestRequestGuard|createExpiringAsyncCache|revalidateExpiringCache/);
  }
});

test('Phase 51D account playlist management is member-only, lazy, inert and history-aware', () => {
  const app = readSource('./app.jsx');
  const store = readSource('./store/useUIStore.js');
  const main = readSource('./components/MainContent.jsx');
  const drawer = readSource('./components/AccountPlaylistDrawer.jsx');

  assert.match(main, /onManageShelf=\{\(\) => setIsAccountPlaylistOpen\(true\)\}/);
  assert.match(app, /AccountPlaylistDrawer = React\.lazy/);
  assert.match(app, /hasOpenedAccountPlaylistDrawer && <AccountPlaylistDrawer \/>/);
  assert.match(app, /secondaryModalOpen[\s\S]*isAccountPlaylistOpen/);
  assert.match(app, /const modalOpen = isFullScreen \|\| secondaryModalOpen/);
  assert.match(app, /\['isAccountPlaylistOpen', 'setIsAccountPlaylistOpen'\]/);
  assert.match(store, /isAccountPlaylistOpen: false/);
  assert.match(store, /setIsAccountPlaylistOpen:/);
  assert.match(store, /isPlaylistOpen: false/);
  assert.doesNotMatch(store, /isAiReviewOpen|setIsAiReviewOpen/);
  assert.match(store, /previousAccountId !== nextAccountId \? \{[\s\S]*isAccountPlaylistOpen: false/);
  assert.match(drawer, /previousFocusRef/);
  assert.match(drawer, /target\.focus\(\{ preventScroll: true \}\)/);
});

test('identity-aware song reads include credentials and rely on the global session gate', () => {
  const app = readSource('./app.jsx');
  const songApi = readSource('./services/songApi.js');
  const songResolver = readSource('./resolveSongs.js');
  const lyrics = readSource('./hooks/useLyricsFetcher.js');
  const drawer = readSource('./components/AssistantView.jsx');
  const worker = readSource('../../server/src/instance/httpRouter.js');
  const songs = readSource('../../server/src/routes/localMusicRead.js');
  const artistPhotos = readSource('./hooks/useArtistPhotos.js');
  assert.match(songApi, /api\/songs\/\$\{encodeURIComponent\(normalizedId\)\}[\s\S]{0,160}credentials: 'include',[\s\S]{0,80}cache: 'no-store'/);
  assert.match(songResolver, /\/api\/songs\/resolve[\s\S]*credentials: 'include'/);
  assert.doesNotMatch(lyrics, /songUrl/);
  assert.match(lyrics, /songLanguageHasLyrics\(currentSong\?\.language\)/);
  assert.match(lyrics, /const url = `\$\{getApiBaseUrl\(\)\}\/api\/lyrics\?songId=/);
  assert.match(lyrics, /authenticatedFetch\(url, \{ credentials: 'include' \}\)/);
  assert.doesNotMatch(lyrics, /\/api\/lyrics\/translation|source=/);
  assert.match(artistPhotos, /api\/artist-photo\?name=[\s\S]{0,120}credentials: 'include'/);
  assert.match(artistPhotos, /ARTIST_PHOTO_IMAGE_CACHE\.set\(url, pending\)/);
  assert.match(artistPhotos, /clearTimeout\(timeoutId\)/);
  assert.doesNotMatch(drawer, /fetchSongById\(songId\)|music-play-song-id/);
  assert.doesNotMatch(drawer, /\/api\/songs\?id=/);
  assert.equal(existsSync(new URL('./utils/xiaoaSongResolver.js', import.meta.url)), false);
  assert.doesNotMatch(worker, /handleGetSongById|searchParams\.get\('id'\)/);
  assert.match(worker, /handleLocalMusicDiscoveryRoute\(request/);
  assert.match(worker, /handleLocalMetadataReadRoute\(request/);
  assert.match(worker, /decideApiAccess\(/);
  assert.match(worker, /if \(!session && access\.category !== 'setup'/);
  assert.doesNotMatch(worker, /checkGuestRateLimit|checkRateLimit\(/);
  assert.doesNotMatch(songs, /visibleSongSql|requires_login/);
  assert.match(songs, /WHERE s\.id = \?/);
  assert.match(songs, /private, no-store/);
  assert.equal(existsSync(new URL('../../server/src/utils/songVisibility.js', import.meta.url)), false);
  assert.equal(existsSync(new URL('../public/data/songs.json', import.meta.url)), false);
});

test('library view displays full playlists and shelf management while home focuses on immediate listening stream', () => {
  const main = readSource('./components/MainContent.jsx');
  const home = readSource('./components/HomeOverview.jsx');
  const store = readSource('./store/useUIStore.js');
  const allPlaylists = readSource('./components/AllPlaylistsView.jsx');

  assert.doesNotMatch(store, /isViewingAllPlaylists|setIsViewingAllPlaylists/);
  assert.doesNotMatch(home, /record-shelf--single-row/);
  assert.doesNotMatch(home, /quick-roam-banner/);
  assert.match(main, /import AllPlaylistsView from '\.\/AllPlaylistsView\.jsx'/);
  assert.match(main, /<AllPlaylistsView/);
  assert.match(allPlaylists, /<PlaylistShelfGrid/);
  assert.match(allPlaylists, /资料库|全部歌单/);
  assert.doesNotMatch(allPlaylists, /\bfetch\s*\(/);
  assert.doesNotMatch(allPlaylists, /createLatestRequestGuard|createExpiringAsyncCache|revalidateExpiringCache/);
});

test('home explore shelf displays direct 6 categories with carousel navigation and responsive scroll track', () => {
  const main = readSource('./components/MainContent.jsx');
  const homeCollections = readSource('./components/HomeCollectionSections.jsx');
  const trackCss = readSource('./styles/track.css');

  assert.match(main, /items=\{EXPLORE_CATEGORIES\}/);
  assert.match(homeCollections, /className="explore-shelf"/);
  assert.match(homeCollections, /<HorizontalScrollButtons variant="header"/);
  assert.match(homeCollections, /handleScroll/);
  assert.match(trackCss, /grid-template-columns:\s*repeat\(6,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(trackCss, /scroll-snap-type:\s*x mandatory/);
  assert.doesNotMatch(homeCollections, /explore-shelf--single-row/);
  assert.doesNotMatch(trackCss, /explore-shelf--single-row/);
});

test('add to playlist modal and multi-page track actions integrate across random picks, playlist details, and search', () => {
  const modal = readSource('./components/AddToPlaylistModal.jsx');
  const store = readSource('./store/useUIStore.js');
  const trackRow = readSource('./components/TrackRow.jsx');
  const main = readSource('./components/MainContent.jsx');
  const detail = readSource('./components/PlaylistDetailView.jsx');
  const app = readSource('./App.jsx');

  assert.match(store, /isAddToPlaylistOpen: false/);
  assert.match(store, /openAddToPlaylist:/);
  assert.match(modal, /aria-label=\{t\("选择目标歌单"\)\}/);
  assert.match(modal, /accountPlaylistsStore\.getState\(\)\.addSongs/);
  assert.match(modal, /isTopmostModal/);
  assert.match(modal, /trapDrawerTabKey/);
  assert.match(modal, /addEventListener\('keydown', handleModalTabKey, true\)/);
  assert.match(trackRow, /SongActionsMenu/);
  assert.match(trackRow, /onAddToPlaylist/);
  assert.match(main, /openAddToPlaylist/);
  assert.match(detail, /onAddToPlaylist=\{onAddToPlaylist\}/);
  assert.match(app, /<AddToPlaylistModal \/>/);
});

test('assistant entry remains on the main sidebar and empty playlist', () => {
  const sidebar = readSource('./components/AppSidebar.jsx');
  const moreMenu = readSource('./components/PlayerMoreMenu.jsx');
  const immersive = readSource('./components/fullscreen/ImmersiveChrome.jsx');
  const detail = readSource('./components/PlaylistDetailView.jsx');
  const app = readSource('./app.jsx');
  const main = readSource('./components/MainContent.jsx');
  const gate = readSource('./instance/InstanceGate.jsx');

  assert.match(sidebar, /data-ai-entry="sidebar"/);
  assert.match(sidebar, /navigate\('assistant'\)/);
  assert.match(sidebar, /<span>\{t\("助手"\)\}<\/span>/);
  assert.doesNotMatch(sidebar, /<span>小A<\/span>|data-tooltip="小A"/);
  assert.doesNotMatch(moreMenu, /<span>助手<\/span>|data-ai-entry|setIsAiReviewOpen/);
  assert.doesNotMatch(immersive, /onOpenAssistant|data-ai-entry/);
  assert.match(detail, /前往助手挑歌/);
  assert.match(main, /<AssistantView isAuthenticated\b/);
  assert.doesNotMatch(app, /AiReviewDrawer|isAiReviewOpen|hasOpenedAiDrawer/);
  assert.doesNotMatch(
    `${moreMenu}\n${immersive}\n${detail}\n${app}\n${gate}`,
    /小A/,
  );
});

test('protected pages rely on the app auth gate without shipping visitor UI branches', () => {
  const home = readSource('./components/HomeOverview.jsx');
  const search = readSource('./components/SearchView.jsx');
  const lyrics = readSource('./components/LyricsManagementWorkspace.jsx');
  const main = readSource('./components/MainContent.jsx');

  assert.doesNotMatch(home, /isAuthenticated|SELECTED TRACKS|精选单曲/);
  assert.doesNotMatch(search, /登录后才能使用曲库搜索|isAuthenticated && status/);
  assert.doesNotMatch(lyrics, /lyrics-workspace__auth|访客状态|登录后管理共享歌词/);
  assert.doesNotMatch(main, /曲库探索仅对登录用户开放|isAuthenticated \? toggleLikedWithFeedback/);

  assert.match(search, /if \(!isAuthenticated\) \{/);
  assert.match(lyrics, /enabled: Boolean\(baseSong\?\.id\) && authenticated/);
  assert.match(main, /useRandomSongs\(isAuthenticated\)/);
});

test('Explore library section is gated for authenticated members only on client and server', () => {
  const main = readSource('./components/MainContent.jsx');
  const languageCounts = readSource('./hooks/useSongLanguageCounts.js');
  const worker = readSource('../../server/src/instance/httpRouter.js');

  // Client gates explore section with isAuthenticated
  assert.match(main, /<RoamOverview[\s\S]*isAuthenticated/);
  // Client gates remote language counts fetch
  assert.match(main, /useSongLanguageCounts\(isAuthenticated && activePage === 'roam' && activeRoute\?\.type === 'page'\)/);
  assert.match(languageCounts, /if \(!isAuthenticated\) return undefined;[\s\S]*\/api\/songs\?counts=language/);
  // Server applies one session gate before all Tune business routes.
  assert.match(worker, /decideApiAccess\(/);
  assert.match(worker, /if \(!session && access\.category !== 'setup'/);
});

test('vertical volume control uses the standardized range direction', () => {
  const volumeControl = readSource('./components/playerbar/VolumeControl.jsx');
  assert.match(volumeControl, /writingMode:\s*'vertical-lr'/);
  assert.match(volumeControl, /direction:\s*'rtl'/);
  assert.doesNotMatch(volumeControl, /slider-vertical/);
});

test('daily recommend full playlist provides refresh button with natural transition and MainContent wiring', () => {
  const detail = readSource('./components/PlaylistDetailView.jsx');
  const main = readSource('./components/MainContent.jsx');

  assert.match(detail, /isDailyRecommend/);
  assert.match(detail, /onRefreshDailyRecommend/);
  assert.match(detail, /isRefreshingDailyRecommend/);
  assert.match(detail, /transition-opacity/);
  assert.match(main, /handleRefreshDailyRecommendInDetail/);
  assert.match(main, /onRefreshDailyRecommend=\{handleRefreshDailyRecommendInDetail\}/);
  assert.match(main, /isRefreshingDailyRecommend=\{isRandomRefreshing\}/);
});

test('retired public information entries are absent from Settings and the account popover', () => {
  const settings = readSource('./components/SettingsView.jsx');
  const accountMenu = readSource('./components/AccountMenu.jsx');

  assert.doesNotMatch(settings, /关于与版权|SITE_PROFILE|dmca@arcinks\.com/);
  assert.doesNotMatch(accountMenu, /setIsAboutOpen|setIsDmcaOpen|关于 Tune|关于旧站点|版权与权利通知/);
});

test('the single application sidebar replaces the retired global header', () => {
  const shellCss = readSource('./styles/app-shell.css');
  const componentsCss = readSource('./styles/components.css');
  const app = readSource('./app.jsx');

  assert.equal(existsSync(new URL('./components/HeaderNav.jsx', import.meta.url)), false);
  assert.equal(existsSync(new URL('./styles/header.css', import.meta.url)), false);
  assert.match(app, /<AppSidebar activePage=\{activePage\} activeRoute=\{activeRoute\} onNavigate=\{handleNavigate\} \/>/);
  assert.match(shellCss, /--app-sidebar-width:\s*(?:232px|260px)/);
  assert.match(shellCss, /\.app-sidebar \{[\s\S]*border-right: 1px solid var\(--line\)/);
  assert.match(componentsCss, /\.collection-scroll\s*\{[\s\S]*overflow-x: hidden;[\s\S]*padding-top: 0/);
});
