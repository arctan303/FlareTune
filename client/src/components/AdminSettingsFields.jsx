import React from 'react';

export const inputClass = 'w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3.5 py-2.5 text-xs text-[var(--ink)] placeholder:text-[var(--muted)] outline-none focus:border-[var(--accent)] transition-colors';
export const buttonClass = 'settings-button settings-button--primary primary-button';

export function Field({ label, hint, children }) {
  return (
    <label className="block space-y-1.5 text-xs text-[var(--ink)]">
      <span className="font-semibold">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-[var(--muted)] leading-relaxed">{hint}</span>}
    </label>
  );
}
