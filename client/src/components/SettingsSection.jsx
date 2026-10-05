export default function SettingsSection({ title, description, action, children, className = '' }) {
  return (
    <section className={`wallpaper-content-surface space-y-3.5 rounded-2xl border border-[var(--line)] bg-[var(--surface-raised)] p-4 sm:p-5 shadow-2xs ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-bold text-[var(--ink)]">{title}</h2>
          {description && <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">{description}</p>}
        </div>
        {action && <div className="ml-auto max-w-full shrink-0">{action}</div>}
      </div>
      <div>{children}</div>
    </section>
  );
}
