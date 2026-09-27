import React from 'react';

export function HighlightText({ text, query, className = '' }) {
  if (!text) return null;
  const q = (query || '').trim();
  if (!q) return <span className={className}>{text}</span>;

  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escaped})`, 'gi');
  const parts = String(text).split(regex);

  return (
    <span className={className}>
      {parts.map((part, index) => {
        if (part.toLowerCase() === q.toLowerCase()) {
          return (
            <mark key={index} className="search-highlight">
              {part}
            </mark>
          );
        }
        return <React.Fragment key={index}>{part}</React.Fragment>;
      })}
    </span>
  );
}

export default HighlightText;
