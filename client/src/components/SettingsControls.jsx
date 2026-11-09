import React from 'react';
import { useSettingsReadOnly } from './SettingsReadOnly.jsx';
export const SettingsDialogContext = React.createContext(null);

export function InfoTip({ text, label, className = '' }) {
  const id = React.useId();
  if (!text) return null;
  return (
    <span className={`settings-info-tip ${className}`}>
      <button type="button" className="settings-info-tip__trigger" aria-label={label || text} aria-describedby={id}>
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4M12 8h.01" />
        </svg>
      </button>
      <span id={id} role="tooltip" className="settings-info-tip__content">{text}</span>
    </span>
  );
}

export const SettingsButton = React.forwardRef(function SettingsButton({ variant = 'secondary', className = '', type = 'button', closeDialog = false, readOnlyAction = false, disabled, ...props }, ref) {
  const requestClose = React.useContext(SettingsDialogContext);
  const readOnly = useSettingsReadOnly();
  return <button ref={ref} type={type} disabled={disabled || (readOnly && (readOnlyAction || type === 'submit' || variant === 'danger'))} className={`settings-button settings-button--${variant} ${variant === 'primary' ? 'primary-button' : ''} ${className}`} {...props} onClick={closeDialog && requestClose ? requestClose : props.onClick} />;
});

export function SettingsActions({ children, className = '' }) {
  return <div className={`settings-actions ${className}`}>{children}</div>;
}

export function SettingsToggle({ label, description, info, className = '', ...props }) {
  const readOnly = useSettingsReadOnly();
  return <label className={`settings-toggle-row ${className}`}>
    <span className="min-w-0">
      <span className="inline-flex items-center gap-1.5">{label}{info && <InfoTip text={info} />}</span>
      {description && <span className="mt-1 block text-xs font-normal text-[var(--muted)]">{description}</span>}
    </span>
    <input {...props} disabled={props.disabled || readOnly} type="checkbox" role="switch" className="settings-switch" />
  </label>;
}
