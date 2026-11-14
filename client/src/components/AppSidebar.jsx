import { t, useLocale } from '../i18n/index.js';
import React from 'react';
import {
  Activity,
  Bot,
  Disc,
  Home,
  Library,
  Languages,
  Menu,
  MessageCircle,
  Brain,
  PictureInPicture,
  PictureInPicture2,
  Plus,
  Puzzle,
  Palette,
  Search,
  Shuffle,
  Settings,
  FileText,
  Trash2,
  UserRound,
  Users,
  X,
} from 'lucide-react';
import AccountMenu from './AccountMenu.jsx';
import SidebarMiniPlayer from './SidebarMiniPlayer.jsx';
import TuneWordmark from './TuneWordmark.jsx';
import PageBackButton from './PageBackButton.jsx';
import { useCompactPlayerPlacement } from '../hooks/useCompactPlayerPlacement.js';
import { useSidebarNavigationMotion } from '../hooks/useSidebarNavigationMotion.js';
import { useUIStore } from '../store/useUIStore.js';
import { formatPath, syncBrowserHistory, returnFromSidebarWorkspace, returnToParentRoute } from '../utils/navigation.js';
import { getPlugin, getPluginPages, getPluginPage, getPluginEntryRoute, getPrimaryPluginSettingsPageId, localizePlugin } from '../plugins/registry.js';
import { usePluginStore } from '../store/usePluginStore.js';
import { usePluginMenu } from '../hooks/usePluginMenu.js';
import PluginActionDialog from './PluginActionDialog.jsx';

const PRIMARY_ITEMS = [
  { id: 'home', label: '主页', icon: Home, order: 10 },
  { id: 'search', label: '搜索', icon: Search, order: 20 },
  { id: 'roam', label: '漫游', icon: Shuffle, order: 30 },
  { id: 'library', label: '资料库', icon: Library, order: 40 },
];

const PERSONAL_SETTINGS = [
  { id: 'appearance', label: '外观与播放', icon: Palette },
  { id: 'personal', label: '个人设置', icon: UserRound },
];

const ADMIN_SETTINGS = [
  { id: 'admin-catalog', label: '曲库管理', icon: Disc },
  { id: 'admin-add-song', label: '歌曲入库', icon: Plus },
  { id: 'admin-accounts', label: '账号管理', icon: Users },
  { id: 'admin-system', label: '实例设置', icon: Activity },
];
const LYRICS_SECTIONS = [
  { id: 'current', label: '当前歌词', icon: Languages },
  { id: 'tools', label: '文件与管理', icon: FileText },
  { id: 'candidates', label: '候选歌词', icon: Search },
];

