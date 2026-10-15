import React from 'react';
import { Edit3, KeyRound } from 'lucide-react';
import { SettingsInput, SettingsWriteButton } from './SettingsReadOnly.jsx';
import SelectControl from './SelectControl.jsx';
import { t } from '../i18n/index.js';
import { validLocalPassword } from '../instance/state.js';
import { adminErrorMessage, patchManagedAccount, resetManagedPassword } from '../instance/adminApi.js';
import { Field, inputClass, buttonClass } from './AdminSettingsFields.jsx';

export default function AccountRow({ account, csrfToken, onSaved, onMessage, busy, setBusy }) {
  const [resetOpen, setResetOpen] = React.useState(false);
  const [editOpen, setEditOpen] = React.useState(false);
  const [displayName, setDisplayName] = React.useState(account.displayName || '');
  const [role, setRole] = React.useState(account.role);
  const [status, setStatus] = React.useState(account.status);

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    onMessage('');
    try {
      const result = await patchManagedAccount(account.accountId,
        { displayName, role, status, expectedUpdatedAt: account.updatedAt }, csrfToken);
      onSaved(result.account);
      setEditOpen(false);
      onMessage('账号已更新。');
    } catch (error) { onMessage(adminErrorMessage(error)); }
    finally { setBusy(false); }
  }

  async function reset(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const password = new FormData(form).get('temporaryPassword');
    if (!validLocalPassword(password)) {
      onMessage('临时密码至少需要 8 个字符，且不能超过 1024 字节。');
      return;
    }
    setBusy(true);
    onMessage('');
    try {
      await resetManagedPassword(account.accountId, password, csrfToken);
      form.reset();
      setResetOpen(false);
      onMessage(t("已重置 {p0} 的临时密码；请通过安全渠道交给本人，首次登录须改密。", { p0: (account.username) }));
    } catch (error) { onMessage(adminErrorMessage(error)); }
    finally { setBusy(false); }
  }

  const cancelEdit = () => {
    setDisplayName(account.displayName || '');
    setRole(account.role);
    setStatus(account.status);
    setEditOpen(false);
  };

  return (
    <div className={`wallpaper-content-surface rounded-2xl border transition-all ${
      editOpen || resetOpen
        ? 'border-[var(--line-strong)] bg-[var(--surface-raised)] shadow-xs'
        : 'border-[var(--line)] bg-[var(--surface)] hover:border-[var(--line-strong)]'
    } p-3.5 sm:p-4 space-y-3`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 rounded-full bg-[var(--surface-raised)] border border-[var(--line)] flex items-center justify-center font-bold text-xs text-[var(--accent)] shrink-0">
            {(account.username || 'U').slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <strong className="text-xs font-bold text-[var(--ink)]">{account.username}</strong>
              {account.displayName && (
                <span className="text-xs text-[var(--muted)] truncate">({account.displayName})</span>
              )}
            </div>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                account.role === 'admin'
                  ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 font-semibold'
                  : 'bg-[var(--line)] text-[var(--muted)]'
              }`}>
                {account.role === 'admin' ? t("系统管理员") : t("普通成员")}
              </span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                account.status === 'active'
                  ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                  : 'bg-rose-500/15 text-rose-600 dark:text-rose-400'
              }`}>
                {account.status === 'active' ? t("启用中") : t("已停用")}
              </span>
            </div>
          </div>
        </div>

        {/* 操作按钮组 */}
        <div className="flex items-center gap-2 ml-auto">
          <button
            type="button"
            className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
              editOpen
                ? 'bg-current/10 text-[var(--ink)] font-semibold'
                : 'text-[var(--muted)] hover:text-[var(--ink)] hover:bg-current/5'
            }`}
            onClick={() => {
              setEditOpen((v) => !v);
              if (!editOpen) setResetOpen(false);
            }}
            aria-expanded={editOpen}
          >
            <Edit3 size={12} />
            <span>{editOpen ? t("收起") : t("编辑")}</span>
          </button>

          <button
            type="button"
            className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
              resetOpen
                ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 font-semibold'
                : 'text-[var(--accent)] hover:opacity-80 hover:bg-[var(--accent)]/10'
            }`}
            onClick={() => {
              setResetOpen((v) => !v);
              if (!resetOpen) setEditOpen(false);
            }}
            aria-expanded={resetOpen}
          >
            <KeyRound size={12} />
            <span>{resetOpen ? t("收起重置") : t("重置密码")}</span>
          </button>
        </div>
      </div>

      {/* 编辑表单：折叠展开 */}
      {editOpen && (
        <form onSubmit={save} className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_7rem_7rem_auto] sm:items-end pt-3 border-t border-[var(--line)] animate-[fade-in_0.15s_ease-out]">
          <Field label={t("显示名称")}>
            <SettingsInput className={inputClass} maxLength={80} value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder={t("用户昵称")} />
          </Field>
          <Field label={t("角色")}>
            <SelectControl aria-label={t("角色")} className={inputClass} value={role} onChange={(event) => setRole(event.target.value)}>
              <option value="member">{t("普通成员")}</option>
              <option value="admin">{t("系统管理员")}</option>
            </SelectControl>
          </Field>
          <Field label={t("状态")}>
            <SelectControl aria-label={t("状态")} className={inputClass} value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="active">{t("启用")}</option>
              <option value="disabled">{t("停用")}</option>
            </SelectControl>
          </Field>
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={cancelEdit}
              className="rounded-xl px-3 py-2 text-xs font-medium text-[var(--muted)] hover:text-[var(--ink)] cursor-pointer"
            >{t("取消")}</button>
            <SettingsWriteButton className={buttonClass} type="submit" disabled={busy}>{t("保存")}</SettingsWriteButton>
          </div>
        </form>
      )}

      {/* 密码重置表单：折叠展开 */}
      {resetOpen && (
        <form onSubmit={reset} className="mt-3 flex flex-wrap items-end gap-3 rounded-xl bg-[var(--surface-raised)] border border-[var(--line)] p-3 animate-[fade-in_0.15s_ease-out]">
          <div className="flex-1 min-w-[200px]">
            <Field label={t("一次性临时密码")}>
              <SettingsInput className={inputClass} type="password" name="temporaryPassword" autoComplete="new-password" minLength={8} maxLength={1024} required placeholder={t("输入新的临时密码（至少 8 位）")} />
            </Field>
          </div>
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setResetOpen(false)}
              className="rounded-xl px-3 py-2 text-xs font-medium text-[var(--muted)] hover:text-[var(--ink)] cursor-pointer"
            >{t("取消")}</button>
            <SettingsWriteButton className={buttonClass} type="submit" disabled={busy}>{t("确认重置")}</SettingsWriteButton>
          </div>
        </form>
      )}
    </div>
  );
}
