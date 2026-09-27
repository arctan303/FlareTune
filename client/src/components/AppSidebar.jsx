import React from 'react';
import {
  Activity,
  Bot,
  Disc,
  Home,
  Library,
  Languages,
  LogOut,
  Menu,
  MessageCircle,
  Brain,
  Plus,
  Palette,
  Search,
  Settings,
  FileText,
  Shuffle,
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
import { useUIStore, showToast } from '../store/useUIStore.js';
import { logout } from '../instance/api.js';
import { AUTH_SESSION_INVALIDATED_EVENT } from '../authNavigation.js';
import { returnToOriginRoute } from '../utils/navigation.js';

const PRIMARY_ITEMS = [
  { id: 'home', label: '主页', icon: Home },
  { id: 'search', label: '搜索', icon: Search },
  { id: 'roam', label: '漫游', icon: Shuffle },
  { id: 'library', label: '资料库', icon: Library },
];

const PERSONAL_SETTINGS = [
  { id: 'appearance', label: '外观与播放', icon: Palette },
  { id: 'personal', label: '个人设置', icon: UserRound },
];

const ADMIN_SETTINGS = [
  { id: 'admin-catalog', label: '曲库管理', icon: Disc },
  { id: 'admin-add-song', label: '歌曲入库', icon: Plus },
  { id: 'admin-assistant', label: 'AI 与助手', icon: Bot },
  { id: 'admin-accounts', label: '账号管理', icon: Users },
  { id: 'admin-system', label: '系统管理', icon: Activity },
];
const LYRICS_SECTIONS = [
  { id: 'current', label: '当前歌词', icon: Languages },
  { id: 'tools', label: '文件与管理', icon: FileText },
  { id: 'candidates', label: '候选歌词', icon: Search },
];

export default function AppSidebar({ activePage, activeRoute, onNavigate }) {
  const [isMobileOpen, setIsMobileOpen] = React.useState(false);
  const { placement, transition, isPageOverride } = useCompactPlayerPlacement(activePage);
  const isFullScreen = useUIStore((state) => state.isFullScreen);
  const settingsActiveSection = activeRoute?.type === 'page' && activeRoute.page === 'settings'
    ? activeRoute.section || 'appearance'
    : 'appearance';
  const lyricsActiveSection = activeRoute?.page === 'lyrics' ? activeRoute.section || 'current' : 'current';
  const assistantActiveSection = activeRoute?.page === 'assistant' ? activeRoute.section || 'conversation' : 'conversation';
  const isAdmin = useUIStore((state) => state.authSession?.authenticated && state.authSession?.user?.role === 'admin');
  const authSession = useUIStore((state) => state.authSession);
  const [isLoggingOut, setIsLoggingOut] = React.useState(false);
  const sidebarRef = React.useRef(null);
  const closeButtonRef = React.useRef(null);
  const previousFocusRef = React.useRef(null);
  const previousPageRef = React.useRef('home');

  const handleLogout = async () => {
    if (isLoggingOut) return;
    setIsLoggingOut(true);
    try {
      await logout(authSession?.csrfToken);
      window.dispatchEvent(new Event(AUTH_SESSION_INVALIDATED_EVENT));
      showToast('已退出登录');
    } catch (err) {
      if (err?.status === 401) {
        window.dispatchEvent(new Event(AUTH_SESSION_INVALIDATED_EVENT));
      } else {
        showToast('退出失败，请稍后重试');
        setIsLoggingOut(false);
      }
    }
  };

  React.useEffect(() => {
    if (activePage !== 'settings' && activePage !== 'lyrics' && activePage !== 'assistant') previousPageRef.current = activePage;
  }, [activePage]);

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
      data-tooltip={label}
    >
      <Icon size={19} strokeWidth={1.8} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );

  const returnFromLyrics = () => {
    if (!useUIStore.getState().approveLyricsWorkspaceExit()) return;
    if (returnToOriginRoute('/home') === 'replace') onNavigate('home');
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
          aria-label="打开导航"
        >
          <Menu size={21} aria-hidden="true" />
        </button>
      </header>

      {isMobileOpen && (
        <button
          type="button"
          className="app-sidebar-backdrop"
          onClick={() => setIsMobileOpen(false)}
          aria-label="关闭导航"
        />
      )}

      <aside
        ref={sidebarRef}
        id="app-primary-sidebar"
        className={`app-sidebar ${isMobileOpen ? 'is-mobile-open' : ''}`}
        data-player-placement={placement}
        aria-label="Tune 主导航"
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
            aria-label="关闭导航"
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        <nav className="app-sidebar__nav" aria-label={activePage === 'settings' ? '设置分类' : activePage === 'lyrics' ? '歌词工作台分区' : activePage === 'assistant' ? '助手分区' : '主要页面'}>
          {activePage === 'lyrics' ? <>
            <PageBackButton onClick={returnFromLyrics} label="返回音乐" className="app-nav-item app-sidebar__back" />
            <div className="app-sidebar__nav-group" aria-label="歌词工作台">
              <p className="app-sidebar__group-label">歌词工作台</p>
              {LYRICS_SECTIONS.map(({ id, label, icon: Icon }) => <button key={id} type="button"
                className={`app-nav-item ${lyricsActiveSection === id ? 'is-active' : ''}`}
                aria-current={lyricsActiveSection === id ? 'page' : undefined}
                onClick={() => navigate('lyrics', id)} data-tooltip={label}>
                <Icon size={19} strokeWidth={1.8} aria-hidden="true" /><span>{label}</span>
              </button>)}
            </div>
          </> : activePage === 'assistant' ? <>
            <PageBackButton label="返回音乐" className="app-nav-item app-sidebar__back" onClick={() => {
              if (returnToOriginRoute(`/${previousPageRef.current}`) === 'replace') onNavigate(previousPageRef.current);
              setIsMobileOpen(false);
            }} />
            <div className="app-sidebar__nav-group" aria-label="助手">
              <p className="app-sidebar__group-label">助手</p>
              <button type="button" className={`app-nav-item ${assistantActiveSection === 'conversation' ? 'is-active' : ''}`}
                aria-current={assistantActiveSection === 'conversation' ? 'page' : undefined}
                onClick={() => navigate('assistant', 'conversation')} data-tooltip="对话">
                <MessageCircle size={19} strokeWidth={1.8} aria-hidden="true" /><span>对话</span>
              </button>
              <button type="button" className={`app-nav-item ${assistantActiveSection === 'memory' ? 'is-active' : ''}`}
                aria-current={assistantActiveSection === 'memory' ? 'page' : undefined}
                onClick={() => navigate('assistant', 'memory')} data-tooltip="记忆">
                <Brain size={19} strokeWidth={1.8} aria-hidden="true" /><span>记忆</span>
              </button>
              <button type="button" className="app-nav-item app-sidebar__assistant-clear"
                onClick={() => {
                  setIsMobileOpen(false);
                  useUIStore.getState().requestAssistantClear();
                }} data-tooltip="清空对话">
                <Trash2 size={19} strokeWidth={1.8} aria-hidden="true" /><span>清空对话</span>
              </button>
            </div>
          </> : activePage === 'settings' ? (
            <>
              <PageBackButton label="返回音乐" className="app-nav-item app-sidebar__back" onClick={() => {
                if (returnToOriginRoute(`/${previousPageRef.current}`) === 'replace') onNavigate(previousPageRef.current);
                setIsMobileOpen(false);
              }} />
              <div className="app-sidebar__nav-group" aria-label="个人设置">
                <p className="app-sidebar__group-label">个人设置</p>
                {PERSONAL_SETTINGS.map(renderSettingsItem)}
              </div>
              {isAdmin && (
                <div className="app-sidebar__nav-group" aria-label="系统管理">
                  <p className="app-sidebar__group-label">系统管理</p>
                  {ADMIN_SETTINGS.map(renderSettingsItem)}
                </div>
              )}
            </>
          ) : <>
          {PRIMARY_ITEMS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={`app-nav-item ${activePage === id || (activePage === 'history' && id === 'home') ? 'is-active' : ''}`}
              onClick={() => navigate(id)}
              aria-current={activePage === id ? 'page' : undefined}
              data-tooltip={label}
            >
              <Icon size={19} strokeWidth={1.8} aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
          <button
            type="button"
            className={`app-nav-item ${activePage === 'assistant' ? 'is-active' : ''}`}
            onClick={() => navigate('assistant')}
            data-ai-entry="sidebar"
            data-tooltip="助手"
            aria-current={activePage === 'assistant' ? 'page' : undefined}
          >
            <MessageCircle size={19} strokeWidth={1.8} aria-hidden="true" />
            <span>助手</span>
          </button>
          <button
            type="button"
            className={`app-nav-item ${activePage === 'settings' ? 'is-active' : ''}`}
            onClick={() => navigate('settings')}
            data-tooltip="设置"
            aria-current={activePage === 'settings' ? 'page' : undefined}
          >
            <Settings size={19} strokeWidth={1.8} aria-hidden="true" />
            <span>设置</span>
          </button>
          </>}
        </nav>

        <div className="app-sidebar__secondary" aria-label="辅助功能">
          {placement === 'sidebar' && (
            <div className={`sidebar-mini-player__motion-slot ${isFullScreen ? 'sidebar-mini-player__motion-slot--fullscreen' : ''}`}
              aria-hidden={isFullScreen || undefined} inert={isFullScreen ? '' : undefined}>
              <SidebarMiniPlayer
                allowLayoutSwitch={!isPageOverride}
                onLayoutSwitch={() => setIsMobileOpen(false)}
                isTransitioning={Boolean(transition)}
                motionPhase={transition?.from === 'sidebar' && transition.phase === 'exit'
                  ? 'exit'
                  : transition?.to === 'sidebar' && transition.phase === 'enter' ? 'enter' : null}
              />
            </div>
          )}
          <div className="app-sidebar__footer">
            <AccountMenu onNavigate={navigate} />
            <button
              type="button"
              className="app-sidebar__logout-btn"
              onClick={handleLogout}
              disabled={isLoggingOut}
              data-tooltip="退出登录"
              title="退出登录"
              aria-label="退出登录"
            >
              <LogOut size={18} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
