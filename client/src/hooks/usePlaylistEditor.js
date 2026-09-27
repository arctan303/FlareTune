import React from 'react';
import { accountPlaylistsStore } from '../accountPlaylists.js';
import { getEdgeAutoScrollDelta } from '../accountPlaylistOrdering.js';
import {
    preparePointerDragSettle,
    usePointerDragWindowEvents,
} from './usePointerDragLifecycle.js';
import { showToast } from '../store/useUIStore.js';

const DRAG_SETTLE_MS = 190;

export default function usePlaylistEditor({ playlist, playlistInfo, playlistSongs, onClose }) {
    const [isEditing, setIsEditing] = React.useState(false);
    const [draftName, setDraftName] = React.useState('');
    const [draftDescription, setDraftDescription] = React.useState('');
    const [draftSongs, setDraftSongs] = React.useState([]);
    const [isSaving, setIsSaving] = React.useState(false);
    const [errorMsg, setErrorMsg] = React.useState('');
    const [dragState, setDragState] = React.useState(null);
    const dragRef = React.useRef(null);
    const settleTimerRef = React.useRef(null);

    const clearDragResources = React.useCallback(() => {
        const drag = dragRef.current;
        if (drag?.autoScrollFrame !== null && drag?.autoScrollFrame !== undefined) {
            cancelAnimationFrame(drag.autoScrollFrame);
        }
        if (settleTimerRef.current !== null) {
            clearTimeout(settleTimerRef.current);
            settleTimerRef.current = null;
        }
        dragRef.current = null;
        setDragState(null);
    }, []);

    const resetEditor = React.useCallback(() => {
        setIsEditing(false);
        setDraftName('');
        setDraftDescription('');
        setDraftSongs([]);
        setErrorMsg('');
        clearDragResources();
    }, [clearDragResources]);

    React.useEffect(() => {
        resetEditor();
    }, [playlist?.id, resetEditor]);

    React.useEffect(() => () => {
        const drag = dragRef.current;
        if (drag?.autoScrollFrame !== null && drag?.autoScrollFrame !== undefined) {
            cancelAnimationFrame(drag.autoScrollFrame);
        }
        if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
    }, []);

    const handleStartEdit = React.useCallback(() => {
        setIsEditing(true);
        setDraftName(playlist?.name || '');
        setDraftDescription(playlistInfo?.description || playlist?.description || '');
        setDraftSongs([...playlistSongs]);
        setErrorMsg('');
    }, [playlist, playlistInfo, playlistSongs]);

    const handleCancelEdit = React.useCallback(() => {
        resetEditor();
    }, [resetEditor]);

    React.useEffect(() => {
        if (!isEditing) return undefined;
        const handleKeyDown = (event) => {
            if (event.key === 'Escape') handleCancelEdit();
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [handleCancelEdit, isEditing]);

    const moveSong = React.useCallback((fromIndex, toIndex) => {
        setDraftSongs((current) => {
            if (toIndex < 0 || toIndex >= current.length) return current;
            const copy = [...current];
            const [item] = copy.splice(fromIndex, 1);
            copy.splice(toIndex, 0, item);
            return copy;
        });
    }, []);

    const removeSongFromDraft = React.useCallback((songId) => {
        setDraftSongs((current) => current.filter((song) => String(song.id) !== String(songId)));
    }, []);

    const beginPointerDrag = React.useCallback((songId, index, event) => {
        if (event.button !== undefined && event.button !== 0) return;
        if (dragRef.current?.settling) return;
        event.preventDefault();

        const handleElement = event.currentTarget;
        try {
            handleElement.setPointerCapture?.(event.pointerId);
        } catch {}

        const row = handleElement.closest('[data-song-drag-row="true"]');
        const container = row?.parentElement;
        let gridColumns = 1;
        let colStride = 0;
        let rowStride = 68;

        if (container && row) {
            const rowRect = row.getBoundingClientRect();
            const children = [...container.querySelectorAll('[data-song-drag-row="true"]')];
            const sameRowSiblings = children.filter((child, childIndex) => (
                childIndex !== index
                && Math.abs(child.getBoundingClientRect().top - rowRect.top) < 15
            ));
            if (sameRowSiblings.length > 0) {
                gridColumns = sameRowSiblings.length + 1;
                const sortedByLeft = [row, ...sameRowSiblings].sort(
                    (a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left
                );
                if (sortedByLeft.length >= 2) {
                    colStride = sortedByLeft[1].getBoundingClientRect().left - sortedByLeft[0].getBoundingClientRect().left;
                }
            }
            const nextGridRow = children.find((child) => child.getBoundingClientRect().top > rowRect.top + 20);
            rowStride = nextGridRow
                ? nextGridRow.getBoundingClientRect().top - rowRect.top
                : rowRect.height + 12;
        }

        const scrollBox = document.querySelector('.collection-scroll');
        const dragInfo = {
            songId: String(songId),
            startIndex: index,
            targetIndex: index,
            startX: event.clientX,
            startY: event.clientY,
            currentX: event.clientX,
            currentY: event.clientY,
            initialScrollTop: scrollBox ? scrollBox.scrollTop : 0,
            offsetX: 0,
            offsetY: 0,
            gridColumns,
            colStride,
            rowStride,
            pointerId: event.pointerId,
            handleElement,
            snapshot: [...draftSongs],
            autoScrollDelta: 0,
            autoScrollFrame: null,
            settling: false,
        };

        dragRef.current = dragInfo;
        setDragState(dragInfo);
    }, [draftSongs]);

    const updateDragTarget = React.useCallback((drag, currentScrollTop) => {
        const rawOffsetY = (drag.currentY - drag.startY) + (currentScrollTop - drag.initialScrollTop);
        const startRow = Math.floor(drag.startIndex / drag.gridColumns);
        const totalRows = Math.ceil(draftSongs.length / drag.gridColumns);
        const minRowOffsetY = -startRow * drag.rowStride;
        const maxRowOffsetY = (totalRows - 1 - startRow) * drag.rowStride;
        drag.offsetY = Math.max(minRowOffsetY - 28, Math.min(maxRowOffsetY + 28, rawOffsetY));

        const startCol = drag.startIndex % drag.gridColumns;
        const deltaRow = Math.round(rawOffsetY / drag.rowStride);
        const deltaCol = drag.gridColumns > 1 && drag.colStride > 0
            ? Math.round(drag.offsetX / drag.colStride)
            : 0;
        const targetRow = Math.max(0, Math.min(totalRows - 1, startRow + deltaRow));
        const targetCol = Math.max(0, Math.min(drag.gridColumns - 1, startCol + deltaCol));
        drag.targetIndex = Math.max(0, Math.min(
            draftSongs.length - 1,
            targetRow * drag.gridColumns + targetCol,
        ));
    }, [draftSongs.length]);

    const runDragAutoScroll = React.useCallback(() => {
        const drag = dragRef.current;
        const scrollBox = document.querySelector('.collection-scroll');
        if (!drag || !scrollBox || !drag.autoScrollDelta || drag.settling) {
            if (drag) drag.autoScrollFrame = null;
            return;
        }

        const previousScrollTop = scrollBox.scrollTop;
        scrollBox.scrollBy({ top: drag.autoScrollDelta, behavior: 'auto' });
        const currentScrollTop = scrollBox.scrollTop;
        updateDragTarget(drag, currentScrollTop);
        setDragState({ ...drag });

        const reachedBoundary = previousScrollTop === currentScrollTop && (
            (drag.autoScrollDelta < 0 && currentScrollTop === 0)
            || (drag.autoScrollDelta > 0 && currentScrollTop + scrollBox.clientHeight >= scrollBox.scrollHeight - 1)
        );
        if (reachedBoundary) {
            drag.autoScrollFrame = null;
            return;
        }
        drag.autoScrollFrame = requestAnimationFrame(runDragAutoScroll);
    }, [updateDragTarget]);

    const movePointerDrag = React.useCallback((event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId || drag.settling) return;

        const scrollBox = document.querySelector('.collection-scroll');
        const currentScrollTop = scrollBox ? scrollBox.scrollTop : drag.initialScrollTop;
        drag.currentX = event.clientX;
        drag.currentY = event.clientY;
        drag.offsetX = event.clientX - drag.startX;
        updateDragTarget(drag, currentScrollTop);

        if (scrollBox) {
            const rect = scrollBox.getBoundingClientRect();
            const delta = getEdgeAutoScrollDelta(event.clientY, rect.top, rect.bottom);
            drag.autoScrollDelta = delta;
            if (delta && drag.autoScrollFrame === null) {
                drag.autoScrollFrame = requestAnimationFrame(runDragAutoScroll);
            } else if (!delta && drag.autoScrollFrame !== null) {
                cancelAnimationFrame(drag.autoScrollFrame);
                drag.autoScrollFrame = null;
            }
        }

        setDragState({ ...drag });
    }, [runDragAutoScroll, updateDragTarget]);

    const finishPointerDrag = React.useCallback((event = null, cancelled = false) => {
        const drag = dragRef.current;
        if (!preparePointerDragSettle(drag, event)) return;

        const from = drag.startIndex;
        const to = drag.targetIndex;
        if (cancelled || from === to) {
            drag.settling = true;
            drag.offsetX = 0;
            drag.offsetY = 0;
            setDragState({ ...drag });
            settleTimerRef.current = setTimeout(() => {
                if (cancelled) setDraftSongs(drag.snapshot);
                dragRef.current = null;
                settleTimerRef.current = null;
                setDragState(null);
            }, DRAG_SETTLE_MS);
            return;
        }

        const fromCol = from % drag.gridColumns;
        const fromRow = Math.floor(from / drag.gridColumns);
        const toCol = to % drag.gridColumns;
        const toRow = Math.floor(to / drag.gridColumns);
        drag.settling = true;
        drag.offsetX = (toCol - fromCol) * drag.colStride;
        drag.offsetY = (toRow - fromRow) * drag.rowStride;
        setDragState({ ...drag });

        settleTimerRef.current = setTimeout(() => {
            setDraftSongs((current) => {
                const copy = [...current];
                const [item] = copy.splice(from, 1);
                copy.splice(to, 0, item);
                return copy;
            });
            dragRef.current = null;
            settleTimerRef.current = null;
            setDragState(null);
        }, DRAG_SETTLE_MS);
    }, []);

    usePointerDragWindowEvents({
        active: Boolean(dragState && !dragState.settling),
        onMove: movePointerDrag,
        onFinish: finishPointerDrag,
    });

    const handleSaveAll = React.useCallback(async () => {
        const isCollection = playlist.kind === 'favorite';
        const trimmedName = draftName.trim();
        if (!isCollection && (!trimmedName || Array.from(trimmedName).length > 40)) {
            setErrorMsg('歌单名称需为 1 到 40 个字符。');
            return;
        }
        if (!isCollection && Array.from(draftDescription.trim()).length > 300) {
            setErrorMsg('歌单简介不能超过 300 个字符。');
            return;
        }

        setIsSaving(true);
        setErrorMsg('');
        try {
            let currentRevision = playlist.revision;
            const originalName = (playlist.name || '').trim();
            const originalDescription = (playlistInfo?.description || playlist?.description || '').trim();
            const metadataChanged = !isCollection && (trimmedName !== originalName || draftDescription.trim() !== originalDescription);
            const originalSongIds = playlistSongs.map((song) => String(song.id));
            const draftSongIds = draftSongs.map((song) => String(song.id));
            const songsChanged = originalSongIds.length !== draftSongIds.length
                || originalSongIds.some((id, index) => id !== draftSongIds[index]);

            if (!metadataChanged && !songsChanged) {
                setIsEditing(false);
                return;
            }
            if (metadataChanged) {
                const result = await accountPlaylistsStore.getState().updatePlaylist(playlist.id, {
                    name: trimmedName,
                    description: draftDescription.trim(),
                    expectedRevision: currentRevision,
                });
                if (result?.playlist?.revision !== undefined) currentRevision = result.playlist.revision;
            }
            if (songsChanged) {
                await accountPlaylistsStore.getState().reorderSongs(playlist.id, draftSongIds, currentRevision);
            }
            showToast('歌单修改已保存');
            setIsEditing(false);
        } catch (error) {
            setErrorMsg(error?.status === 409 ? '歌单已在其他页面更新，请重试' : (error?.message || '保存失败'));
        } finally {
            setIsSaving(false);
        }
    }, [draftDescription, draftName, draftSongs, playlist, playlistInfo, playlistSongs]);

    const handleDeletePlaylist = React.useCallback(async () => {
        if (!window.confirm(`确认删除歌单《${playlist?.name}》？删除后不可恢复。`)) return;
        setIsSaving(true);
        try {
            await accountPlaylistsStore.getState().deletePlaylist(playlist.id, playlist.revision);
            showToast(`已删除歌单《${playlist.name}》`);
            onClose();
        } catch (error) {
            showToast(error?.status === 409 ? '歌单已在其他页面更新，请重试' : (error?.message || '删除失败'));
            setIsSaving(false);
        }
    }, [onClose, playlist]);

    return {
        isEditing,
        draftName,
        setDraftName,
        draftDescription,
        setDraftDescription,
        draftSongs,
        isSaving,
        errorMsg,
        dragState,
        handleStartEdit,
        handleCancelEdit,
        handleSaveAll,
        handleDeletePlaylist,
        moveSong,
        removeSongFromDraft,
        beginPointerDrag,
        movePointerDrag,
        finishPointerDrag,
    };
}
