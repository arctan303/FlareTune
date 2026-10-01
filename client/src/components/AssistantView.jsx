import { t } from '../i18n/index.js';
import React from 'react';
import { ArrowDown } from 'lucide-react';
import { useUIStore, showToast } from '../store/useUIStore';
import { usePlayerStore } from '../store/usePlayerStore.js';
import { useShallow } from 'zustand/react/shallow';
import { createAiResponseTypewriter, reconcileAiResponseContent } from '../aiResponseTypewriter';
import { getApiBaseUrl } from '../services/apiBase.js';
import { authenticatedFetch } from '../services/authenticatedFetch.js';
import { fetchCloudThread, mergeAssistantProcessMessages } from '../services/aiThreadSync.js';
import { consumeSseJsonStream } from '../services/aiEventStream.js';
import { localAssistantMutationHeaders, optimisticAssistantUserMessage } from '../services/localAssistantRequest.js';
import { assistantFailureMessage, withAssistantFailure } from '../services/assistantFailure.js';
import { captureAssistantLiveContext } from '../services/localAssistantLiveContext.js';
import { dispatchLocalAssistantPlayerAction } from '../services/localAssistantPlayer.js';
import { confirmAssistantPlaylistDeletion, rebindAssistantPlaylistConfirmations } from '../services/assistantPlaylistDeletion.js';
import { accountPlaylistsStore } from '../accountPlaylists.js';
import AiReviewConversation from './AiReviewConversation.jsx';
import AssistantMemoryView from './AssistantMemoryView.jsx';
import AssistantAttachments from './AssistantAttachments.jsx';
import ImagePreviewDialog from './ImagePreviewDialog.jsx';
import { resolveAssistantImagePreview } from '../services/assistantImagePreview.js';
import { AiReviewComposer } from './AiReviewChrome.jsx';
import { useCompactPlayerPlacement } from '../hooks/useCompactPlayerPlacement.js';
import { appendThoughtProcessEntry, appendToolProcessEntry, finishToolProcessEntry } from '../../../shared/assistantProcessTrace.js';

const FALLBACK_WELCOME = '你好，我是小A。想听什么？';
const toUiMessages = (list) => (Array.isArray(list) ? list : []).map((message) => ({
    ...message,
    createdAt: Number(message?.createdAt) > 0 ? Number(message.createdAt) : undefined,
}));

