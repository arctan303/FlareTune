import { t } from '../i18n/index.js';
import React from 'react';
import { ArrowUp, Brain, Square } from 'lucide-react';

export function AiReviewComposer({
  authenticated,
  enableThinking,
  onToggleThinking,
  textareaRef,
  inputText,
  isLoading,
  phase,
  onInputChange,
  onKeyDown,
  onSubmit,
  onStop,
  onHeightChange,
}) {
  const resizePageInput = React.useCallback(() => {
    if (!textareaRef?.current) return;
    const textarea = textareaRef.current;
    textarea.style.height = 'auto';
    const style = window.getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(style.lineHeight) || 22;
    const padding = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
    const oneLineHeight = Math.ceil(lineHeight + padding);
    const maxHeight = Math.ceil(lineHeight * 6 + padding);
    const contentHeight = textarea.scrollHeight;
    textarea.style.height = `${Math.min(Math.max(contentHeight, oneLineHeight), maxHeight)}px`;
    textarea.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden';
    onHeightChange?.();
  }, [onHeightChange, textareaRef]);

  React.useLayoutEffect(() => {
    resizePageInput();
  }, [inputText, resizePageInput]);

  React.useEffect(() => {
    window.addEventListener('resize', resizePageInput);
    return () => window.removeEventListener('resize', resizePageInput);
  }, [resizePageInput]);

  if (!authenticated) return null;

  return (
      <div className="assistant-composer-wrap w-full max-w-3xl lg:max-w-4xl mx-auto shrink-0 z-10">
        <form onSubmit={onSubmit} className="assistant-composer">
          <div className="assistant-composer__field">
            <textarea
              ref={textareaRef}
              rows={1}
              value={inputText}
              onChange={(event) => onInputChange(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder={t("聊聊音乐…")}
              disabled={isLoading || phase !== 'ready'}
              className="assistant-composer__input"
            />
          </div>
          <div className="assistant-composer__toolbar">
            <div className="assistant-composer__options">
              <button type="button" className={`assistant-composer__thinking${enableThinking ? ' is-active' : ''}`}
                onClick={onToggleThinking} aria-pressed={Boolean(enableThinking)}>
                <Brain size={16} aria-hidden="true" /><span>{t("思考模式")}</span>
              </button>
            </div>
            {isLoading ? (
              <button type="button" onClick={onStop} title={t("停止生成")} className="assistant-composer__action" aria-label={t("停止生成")}>
                <Square size={15} fill="currentColor" />
              </button>
            ) : (
              <button type="submit" disabled={!inputText.trim() || phase !== 'ready'} title={t("发送")} className="assistant-composer__action" aria-label={t("发送问题")}>
                <ArrowUp size={21} strokeWidth={2.6} />
              </button>
            )}
          </div>
        </form>
      </div>
  );
}
