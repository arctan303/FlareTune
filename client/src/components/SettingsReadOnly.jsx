import React from 'react';

// Opt-in presentation policy. Real instances retain their existing permissions;
// the independent demo supplies this context around shared configuration screens.
export const SettingsReadOnlyContext = React.createContext(false);
export const useSettingsReadOnly = () => React.useContext(SettingsReadOnlyContext);

export const SettingsInput = React.forwardRef(function SettingsInput({ allowInReadOnly = false, disabled, ...props }, ref) {
  const readOnly = useSettingsReadOnly();
  return <input {...props} ref={ref} disabled={disabled || (readOnly && !allowInReadOnly)} />;
});

export const SettingsTextarea = React.forwardRef(function SettingsTextarea({ disabled, ...props }, ref) {
  const readOnly = useSettingsReadOnly();
  return <textarea {...props} ref={ref} disabled={disabled || readOnly} />;
});

export const SettingsWriteButton = React.forwardRef(function SettingsWriteButton({ disabled, ...props }, ref) {
  const readOnly = useSettingsReadOnly();
  return <button {...props} ref={ref} disabled={disabled || readOnly} />;
});
