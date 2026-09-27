import React from 'react';
import {
  Check,
  GripVertical,
  Loader2,
  RefreshCw,
  Save,
  X,
} from 'lucide-react';
import { accountPlaylistsStore, useAccountPlaylists } from '../accountPlaylists.js';
import {
  cloneOrderingItems,
  isOrderingDirty,
  moveOrderingItem,
  moveOrderingItemBy,
  preserveDraftOrder,
  typedPlaylistRefKey,
} from '../accountPlaylistOrdering.js';
import useVerticalReorderDrag from '../hooks/useVerticalReorderDrag.js';
import { showToast, useUIStore } from '../store/useUIStore.js';
import { getPlaylistCoverUrls } from '../utils/playlistCover.js';
import DrawerFrame from './drawers/DrawerFrame.jsx';
import { useDrawerTransition } from './drawers/useDrawerTransition.js';
import LazyImage from './LazyImage.jsx';
import OrderingButtons from './OrderingButtons.jsx';

export default function AccountPlaylistDrawer() {
  const isOpen = useUIStore((state) => state.isAccountPlaylistOpen);
  const setIsOpen = useUIStore((state) => state.setIsAccountPlaylistOpen);
  const registerBeforeClose = useUIStore((state) => state.registerAccountPlaylistBeforeClose);
  const isFullScreen = useUIStore((state) => state.isFullScreen);
  const authenticated = useUIStore((state) => Boolean(state.authSession.authenticated));
  const subject = useAccountPlaylists((state) => state.subject);
  const playlists = useAccountPlaylists((state) => state.playlists);
  const details = useAccountPlaylists((state) => state.details);
  const shelf = useAccountPlaylists((state) => state.shelf);
  const accountStatus = useAccountPlaylists((state) => state.status);
  const accountError = useAccountPlaylists((state) => state.error);
  const { mounted, visible, onPanelTransitionEnd } = useDrawerTransition(isOpen);

  const [workspaceSubject, setWorkspaceSubject] = React.useState(null);
  const [shelfBaseItems, setShelfBaseItems] = React.useState([]);
  const [shelfDraftItems, setShelfDraftItems] = React.useState([]);
  const [shelfRevision, setShelfRevision] = React.useState(null);
  const [shelfError, setShelfError] = React.useState('');
  const [shelfSaving, setShelfSaving] = React.useState(false);
  const [liveStatus, setLiveStatus] = React.useState('');
  const [accountRetrying, setAccountRetrying] = React.useState(false);

  const bodyRef = React.useRef(null);
  const closeButtonRef = React.useRef(null);
  const previousFocusRef = React.useRef(null);
  const wasOpenRef = React.useRef(false);
  const identityRef = React.useRef({ subject: null, epoch: 0 });

  const favorite = playlists.find((playlist) => playlist.kind === 'favorite') || null;
  const memberById = React.useMemo(() => new Map(playlists.map((playlist) => [playlist.id, playlist])), [playlists]);
  const shelfDirty = isOrderingDirty(shelfBaseItems, shelfDraftItems);
  const hasDirtyDraft = shelfDirty;

  const {
    dragState,
    beginPointerDrag,
    movePointerDrag,
    finishPointerDrag,
    clearDrag,
    getRowStyle,
  } = useVerticalReorderDrag({
    items: shelfDraftItems,
    scrollRef: bodyRef,
    cloneItems: cloneOrderingItems,
    getRow: (handle) => handle.closest('[data-order-scope="shelf"]'),
    getRowStride: (row) => {
      if (!row) return 60;
      const nextRow = row.nextElementSibling;
      return nextRow?.hasAttribute('data-order-scope')
        ? Math.max(30, nextRow.getBoundingClientRect().top - row.getBoundingClientRect().top)
        : row.getBoundingClientRect().height + 8;
    },
    onCommit: ({ itemKey, toIndex, snapshot }) => {
      setShelfDraftItems((current) => moveOrderingItem(current, itemKey, toIndex));
      const movedItem = snapshot.find((item) => typedPlaylistRefKey(item) === itemKey);
      const title = memberById.get(movedItem?.id)?.name;
      setLiveStatus(`已将《${title || '歌单'}》移动到第 ${toIndex + 1} 位`);
    },
    onCancel: ({ snapshot }) => {
      setShelfDraftItems(cloneOrderingItems(snapshot));
      setLiveStatus('拖动已取消，顺序已恢复');
    },
  });

  const captureIdentity = () => ({ subject: identityRef.current.subject, epoch: identityRef.current.epoch });
  const isIdentityTokenCurrent = (token) => token && token.subject === identityRef.current.subject && token.epoch === identityRef.current.epoch;
  const identityCurrent = workspaceSubject === subject && subject !== null;

  const resetWorkspace = React.useCallback((nextSubject, nextRevision) => {
    setWorkspaceSubject(nextSubject);
    setShelfBaseItems([]);
    setShelfDraftItems([]);
    setShelfRevision(nextRevision);
    setShelfError('');
    setShelfSaving(false);
    clearDrag();
  }, [clearDrag]);

  React.useEffect(() => {
    const nextSubject = authenticated && subject ? subject : null;
    if (nextSubject === identityRef.current.subject) return;
    identityRef.current = { subject: nextSubject, epoch: identityRef.current.epoch + 1 };
    resetWorkspace(nextSubject, null);
  }, [authenticated, resetWorkspace, subject]);

  React.useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      previousFocusRef.current = document.activeElement;
      requestAnimationFrame(() => closeButtonRef.current?.focus());
    }
    if (!isOpen && wasOpenRef.current) {
      const target = previousFocusRef.current;
      requestAnimationFrame(() => {
        if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
      });
      clearDrag();
      if (shelfBaseItems.length) setShelfDraftItems(cloneOrderingItems(shelfBaseItems));
    }
    wasOpenRef.current = isOpen;
    if (!isOpen) return;
    if (!workspaceSubject && subject) {
      resetWorkspace(subject, null);
      return;
    }
    if (workspaceSubject && workspaceSubject !== subject) {
      setLiveStatus('账号状态已变化，正在关闭管理抽屉');
      showToast('账号状态已变化，已退出唱片架管理');
      resetWorkspace(null, null);
      if (isOpen) setIsOpen(false, { force: true });
      return;
    }
    if (workspaceSubject === subject && Number.isInteger(shelf?.revision) && (shelfRevision === null || shelf.revision !== shelfRevision)) {
      const serverItems = cloneOrderingItems(shelf.items || []);
      setShelfBaseItems(serverItems);
      setShelfRevision(shelf.revision);
      setShelfDraftItems((current) => (current.length === 0 ? cloneOrderingItems(serverItems) : preserveDraftOrder(current, serverItems)));
    }
  }, [clearDrag, isOpen, resetWorkspace, setIsOpen, shelf, subject, workspaceSubject, shelfRevision]);

  React.useEffect(() => {
    if (!mounted && !isOpen) {
      resetWorkspace(null, null);
    }
  }, [mounted, isOpen, resetWorkspace]);

  React.useEffect(() => {
    if (!isOpen) return () => {};
    const beforeClose = () => {
      if (!hasDirtyDraft) return true;
      return window.confirm('有尚未保存的调整，确认放弃并关闭吗？');
    };
    return registerBeforeClose(beforeClose);
  }, [hasDirtyDraft, isOpen, registerBeforeClose]);

  const retryAccountData = async () => {
    setAccountRetrying(true);
    setShelfError('');
    try {
      await accountPlaylistsStore.getState().refresh();
    } catch (error) {
      setShelfError(error?.message || '重试失败，请稍后再试。');
    } finally {
      setAccountRetrying(false);
    }
  };

  const handleShelfMove = (itemKey, delta) => {
    setShelfDraftItems((current) => {
      const next = moveOrderingItemBy(current, itemKey, delta);
      const movedItem = next.find((item) => typedPlaylistRefKey(item) === itemKey);
      const title = memberById.get(movedItem?.id)?.name;
      setLiveStatus(`已调整《${title || '歌单'}》的顺序`);
      return next;
    });
  };

  const handleSaveShelf = async () => {
    const identityToken = captureIdentity();
    if (!shelfDirty || shelfSaving || !identityCurrent || !Number.isInteger(shelfRevision)) return;
    setShelfSaving(true);
    setShelfError('');
    try {
      const result = await accountPlaylistsStore.getState().updateShelfOrder(shelfDraftItems, shelfRevision);
      if (!isIdentityTokenCurrent(identityToken)) return;
      const nextServerItems = cloneOrderingItems(result.shelf.items || []);
      setShelfRevision(result.shelf.revision);
      setShelfBaseItems(nextServerItems);
      setShelfDraftItems(cloneOrderingItems(nextServerItems));
      showToast('唱片架调整已保存');
    } catch (error) {
      if (!isIdentityTokenCurrent(identityToken)) return;
      if (error?.status === 409) {
        if (window.confirm('唱片架已在其他位置更新。放弃当前排序并加载最新顺序吗？')) {
          await accountPlaylistsStore.getState().refresh().catch(() => {});
        }
      } else if (error?.status >= 500) {
        setShelfError('服务器暂时不可用，草稿已保留，可以重试。');
        showToast('调整保存失败，草稿已保留');
      } else {
        setShelfError(error?.message || '保存唱片架调整失败。');
        showToast(error?.message || '保存唱片架调整失败');
      }
    } finally {
      if (isIdentityTokenCurrent(identityToken)) setShelfSaving(false);
    }
  };

  const handleClose = () => {
    if (setIsOpen(false) === false) return;
  };

  const resolveItemTitle = (item) => {
    return memberById.get(item.id)?.name || '个人歌单';
  };

  const resolveItemCover = (item) => {
    const memberPlaylist = memberById.get(item.id);
    const memberDetail = memberPlaylist ? details[memberPlaylist.id] : null;
    return getPlaylistCoverUrls({ ...memberPlaylist, songs: memberDetail?.songs || [] })[0];
  };

  React.useEffect(() => {
    if (!isOpen || !favorite?.id || details[favorite.id]) return;
    accountPlaylistsStore.getState().loadDetail(favorite.id).catch(() => {});
  }, [isOpen, favorite?.id, details]);

  if (!mounted) return null;

  return (
    <DrawerFrame
      visible={visible}
      isFullScreen={isFullScreen}
      onClose={handleClose}
      onPanelTransitionEnd={onPanelTransitionEnd}
      panelClassName="account-playlist-drawer sm:w-[440px] max-w-full"
      labelledBy="account-playlist-drawer-title"
    >
      <div className="account-playlist-header sticky top-0 z-10 flex items-center justify-between px-5 py-4 border-b border-[var(--line)] bg-[var(--drawer-solid-bg)]">
        <div>
          <p className="collection-section__index text-xs">RECORD SHELF</p>
          <h2 id="account-playlist-drawer-title" className="text-base font-semibold text-[var(--ink)]">歌单排序</h2>
        </div>
        <button
          ref={closeButtonRef}
          type="button"
          onClick={handleClose}
          aria-label="关闭唱片架管理"
          className="theme-drawer__close flex items-center justify-center p-2 text-[var(--muted)] hover:text-[var(--ink)]"
        >
          <X size={18} />
        </button>
      </div>

      <div
        ref={bodyRef}
        className="account-playlist-body custom-scrollbar flex-1 overflow-y-auto px-5 py-4 space-y-4"
      >
        <span className="sr-only" aria-live="polite">{liveStatus}</span>

        {accountStatus === 'error' && !shelf ? (
          <div className="state-panel state-panel--error p-4 text-center rounded-xl">
            <p className="text-sm font-semibold text-red-500 mb-1">账号唱片架加载失败</p>
            <p className="text-xs text-[var(--muted)] mb-3">{accountError?.message || '请稍后重试。'}</p>
            <button
              type="button"
              disabled={accountRetrying}
              onClick={retryAccountData}
              className="secondary-button px-3 py-1.5 text-xs font-medium inline-flex items-center gap-1.5"
            >
              {accountRetrying ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
              <span>重试加载</span>
            </button>
          </div>
        ) : null}

        {accountStatus === 'ready' && shelfRevision !== null ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-[var(--muted)] px-1">
              <span>拖拽手柄或使用上下按钮调整在主页及二级页面的展示顺序</span>
            </div>

            {shelfDraftItems.map((item, index) => {
              const itemKey = typedPlaylistRefKey(item);
              const title = resolveItemTitle(item);
              const coverUrl = resolveItemCover(item);
              const isDraggingCard = dragState?.itemKey === itemKey;

              return (
                <div
                  key={itemKey}
                  data-order-scope="shelf"
                  data-order-key={itemKey}
                  style={getRowStyle(index)}
                  onPointerDown={(event) => {
                    if (event.target.closest('button, a, input, textarea')) return;
                    if (event.pointerType === 'mouse') {
                      beginPointerDrag(itemKey, index, event);
                    }
                  }}
                  className={`account-order-item p-2.5 rounded-xl border border-[var(--line)] bg-[var(--surface)] ${isDraggingCard ? 'is-dragging' : ''} flex items-center gap-2.5 transition-all select-none`}
                >
                  <button
                    type="button"
                    className="account-order-handle p-1.5 cursor-grab active:cursor-grabbing text-[var(--muted)] hover:text-[var(--ink)] flex-shrink-0 touch-none select-none rounded-lg hover:bg-[var(--surface-raised)] transition-colors"
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      beginPointerDrag(itemKey, index, event);
                    }}
                    onPointerMove={movePointerDrag}
                    onPointerUp={(event) => finishPointerDrag(event)}
                    onPointerCancel={(event) => finishPointerDrag(event, true)}
                    aria-label={`拖拽调整《${title}》排序`}
                  >
                    <GripVertical size={16} />
                  </button>

                  <div className="w-9 h-9 rounded-lg overflow-hidden flex-shrink-0 bg-[var(--surface-raised)]">
                    <LazyImage src={coverUrl} fallback="/placeholder-album.svg" className="w-full h-full object-cover" alt={title} />
                  </div>

                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-[var(--ink)] truncate">{title}</p>
                    <p className="text-[11px] text-[var(--muted)]">
                      个人歌单
                    </p>
                  </div>

                  <OrderingButtons
                    itemKey={itemKey}
                    index={index}
                    total={shelfDraftItems.length}
                    onMove={handleShelfMove}
                  />
                </div>
              );
            })}
          </div>
        ) : null}

        {shelfError && <p className="text-xs text-red-500 px-1">{shelfError}</p>}
      </div>

      <div className="account-playlist-footer sticky bottom-0 z-10 px-5 py-3.5 border-t border-[var(--line)] bg-[var(--drawer-solid-bg)] flex items-center justify-between gap-3">
        <button
          type="button"
          disabled={!shelfDirty || shelfSaving}
          onClick={() => setShelfDraftItems(cloneOrderingItems(shelfBaseItems))}
          className="secondary-button px-4 py-2 text-xs font-medium rounded-xl disabled:opacity-30 disabled:cursor-not-allowed hover:text-[var(--danger)] transition-colors"
        >
          重置
        </button>

        <button
          type="button"
          disabled={!shelfDirty || shelfSaving}
          onClick={handleSaveShelf}
          className={`inline-flex items-center justify-center gap-2 px-5 py-2 text-xs font-semibold rounded-xl transition-all ${
            shelfDirty
              ? 'primary-button !text-white shadow-md hover:brightness-105 active:scale-98 cursor-pointer'
              : 'border border-[var(--line)] bg-[var(--surface-raised)] text-[var(--muted)] cursor-not-allowed'
          }`}
        >
          {shelfSaving ? (
            <>
              <Loader2 size={14} className="animate-spin text-white" />
              <span className="text-white">正在保存...</span>
            </>
          ) : shelfDirty ? (
            <>
              <Save size={14} className="text-white" />
              <span className="text-white">保存唱片架调整</span>
            </>
          ) : (
            <>
              <Check size={14} className="text-[var(--muted)]" />
              <span>已是最新设置</span>
            </>
          )}
        </button>
      </div>
    </DrawerFrame>
  );
}