export default function AppSidebar({ activePage, activeRoute, onNavigate }) {
  const locale = useLocale();
  const [isMobileOpen, setIsMobileOpen] = React.useState(false);
  const primaryPluginMenu = usePluginMenu('sidebar.primary');
  const primaryItems = [...PRIMARY_ITEMS, ...primaryPluginMenu.entries.filter(entry => entry.pluginId !== 'roam')
    .map(entry => ({ ...entry, pluginEntry: true }))]
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  const adminPluginMenu = usePluginMenu('sidebar.settings.admin');
  const secondaryPluginMenu = usePluginMenu('sidebar.secondary');
  const { placement, transition, isPageOverride } = useCompactPlayerPlacement(activePage, activeRoute);
  const isFullScreen = useUIStore((state) => state.isFullScreen);
  const settingsActiveSection = activeRoute?.type === 'page' && activeRoute.page === 'settings'
    ? activeRoute.section || 'appearance'
    : null;
  const lyricsActiveSection = activeRoute?.page === 'lyrics' ? activeRoute.section || 'current' : 'current';
  const assistantActiveSection = activeRoute?.page === 'assistant' ? activeRoute.section || 'conversation' : 'conversation';
  const isAdmin = useUIStore((state) => state.authSession?.authenticated && state.authSession?.user?.role === 'admin');
  const authenticated = useUIStore((state) => !!state.authSession?.authenticated);
  const installedIds = usePluginStore((state) => state.installedIds);
  const availabilityById = usePluginStore((state) => state.availabilityById);
  const pluginContext = { isAdmin, authenticated, installedIds, availabilityById };
  const plugin = activePage === 'plugin' || (activePage === 'settings' && ['plugins', 'admin-plugins'].includes(settingsActiveSection)
    && (settingsActiveSection !== 'admin-plugins' || isAdmin)) ? localizePlugin(getPlugin(activeRoute?.pluginId), locale) : null;
  const pluginPageId = activeRoute?.pluginPage || activeRoute?.pluginSection || 'overview';
  const currentPluginPage = getPluginPage(plugin, pluginPageId);
  const serviceWorkspace = currentPluginPage?.kind === 'service';
  const primarySettingsPageId = plugin ? getPrimaryPluginSettingsPageId(plugin) : null;
  const pluginNavigationTitle = plugin && serviceWorkspace
    ? plugin.supportedLocales?.length ? plugin.name : t(plugin.name)
    : t('插件设置');
  const pluginPages = plugin ? getPluginPages(plugin, pluginContext) : [];
  const secondaryEntries = plugin ? secondaryPluginMenu.entries.filter(entry => entry.pluginId === plugin.id
    && (entry.group || plugin.id) === (currentPluginPage?.group || plugin.id)) : [];
  if (plugin) secondaryEntries.unshift(...primaryPluginMenu.entries.filter(entry => entry.pluginId === plugin.id)
    .filter(entry => entry.page && (getPluginPage(plugin, entry.page)?.group || plugin.id) === (currentPluginPage?.group || plugin.id)));
  const pluginSections = pluginPages.filter(page => serviceWorkspace
    ? page.kind === 'service' && (page.group || plugin.id) === (currentPluginPage.group || plugin.id)
      && (!plugin.entries.some(entry => entry.page === page.id && ['sidebar.primary', 'sidebar.secondary'].includes(entry.slot))
        || secondaryEntries.some(entry => entry.page === page.id))
    : page.id === 'overview' || page.kind === 'settings')
    .map(page => ({ ...page, targetPage: page.id,
      ...(!serviceWorkspace && page.id === primarySettingsPageId ? { label: '设置', labelKey: undefined } : {}) }));
  for (const entry of secondaryEntries) {
    if (entry.page && (getPluginPage(plugin, entry.page)?.kind === 'service') !== serviceWorkspace) continue;
    const existing = entry.page ? pluginSections.find(page => page.targetPage === entry.page) : null;
    if (existing && serviceWorkspace) Object.assign(existing, entry, { targetPage: entry.page });
    else if (!existing) pluginSections.push({ ...entry, targetPage: entry.page });
  }
  const selectPluginRoute = route => {
    if (route.pluginId === activeRoute?.pluginId && activeRoute?.songId) route = { ...route, songId: activeRoute.songId };
    syncBrowserHistory(formatPath(route));
    setIsMobileOpen(false);
  };
  const selectPluginSection = targetPage => selectPluginRoute({ type: 'page', page: 'plugin', pluginId: plugin.id, pluginPage: targetPage });
  const openPluginEntry = entry => {
    const menus = { 'sidebar.primary': primaryPluginMenu, 'sidebar.settings.admin': adminPluginMenu, 'sidebar.secondary': secondaryPluginMenu };
    menus[entry.slot]?.open(entry);
    setIsMobileOpen(false);
  };
  const setCompactPlayerPlacement = useUIStore((state) => state.setCompactPlayerPlacement);
  const sidebarRef = React.useRef(null);
  const navigationRef = useSidebarNavigationMotion(activePage, activeRoute);
  const closeButtonRef = React.useRef(null);
  const previousFocusRef = React.useRef(null);

  React.useEffect(() => {
    if (!isMobileOpen) return undefined;
    previousFocusRef.current = document.activeElement;
    const mainContent = sidebarRef.current?.closest('.app-workspace')?.querySelector('.app-main');
    mainContent?.setAttribute('inert', '');
    const focusTimer = requestAnimationFrame(() => closeButtonRef.current?.focus());
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setIsMobileOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(sidebarRef.current?.querySelectorAll(
        'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) || []).filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      cancelAnimationFrame(focusTimer);
      document.removeEventListener('keydown', handleKeyDown);
      mainContent?.removeAttribute('inert');
      previousFocusRef.current?.focus?.();
    };
  }, [isMobileOpen]);

  const navigate = (page, section) => {
    onNavigate(page, section);
    setIsMobileOpen(false);
  };

  const selectSettingsSection = (section) => {
    onNavigate('settings', section);
    setIsMobileOpen(false);
  };

  const renderSettingsItem = ({ id, label, icon: Icon }) => (
    <button
      key={id}
      type="button"
      className={`app-nav-item ${settingsActiveSection === id ? 'is-active' : ''}`}
      onClick={() => selectSettingsSection(id)}
      aria-current={settingsActiveSection === id ? 'page' : undefined}
      data-tooltip={t(label)}
    >
      <Icon size={19} strokeWidth={1.8} aria-hidden="true" />
      <span>{t(label)}</span>
    </button>
  );
  const renderPluginEntry = entry => {
    const route = getPluginEntryRoute(entry);
    const Icon = entry.icon || Puzzle;
    return <button key={`${entry.pluginId}:${entry.id}`} type="button" className="app-nav-item"
      onClick={() => route ? selectPluginRoute(route) : openPluginEntry(entry)} data-tooltip={entry.labelKey ? entry.label : t(entry.label)}>
      <Icon size={19} strokeWidth={1.8} aria-hidden="true" /><span>{entry.labelKey ? entry.label : t(entry.label)}</span>
    </button>;
  };
  const renderPluginSection = ({ id, targetPage, label, icon: Icon = Puzzle, ...entry }) => <button key={`${entry.slot || 'page'}:${id}`} type="button"
    className={`app-nav-item ${pluginPageId === targetPage ? 'is-active' : ''}`}
    aria-current={pluginPageId === targetPage ? 'page' : undefined}
    onClick={() => entry.action ? openPluginEntry({ ...entry, id, label, icon: Icon }) : selectPluginSection(targetPage)} data-tooltip={entry.labelKey ? label : t(label)}>
    <Icon size={19} strokeWidth={1.8} aria-hidden="true" /><span>{entry.labelKey ? label : t(label)}</span>
  </button>;

  const returnFromLyrics = () => {
    if (!useUIStore.getState().approveLyricsWorkspaceExit()) return;
    returnFromSidebarWorkspace('/home');
    setIsMobileOpen(false);
  };

  const returnFromSecondarySidebar = () => {
    returnFromSidebarWorkspace('/home');
    setIsMobileOpen(false);
  };

  return (
    <>
      <header className="app-mobile-header">
        <button type="button" className="app-mobile-brand" onClick={() => navigate('home')}>
          <TuneWordmark />
        </button>
        <button
          type="button"
          className="app-mobile-menu-button"
          onClick={() => setIsMobileOpen(true)}
          aria-expanded={isMobileOpen}
          aria-controls="app-primary-sidebar"
          aria-label={t("打开导航")}
        >
          <Menu size={21} aria-hidden="true" />
        </button>
      </header>

      {isMobileOpen && (
        <button
          type="button"
          className="app-sidebar-backdrop"
          onClick={() => setIsMobileOpen(false)}
          aria-label={t("关闭导航")}
        />
      )}

      <aside
        ref={sidebarRef}
        id="app-primary-sidebar"
        className={`app-sidebar ${isMobileOpen ? 'is-mobile-open' : ''}`}
        data-player-placement={placement}
        aria-label={t("Tune 主导航")}
      >
        <div className="app-sidebar__topbar">
          <button type="button" className="app-sidebar__brand" onClick={() => navigate('home')} data-tooltip="Tune">
            <TuneWordmark />
          </button>
          <button
            ref={closeButtonRef}
            type="button"
            className="app-sidebar__close"
            onClick={() => setIsMobileOpen(false)}
            aria-label={t("关闭导航")}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        <nav ref={navigationRef} className="app-sidebar__nav" aria-label={plugin ? pluginNavigationTitle : ['settings', 'plugin'].includes(activePage) ? t("设置分类") : activePage === 'lyrics' ? t("歌词工作台分区") : activePage === 'assistant' ? t("助手分区") : t("主要页面")}>
          {plugin ? <>
            <PageBackButton label={t('返回')} className="app-nav-item app-sidebar__back"
              onClick={() => {
                if (serviceWorkspace) returnFromSidebarWorkspace('/home');
                else returnToParentRoute('/plugins');
                setIsMobileOpen(false);
              }} />
            <div className="app-sidebar__nav-group" aria-label={pluginNavigationTitle}>
              <p className="app-sidebar__group-label">{pluginNavigationTitle}</p>
              {pluginSections.map(renderPluginSection)}
            </div>
          </> : ['settings', 'plugin'].includes(activePage) ? (
            <>
              <PageBackButton label={t("返回")} className="app-nav-item app-sidebar__back" onClick={returnFromSecondarySidebar} />
              <div className="app-sidebar__nav-group" aria-label={t("个人设置")}>
                <p className="app-sidebar__group-label">{t("个人设置")}</p>
                {PERSONAL_SETTINGS.map(renderSettingsItem)}
              </div>
              {isAdmin && (
                <div className="app-sidebar__nav-group" aria-label={t("站点管理")}>
                  <p className="app-sidebar__group-label">{t("站点管理")}</p>
                  {ADMIN_SETTINGS.map(renderSettingsItem)}
                </div>
              )}
              <div className="app-sidebar__nav-group" aria-label={t('插件')}>
                <p className="app-sidebar__group-label">{t('插件')}</p>
                {[{ id: 'list', label: '插件列表', icon: Puzzle }, ...(isAdmin ? [
                  { id: 'delivery', label: '来源与部署', icon: Library },
                ] : [])].map(({ id, label, icon: Icon }) => <button key={id} type="button"
                  className={`app-nav-item ${activePage === 'plugin' && (activeRoute?.section || 'list') === id ? 'is-active' : ''}`}
                  aria-current={activePage === 'plugin' && (activeRoute?.section || 'list') === id ? 'page' : undefined}
                  onClick={() => selectPluginRoute({ type: 'page', page: 'plugin', section: id })} data-tooltip={t(label)}>
                  <Icon size={19} strokeWidth={1.8} aria-hidden="true" /><span>{t(label)}</span>
                </button>)}
              </div>
            </>
          ) : <>
          {primaryItems.map(({ id, label, icon: Icon, pluginEntry, ...entry }) => pluginEntry
            ? renderPluginEntry({ ...entry, id, label, icon: Icon }) : (
            <button
              key={id}
              type="button"
              className={`app-nav-item ${activePage === id || (activePage === 'history' && id === 'home') ? 'is-active' : ''}`}
              onClick={() => navigate(id)}
              aria-current={activePage === id ? 'page' : undefined}
              data-tooltip={t(label)}
            >
              <Icon size={19} strokeWidth={1.8} aria-hidden="true" />
              <span>{t(label)}</span>
            </button>
          ))}
          <button
            type="button"
            className={`app-nav-item ${activePage === 'settings' ? 'is-active' : ''}`}
            onClick={() => navigate('settings')}
            data-tooltip={t("设置")}
            aria-current={activePage === 'settings' ? 'page' : undefined}
          >
            <Settings size={19} strokeWidth={1.8} aria-hidden="true" />
            <span>{t("设置")}</span>
          </button>
          </>}
        </nav>

        {(() => {
          const isTransitioningToSidebar = transition?.to === 'sidebar';
          const isTransitioningFromSidebar = transition?.from === 'sidebar';
          const shouldRenderSidebarPlayer = placement === 'sidebar' || isTransitioningToSidebar || (isTransitioningFromSidebar && transition?.phase === 'exit');
          const isSlotOpen = placement === 'sidebar' && !(isTransitioningFromSidebar && transition?.phase === 'exit');

          return (
            <div className="app-sidebar__secondary" aria-label={t("辅助功能")}>
              {shouldRenderSidebarPlayer && (
                <div className={`sidebar-mini-player__motion-slot ${isSlotOpen ? 'is-open' : ''} ${isFullScreen ? 'sidebar-mini-player__motion-slot--fullscreen' : ''}`}
                  aria-hidden={isFullScreen || !isSlotOpen || undefined} inert={isFullScreen || !isSlotOpen ? '' : undefined}>
                  <SidebarMiniPlayer
                    isTransitioning={Boolean(transition)}
                    motionPhase={transition?.from === 'sidebar' && transition.phase === 'exit'
                      ? 'exit'
                      : transition?.to === 'sidebar' && transition.phase === 'enter' ? 'enter' : null}
                  />
                </div>
              )}
              <div className="app-sidebar__footer">
                <AccountMenu onNavigate={navigate} />
                {!isPageOverride && (
                  <button
                    type="button"
                    className="app-sidebar__placement-btn"
                    onClick={() => {
                      setCompactPlayerPlacement(placement === 'sidebar' ? 'dock' : 'sidebar');
                      setIsMobileOpen(false);
                    }}
                    disabled={Boolean(transition)}
                    data-tooltip={placement === 'sidebar' ? t("切换到底部播放器") : t("切换到侧边播放器")}
                    title={placement === 'sidebar' ? t("切换到底部播放器") : t("切换到侧边播放器")}
                    aria-label={placement === 'sidebar' ? t("切换到底部播放器") : t("切换到侧边播放器")}
                  >
                    {placement === 'sidebar' ? (
                      <PictureInPicture size={18} strokeWidth={1.8} aria-hidden="true" />
                    ) : (
                      <PictureInPicture2 size={18} strokeWidth={1.8} aria-hidden="true" />
                    )}
                  </button>
                )}
              </div>
            </div>
          );
        })()}
      </aside>
      {[primaryPluginMenu, adminPluginMenu, secondaryPluginMenu].map((menu, index) => menu.selection
        ? <PluginActionDialog key={index} selection={menu.selection} onClose={menu.close} /> : null)}
    </>
  );
}
