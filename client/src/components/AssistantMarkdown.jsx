import React from 'react';
import { renderMarkdownSafe } from '../assistantMarkdownRenderer.js';
import { insertInlineCursorHtml } from '../aiResponseTypewriter.js';
import { activateInlineAssistantSong } from '../services/assistantInlinePlayback.js';

export { renderMarkdownSafe };

/**
 * 完整 GitHub Flavored Markdown 渲染组件
 */
export function AssistantMarkdown({ content, showCursor = false }) {
    if (!content && !showCursor) return null;

    const html = React.useMemo(() => {
        const rendered = renderMarkdownSafe(content || '');
        return showCursor ? insertInlineCursorHtml(rendered) : rendered;
    }, [content, showCursor]);

    const handleClick = (e) => activateInlineAssistantSong(e);
    const handleKeyDown = (e) => activateInlineAssistantSong(e, { keyboard: true });

    return (
        <div
            className="prose-paper whitespace-normal break-words"
            onClick={handleClick}
            onKeyDown={handleKeyDown}
            dangerouslySetInnerHTML={{ __html: html }}
        />
    );
}

export const XiaoaMarkdown = AssistantMarkdown;
export const MarkdownContent = AssistantMarkdown;
export default AssistantMarkdown;