export default function AssistantView({ section = 'conversation' }) {
    const {
        authSession,
        setAuthSession,
        enableThinking,
        setEnableThinking,
    } = useUIStore(
        useShallow((s) => ({
            authSession: s.authSession,
            setAuthSession: s.setAuthSession,
            enableThinking: s.xiaoaEnableThinking !== false,
            setEnableThinking: s.setXiaoaEnableThinking,
        }))
    );
    const hasCurrentSong = usePlayerStore((state) => Boolean(state.currentSong?.id));
    const { placement } = useCompactPlayerPlacement('assistant');
    const isAuthed = Boolean(authSession?.authenticated);
    const accountId = authSession?.user?.accountId || null;

    const [messages, setMessages] = React.useState([]);
    const [requestFailure, setRequestFailure] = React.useState(null);
    const visibleMessages = withAssistantFailure(messages,
        requestFailure?.accountId === accountId ? requestFailure : null);
    const [imageSelection, setImageSelection] = React.useState(null);
    const imagePreview = resolveAssistantImagePreview(visibleMessages, imageSelection, accountId);
    React.useEffect(() => {
        if (imageSelection && (!imagePreview || section !== 'conversation')) setImageSelection(null);
    }, [imageSelection, imagePreview, section]);
    const [inputText, setInputText] = React.useState('');
    const [attachments, setAttachments] = React.useState([]);
    const [attachmentsBusy, setAttachmentsBusy] = React.useState(false);
    const [imageInput, setImageInput] = React.useState(false);
    const [imageNotice, setImageNotice] = React.useState('');
    const [isLoading, setIsLoading] = React.useState(false);
    const [processClock, setProcessClock] = React.useState(() => Date.now());
    const [showScrollBottom, setShowScrollBottom] = React.useState(false);
    const [welcomeConfig, setWelcomeConfig] = React.useState({ accountId: null, text: FALLBACK_WELCOME, ready: false });
    const welcomeReady = welcomeConfig.ready && welcomeConfig.accountId === accountId;
    const welcomeText = welcomeConfig.text === FALLBACK_WELCOME ? t(FALLBACK_WELCOME) : welcomeConfig.text;
    const [phase, setPhase] = React.useState('skeleton');
    const [expandedDetails, setExpandedDetails] = React.useState({});
    const [playlistConfirmations, setPlaylistConfirmations] = React.useState({});

    const toggleExpandDetails = React.useCallback((msgId) => {
        setExpandedDetails((prev) => ({ ...prev, [msgId]: !prev[msgId] }));
    }, []);

    React.useEffect(() => {
        if (!isLoading) return undefined;
        setProcessClock(Date.now());
        const timer = window.setInterval(() => setProcessClock(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [isLoading]);

    const chatContainerRef = React.useRef(null);
    const textareaRef = React.useRef(null);
    const attachmentsRef = React.useRef(null);
    const abortControllerRef = React.useRef(null);
    const shouldFollowMessagesRef = React.useRef(true);
    const pendingAutoScrollRef = React.useRef(false);
    const scrollFrameRef = React.useRef(null);
    const threadRevisionRef = React.useRef(0);
    const recentPlaybackRef = React.useRef([]);
    const playerActionReceiptsRef = React.useRef([]);
    const executedPlayerActionIdsRef = React.useRef(new Set());
    const pendingPlaylistDecisionIdsRef = React.useRef(new Set());
    const accountIdRef = React.useRef(accountId);
    accountIdRef.current = accountId;

    React.useEffect(() => {
        let previous = usePlayerStore.getState().currentSong;
        return usePlayerStore.subscribe((state) => {
            const current = state.currentSong;
            if (previous?.id && previous.id !== current?.id) {
                recentPlaybackRef.current = [...recentPlaybackRef.current, {
                    title: previous.title, artist: previous.artist,
                }].slice(-3);
            }
            previous = current;
        });
    }, []);

    React.useEffect(() => {
        recentPlaybackRef.current = [];
        playerActionReceiptsRef.current = [];
        executedPlayerActionIdsRef.current.clear();
        pendingPlaylistDecisionIdsRef.current.clear();
        setPlaylistConfirmations({});
        setRequestFailure(null);
        setAttachments([]); setAttachmentsBusy(false); setImageInput(false); setImageNotice('');
    }, [accountId]);

    React.useEffect(() => {
        setWelcomeConfig({ accountId, text: FALLBACK_WELCOME, ready: !isAuthed });
        if (!isAuthed) return undefined;
        const controller = new AbortController();
        authenticatedFetch(`${getApiBaseUrl()}/api/ai/bootstrap`, { credentials: 'include', signal: controller.signal })
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
                if (controller.signal.aborted) return;
                const assistant = data?.assistant;
                setImageInput(data?.imageInput?.enabled === true);
                setWelcomeConfig({ accountId, text: typeof assistant?.welcomeMessage === 'string' && assistant.welcomeMessage.trim()
                    ? assistant.welcomeMessage.trim() : FALLBACK_WELCOME, ready: true });
            })
            .catch(() => {
                if (!controller.signal.aborted) setWelcomeConfig({ accountId, text: FALLBACK_WELCOME, ready: true });
            });
        return () => controller.abort();
    }, [isAuthed, accountId]);

    const scrollToBottom = React.useCallback((smooth = false) => {
        if (chatContainerRef.current) {
            chatContainerRef.current.scrollTo({
                top: chatContainerRef.current.scrollHeight,
                behavior: smooth ? 'smooth' : 'auto',
            });
            shouldFollowMessagesRef.current = true;
            if (!smooth) setShowScrollBottom(false);
        }
    }, []);

    const handleComposerHeightChange = React.useCallback(() => {
        if (shouldFollowMessagesRef.current) scrollToBottom();
    }, [scrollToBottom]);

    const checkScrollBottomState = React.useCallback(() => {
        if (!chatContainerRef.current) return;
        const { scrollTop, scrollHeight, clientHeight } = chatContainerRef.current;
        const isOverflowing = scrollHeight > clientHeight + 20;
        const isNearBottom = scrollHeight - scrollTop - clientHeight < 60;
        if (!pendingAutoScrollRef.current) {
            shouldFollowMessagesRef.current = isNearBottom;
        }
        setShowScrollBottom(isOverflowing && !isNearBottom);
    }, []);

    const handleScroll = React.useCallback(() => {
        checkScrollBottomState();
    }, [checkScrollBottomState]);

    React.useEffect(() => {
        checkScrollBottomState();
    }, [messages, requestFailure, isLoading, checkScrollBottomState]);

    const scheduleScrollToLatest = React.useCallback(() => {
        if (!shouldFollowMessagesRef.current) return;
        if (scrollFrameRef.current !== null) {
            cancelAnimationFrame(scrollFrameRef.current);
        }
        pendingAutoScrollRef.current = true;
        scrollFrameRef.current = requestAnimationFrame(() => {
            scrollFrameRef.current = requestAnimationFrame(() => {
                scrollFrameRef.current = null;
                pendingAutoScrollRef.current = false;
                if (shouldFollowMessagesRef.current) {
                    scrollToBottom();
                }
            });
        });
    }, [scrollToBottom]);

    const applyThread = React.useCallback((thread, expectedAccountId) => {
        if (!expectedAccountId || accountIdRef.current !== expectedAccountId) return false;
        if (!thread || !Number.isSafeInteger(thread.revision)) return false;
        threadRevisionRef.current = thread.revision;
        setMessages((previous) => toUiMessages(mergeAssistantProcessMessages(thread.messages, previous)));
        scheduleScrollToLatest();
        return true;
    }, [scheduleScrollToLatest]);

    const syncThread = React.useCallback(async ({ signal, expectedAccountId = accountIdRef.current } = {}) => {
        const { thread } = await fetchCloudThread({ signal });
        if (!signal?.aborted) applyThread(thread, expectedAccountId);
    }, [applyThread]);

    React.useEffect(() => {
        abortControllerRef.current?.abort();
        abortControllerRef.current = null;
        setIsLoading(false);
        threadRevisionRef.current = 0;
        setMessages([]);
        setPlaylistConfirmations({});
        setExpandedDetails({});
        if (!isAuthed) {
            setPhase('ready');
            return undefined;
        }
        const controller = new AbortController();
        let threadLoadFailed = false;
        setPhase('skeleton');
        syncThread({ signal: controller.signal, expectedAccountId: accountId })
            .catch((error) => {
                if (controller.signal.aborted || accountIdRef.current !== accountId) return;
                threadLoadFailed = true;
                if (error?.status === 401) {
                    setAuthSession({ authenticated: false, user: null, initialized: true });
                } else {
                    showToast(t("对话历史暂时无法载入，请稍后刷新。"));
                    setMessages([]);
                }
            })
            .finally(() => { if (!controller.signal.aborted && accountIdRef.current === accountId) setPhase(threadLoadFailed ? 'failed' : 'ready'); });
        return () => controller.abort();
    }, [isAuthed, accountId, setAuthSession, syncThread]);

    const handleStopGeneration = React.useCallback(() => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
        }
        setIsLoading(false);
    }, []);

    const handleClearMessages = React.useCallback(async () => {
        if (!window.confirm(t('确定要清空与小A的全部对话记录吗？'))) return;
        handleStopGeneration();
        const requestAccountId = accountIdRef.current;
        try {
            const response = await authenticatedFetch(`${getApiBaseUrl()}/api/ai/thread`, {
                method: 'DELETE',
                credentials: 'include',
                headers: localAssistantMutationHeaders(authSession?.csrfToken),
                body: JSON.stringify({ revision: threadRevisionRef.current }),
            });
            const data = await response.json().catch(() => ({}));
            if (accountIdRef.current !== requestAccountId) return;
            if (response.status === 409 && applyThread(data.thread, requestAccountId)) {
                showToast(t("对话已在其他页面更新，请确认后重试清空。"));
                return;
            }
            if (response.status === 401) {
                setAuthSession({ authenticated: false, user: null, initialized: true });
                return;
            }
            if (!response.ok || !applyThread(data.thread, requestAccountId)) {
                throw new Error(data.message || '清空失败，请重试。');
            }
            showToast(t("对话历史已清空"));
            setPlaylistConfirmations({});
            setRequestFailure(null);
        } catch (error) {
            if (accountIdRef.current === requestAccountId) showToast(t(error.message || '清空失败，请重试。'));
        }
    }, [applyThread, authSession?.csrfToken, handleStopGeneration, setAuthSession]);

    React.useEffect(() => {
        useUIStore.getState().setAssistantClearHandler(handleClearMessages);
        return () => useUIStore.getState().setAssistantClearHandler(null);
    }, [handleClearMessages]);

    const handlePlaylistConfirmationDecision = React.useCallback(async (id, decision) => {
        const item = playlistConfirmations[id];
        if (!item || item.status !== 'pending' || pendingPlaylistDecisionIdsRef.current.has(id)) return;
        pendingPlaylistDecisionIdsRef.current.add(id);
        if (decision === 'keep') {
            setPlaylistConfirmations((prev) => ({ ...prev, [id]: { ...item, status: 'kept' } }));
            pendingPlaylistDecisionIdsRef.current.delete(id);
            return;
        }
        if (decision !== 'delete') {
            pendingPlaylistDecisionIdsRef.current.delete(id);
            return;
        }
        setPlaylistConfirmations((prev) => ({ ...prev, [id]: { ...item, status: 'deleting' } }));
        try {
            const outcome = await confirmAssistantPlaylistDeletion(item.confirmation, {
                isCurrent: () => accountIdRef.current === item.accountId
                    && useUIStore.getState().authSession?.user?.accountId === item.accountId
                    && accountPlaylistsStore.getState().subject === item.accountId,
                deletePlaylist: (playlistId, revision) => accountPlaylistsStore.getState().deletePlaylist(playlistId, revision),
            });
            if (accountIdRef.current === item.accountId) {
                setPlaylistConfirmations((prev) => ({ ...prev, [id]: {
                    ...item, status: outcome === 'deleted' ? 'deleted' : 'account_changed',
                } }));
            }
        } catch (error) {
            if (accountIdRef.current === item.accountId) {
                setPlaylistConfirmations((prev) => ({ ...prev, [id]: {
                    ...item, status: 'failed', error: error.message || '删除失败，请重试。',
                } }));
            }
        } finally {
            pendingPlaylistDecisionIdsRef.current.delete(id);
        }
    }, [playlistConfirmations]);

    const handleSend = React.useCallback(async (overrideText) => {
        const text = (typeof overrideText === 'string' ? overrideText : inputText).trim();
        if (!isAuthed || (!text && !attachments.length) || attachmentsBusy || isLoading || phase !== 'ready') return;

        setInputText('');
        setRequestFailure(null);
        setImageNotice('');
        const clientMessageId = crypto.randomUUID();
        const userMsgId = `user-${clientMessageId}`;
        const assistantMsgId = `assistant-${clientMessageId}`;
        const userMessage = optimisticAssistantUserMessage(userMsgId, text, attachments);
        const sentImages = userMessage.images;

        const newMessages = [
            ...messages,
            userMessage,
            { id: assistantMsgId, role: 'assistant', content: '', createdAt: Date.now() + 1, isGenerating: true },
        ];
        setMessages(newMessages);
        setIsLoading(true);
        scheduleScrollToLatest();

        const controller = new AbortController();
        abortControllerRef.current = controller;
        const requestAccountId = authSession?.user?.accountId;
        const sentReceipts = playerActionReceiptsRef.current.slice(-10);
        const pendingPlayerActions = [];
        let lastPlayerAction = Promise.resolve();
        let canonicalThread = null;
        let completed = false;
        let renderedContent = '';
        let streamedContent = '';
        let liveThought = '';
        let liveProcessEntries = [];
        let typewriter;

        try {
            typewriter = createAiResponseTypewriter({
                prefersReducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true,
                onDisplay: (renderedText) => {
                    if (accountIdRef.current !== requestAccountId || controller.signal.aborted) return;
                    renderedContent = renderedText;
                    setMessages((prev) =>
                        prev.map((m) => (m.id === assistantMsgId ? { ...m, content: renderedText, isGenerating: true } : m))
                    );
                    scheduleScrollToLatest();
                },
            });

            const response = await authenticatedFetch(`${getApiBaseUrl()}/api/ai/chat`, {
                method: 'POST',
                headers: { ...localAssistantMutationHeaders(authSession?.csrfToken), 'X-FlareTune-Expected-Account': requestAccountId },
                credentials: 'include',
                signal: controller.signal,
                body: JSON.stringify({
                    message: text,
                    client_message_id: clientMessageId,
                    revision: threadRevisionRef.current,
                    enable_thinking: enableThinking,
                    ...(sentImages.length ? { image_ids: sentImages.map(image => image.id) } : {}),
                    context: captureAssistantLiveContext(usePlayerStore.getState(),
                        recentPlaybackRef.current, sentReceipts),
                }),
            });
            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                if (accountIdRef.current !== requestAccountId || controller.signal.aborted) return;
                if (response.status === 409) applyThread(data.thread, requestAccountId);
                if (data.error === 'assistant_images_disabled') { setImageInput(false); setAttachments([]); setInputText(text); }
                if (response.status === 401) {
                    setAuthSession({ authenticated: false, user: null, initialized: true });
                }
                throw Object.assign(new Error(data.message || t('助手暂时无法回应 ({status})', { status: response.status })), { code: data.error });
            }
            setAttachments([]);
            await consumeSseJsonStream(response.body, {
                signal: controller.signal,
                onEvent: async (event) => {
                    if (accountIdRef.current !== requestAccountId || controller.signal.aborted) return;
                    if (event.type === 'image_notice' && typeof event.message === 'string') {
                        setImageNotice(event.message);
                    } else if (event.type === 'content_delta' && typeof event.content === 'string') {
                        const respondedAt = Date.now();
                        setMessages((prev) => prev.map((message) => message.id === assistantMsgId
                            ? { ...message, processingStartedAt: message.processingStartedAt || respondedAt }
                            : message));
                        streamedContent += event.content;
                        typewriter.append(event.content);
                    } else if (event.type === 'content_reset') {
                        streamedContent = '';
                        typewriter.reset();
                    } else if (event.type === 'content' && typeof event.content === 'string') {
                        const respondedAt = Date.now();
                        setMessages((prev) => prev.map((message) => message.id === assistantMsgId
                            ? { ...message, processingStartedAt: message.processingStartedAt || respondedAt }
                            : message));
                        const correction = reconcileAiResponseContent(streamedContent, event.content);
                        if (correction.reset) typewriter.reset();
                        streamedContent = event.content;
                        typewriter.append(correction.append);
                    } else if (event.type === 'thought' && typeof event.content === 'string') {
                        const respondedAt = Date.now();
                        const start = liveThought.length;
                        liveThought = `${liveThought}${event.content}`.slice(0, 100000);
                        liveProcessEntries = appendThoughtProcessEntry(liveProcessEntries, start, liveThought.length);
                        const thought = liveThought;
                        const processEntries = liveProcessEntries;
                        setMessages((prev) => prev.map((message) => message.id === assistantMsgId
                            ? { ...message, thought, processEntries,
                                processingStartedAt: message.processingStartedAt || respondedAt }
                            : message));
                    } else if (event.type === 'tool_call') {
                        const respondedAt = Date.now();
                        liveProcessEntries = appendToolProcessEntry(liveProcessEntries, {
                            id: event.id, name: event.displayName || event.name || '工具调用', progress: event.progress,
                        });
                        const processEntries = liveProcessEntries;
                        setMessages((prev) => prev.map((message) => message.id === assistantMsgId
                            ? { ...message, processingStartedAt: message.processingStartedAt || respondedAt,
                                processEntries }
                            : message));
                    } else if (event.type === 'tool_result') {
                        if (event.name === 'remember_user' && event.data?.ok === true
                            && ['created', 'updated'].includes(event.data.action)) {
                            showToast(t("记忆已更新"));
                        }
                        liveProcessEntries = finishToolProcessEntry(liveProcessEntries, {
                            id: event.id, summary: event.summary,
                            ok: event.data?.ok !== false || event.data?.error === 'CONFIRMATION_REQUIRED',
                        });
                        const processEntries = liveProcessEntries;
                        setMessages((prev) => prev.map((message) => message.id === assistantMsgId
                            ? { ...message, processEntries }
                            : message));
                        if (event.name === 'manage_playlist' && event.data?.error === 'CONFIRMATION_REQUIRED') {
                            setPlaylistConfirmations((prev) => ({ ...prev, [event.id]: {
                                id: event.id, messageId: assistantMsgId, accountId: requestAccountId,
                                confirmation: event.data.confirmation, status: 'pending',
                            } }));
                        }
                    } else if (event.type === 'player_action' && typeof event.id === 'string') {
                        const key = `${requestAccountId}:${event.id}`;
                        if (executedPlayerActionIdsRef.current.has(key)) return;
                        executedPlayerActionIdsRef.current.add(key);
                        const action = lastPlayerAction.then(() => {
                            if (!requestAccountId || useUIStore.getState().authSession?.user?.accountId !== requestAccountId) {
                                return { ok: false, outcome: 'account_changed' };
                            }
                            return dispatchLocalAssistantPlayerAction(event.action);
                        }).then((result) => {
                            if (accountIdRef.current !== requestAccountId) return;
                            playerActionReceiptsRef.current = [...playerActionReceiptsRef.current, {
                                id: event.id, ok: result?.ok === true, outcome: result?.outcome || result?.error || 'unknown',
                            }].slice(-10);
                        }).catch(() => {
                            if (accountIdRef.current !== requestAccountId) return;
                            playerActionReceiptsRef.current = [...playerActionReceiptsRef.current, {
                                id: event.id, ok: false, outcome: 'browser_execution_failed',
                            }].slice(-10);
                        });
                        lastPlayerAction = action;
                        pendingPlayerActions.push(action);
                    } else if (event.type === 'error') {
                        throw Object.assign(new Error(typeof event.message === 'string' && event.message.trim()
                            ? event.message.trim() : '小A暂时无法回应，请稍后再试。'), { code: event.error });
                    } else if (event.type === 'thread_state') {
                        canonicalThread = event.thread;
                    } else if (event.type === 'done') {
                        completed = true;
                    }
                },
            });
            await Promise.all(pendingPlayerActions);
            if (!completed || !canonicalThread) throw new Error('助手响应未完成，请刷新对话记录。');
            await typewriter.finish();
            if (accountIdRef.current !== requestAccountId || controller.signal.aborted) return;
            const lastMessage = canonicalThread.messages?.at(-1);
            if (lastMessage?.role === 'assistant' && lastMessage.id) {
                setPlaylistConfirmations((prev) => rebindAssistantPlaylistConfirmations(
                    prev, assistantMsgId, lastMessage.id,
                ));
                setExpandedDetails((previous) => {
                    if (!Object.hasOwn(previous, assistantMsgId)) return previous;
                    const next = { ...previous, [lastMessage.id]: previous[assistantMsgId] };
                    if (lastMessage.id !== assistantMsgId) delete next[assistantMsgId];
                    return next;
                });
            }
            const visibleThread = lastMessage?.role === 'assistant' && liveProcessEntries.length > 0
                ? { ...canonicalThread, messages: mergeAssistantProcessMessages(canonicalThread.messages,
                    [{ ...lastMessage, thought: liveThought, processEntries: liveProcessEntries }]) }
                : canonicalThread;
            applyThread(visibleThread, requestAccountId);
            const sentIds = new Set(sentReceipts.map((item) => item.id));
            playerActionReceiptsRef.current = playerActionReceiptsRef.current.filter((item) => !sentIds.has(item.id));
        } catch (err) {
            typewriter?.cancel();
            if (accountIdRef.current !== requestAccountId || controller.signal.aborted) return;
            const failureContent = assistantFailureMessage(err);
            setRequestFailure({ id: assistantMsgId, role: 'assistant', accountId: requestAccountId,
                clientMessageId, userMessage: newMessages.at(-2), content: failureContent,
                thought: liveThought, processEntries: liveProcessEntries, createdAt: Date.now(), isError: true });
            if (err.name !== 'AbortError') showToast(t(failureContent));
            if (useUIStore.getState().authSession?.authenticated) {
                await syncThread({ expectedAccountId: requestAccountId }).catch(() => {
                    if (accountIdRef.current !== requestAccountId) return;
                    setMessages((prev) => prev.map((message) => message.id === assistantMsgId
                        ? { ...message, content: renderedContent || '请求未完成，请稍后刷新对话记录。', isGenerating: false, isError: true }
                        : message));
                });
            }
        } finally {
            if (accountIdRef.current === requestAccountId) setIsLoading(false);
            if (abortControllerRef.current === controller) abortControllerRef.current = null;
            if (accountIdRef.current === requestAccountId) scheduleScrollToLatest();
        }
    }, [applyThread, authSession, attachments, attachmentsBusy, enableThinking, inputText, isAuthed, isLoading, messages, phase, scheduleScrollToLatest, setAuthSession, syncThread]);

    const handleFormSubmit = React.useCallback((e) => {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        handleSend();
    }, [handleSend]);

    const handleKeyDown = React.useCallback((e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    }, [handleSend]);

    const handleSuggestionClick = React.useCallback((text) => {
        handleSend(text);
    }, [handleSend]);

    if (section === 'memory') return <AssistantMemoryView />;
    return (
        <div className={`app-page xiaoa-page assistant-page flex flex-col h-full w-full relative overflow-hidden select-text !pt-0 ${placement === 'dock' && hasCurrentSong ? 'assistant-page--with-dock' : ''}`}>
            <h1 className="sr-only">{t("助手")}</h1>

            {/* 对话区主体（通透流式布局） */}
            <div className="flex-1 min-h-0 flex flex-col w-full relative">
                <AiReviewConversation
                    containerRef={chatContainerRef}
                    expandedDetails={expandedDetails}
                    messages={visibleMessages}
                    playlistConfirmations={playlistConfirmations}
                    onPlaylistConfirmationDecision={handlePlaylistConfirmationDecision}
                    onPreviewImage={(messageId, imageId) => setImageSelection({ accountId, messageId, imageId })}
                    onScroll={handleScroll}
                    onToggleDetails={toggleExpandDetails}
                    phase={phase}
                    processClock={processClock}
                    welcomeReady={welcomeReady}
                    welcomeText={welcomeText}
                />

                <div className="assistant-composer-area relative w-full shrink-0">
                    {/* 回到底部按钮跟随输入区顶部，避免输入框增高后重叠 */}
                    <button
                        type="button"
                        onClick={() => scrollToBottom(true)}
                        data-visible={showScrollBottom}
                        disabled={!showScrollBottom}
                        aria-hidden={!showScrollBottom}
                        className="assistant-scroll-bottom p-2.5 rounded-full border border-[var(--line)] text-[var(--ink)] shadow-lg cursor-pointer z-20"
                        aria-label={t("回到底部")}
                    >
                        <ArrowDown size={17} />
                    </button>

                    <AiReviewComposer
                        hasAttachments={attachments.length > 0}
                        attachmentsBusy={attachmentsBusy}
                        attachments={imageInput ? <AssistantAttachments ref={attachmentsRef} key={accountId} session={authSession} attachments={attachments} onChange={setAttachments} onBusy={setAttachmentsBusy} disabled={isLoading || phase !== 'ready'} /> : null}
                        onAttachImage={imageInput ? () => attachmentsRef.current?.pick() : undefined}
                        onImageFiles={imageInput ? files => attachmentsRef.current?.addFiles(files) : undefined}
                        attachmentLimitReached={attachments.length >= 4}
                        authenticated={isAuthed}
                        enableThinking={enableThinking}
                        onToggleThinking={() => setEnableThinking(!enableThinking)}
                        textareaRef={textareaRef}
                        inputText={inputText}
                        isLoading={isLoading}
                        phase={phase}
                        onInputChange={setInputText}
                        onKeyDown={handleKeyDown}
                        onSubmit={handleFormSubmit}
                        onStop={handleStopGeneration}
                        onHeightChange={handleComposerHeightChange}
                    />
                    {imageNotice && <p role="status" className="mx-auto max-w-3xl px-4 py-1 text-xs text-[var(--muted)]">{t(imageNotice)}</p>}
                </div>
            </div>
            {imagePreview && <ImagePreviewDialog key={imagePreview.url} image={imagePreview} onClose={() => setImageSelection(null)} />}
        </div>
    );
}

export const XiaoaView = AssistantView;
