export default function SettingsSection({ title, description, children }) {
  return (
    <section className="wallpaper-content-surface space-y-4 rounded-3xl border border-[var(--line)] bg-[var(--surface-raised)] p-5 shadow-xs sm:p-7">
      <div>
        <h2 className="text-base font-bold text-[var(--ink)]">{title}</h2>
        {description && <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">{description}</p>}
      </div>
      <div>{children}</div>
    </section>
  );
}
