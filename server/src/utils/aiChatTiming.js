const elapsed = (start, value) => (value == null ? null : Math.max(0, Math.round(value - start)));

export function createAiChatTiming({ now = () => Date.now() } = {}) {
  const startedAt = now();
  const marks = {};
  let provider = '';
  let model = '';
  let rounds = 0;
  let finishReason = '';
  let streamEnd = '';
  let finalized = false;

  const markOnce = (name) => {
    if (marks[name] == null) marks[name] = now();
  };

  return {
    setModel(nextProvider, nextModel) {
      provider = String(nextProvider || '').slice(0, 40);
      model = String(nextModel || '').slice(0, 120);
    },
    modelRequestStarted() {
      rounds += 1;
      markOnce('modelStartedAt');
    },
    visibleContent() {
      markOnce('firstVisibleAt');
    },
    streamEvent(event = {}) {
      if (event.type === 'first_chunk') markOnce('firstChunkAt');
      if (event.type === 'finish_reason') {
        markOnce('finishReasonAt');
        finishReason = String(event.finishReason || '').slice(0, 60);
        streamEnd = 'finish_reason';
      }
      if (event.type === 'eof') {
        markOnce('streamEndAt');
        if (!streamEnd) streamEnd = 'eof';
      }
      if (event.type === 'idle_timeout') {
        markOnce('streamEndAt');
        streamEnd = 'idle_timeout';
      }
    },
    finalize(outcome, errorCode = '') {
      if (finalized) return null;
      finalized = true;
      const completedAt = now();
      return {
        event: 'xiaoa_chat_timing',
        provider,
        model,
        rounds,
        outcome: String(outcome || 'unknown').slice(0, 20),
        errorCode: String(errorCode || '').slice(0, 60),
        finishReason,
        streamEnd,
        preflightMs: elapsed(startedAt, marks.modelStartedAt),
        firstUpstreamChunkMs: elapsed(startedAt, marks.firstChunkAt),
        firstVisibleContentMs: elapsed(startedAt, marks.firstVisibleAt),
        finishReasonMs: elapsed(startedAt, marks.finishReasonAt),
        streamEndMs: elapsed(startedAt, marks.streamEndAt),
        totalMs: elapsed(startedAt, completedAt),
      };
    },
  };
}

export function logAiChatTiming(timing) {
  if (timing) console.info('XIAOA_CHAT_TIMING', JSON.stringify(timing));
}
