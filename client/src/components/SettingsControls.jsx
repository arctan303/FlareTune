import React from 'react';
export const SettingsDialogContext = React.createContext(null);

export const SettingsButton = React.forwardRef(function SettingsButton({ variant = 'secondary', className = '', type = 'button', closeDialog = false, ...props }, ref) {
  const requestClose = React.useContext(SettingsDialogContext);
  return <button ref={ref} type={type} className={`settings-button settings-button--${variant} ${variant === 'primary' ? 'primary-button' : ''} ${className}`} {...props} onClick={closeDialog && requestClose ? requestClose : props.onClick} />;
});

export function SettingsActions({ children, className = '' }) {
  return <div className={`settings-actions ${className}`}>{children}</div>;
}

export function SettingsToggle({ label, description, className = '', ...props }) {
  return <label className={`settings-toggle-row ${className}`}>
    <span className="min-w-0"><span className="block">{label}</span>
      {description && <span className="mt-1 block text-xs font-normal text-[var(--muted)]">{description}</span>}
    </span>
    <input {...props} type="checkbox" role="switch" className="settings-switch" />
  </label>;
}
