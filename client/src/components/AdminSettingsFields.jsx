import React from 'react';
import { InfoTip } from './SettingsControls.jsx';

export const inputClass = 'w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3.5 py-2.5 text-xs text-[var(--ink)] placeholder:text-[var(--muted)] outline-none focus:border-[var(--accent)] transition-colors';
export const buttonClass = 'settings-button settings-button--primary primary-button';

export function Field({ label, hint, info, children }) {
  const generatedId = React.useId();
  const content = React.Children.toArray(children);
  const control = content.find(React.isValidElement);
  const id = control?.props.id || generatedId;
  const hintId = `${generatedId}-hint`;
  return (
    <div className="block space-y-1.5 text-xs text-[var(--ink)]">
      <span className="inline-flex items-center gap-1.5 font-semibold">
        <label htmlFor={id}>{label}</label>
        {info && <InfoTip text={info} />}
      </span>
      {content.map(child => child === control ? React.cloneElement(child, {
        id, 'aria-describedby': [child.props['aria-describedby'], hint ? hintId : null].filter(Boolean).join(' ') || undefined,
      }) : child)}
      {hint && <span id={hintId} className="block text-[11px] text-[var(--muted)] leading-relaxed">{hint}</span>}
    </div>
  );
}
