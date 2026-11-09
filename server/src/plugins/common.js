import { AuthError } from '../auth/local/index.js';
import { isUsableCredentialMaterial } from '../instance/credentialFormat.js';

export const pluginFail = (code, status = 409, publicDetails) => {
  const error = new AuthError(code, status);
  if (publicDetails) error.publicDetails = publicDetails;
  throw error;
};
export const sessionPredicate = `EXISTS (SELECT 1 FROM account_sessions s
  JOIN accounts a ON a.account_id=s.account_id JOIN account_credentials c ON c.account_id=a.account_id
  WHERE s.token_hash=? AND s.account_id=? AND s.mode='normal' AND s.revoked_at IS NULL
    AND s.expires_at>? AND a.status='active' AND c.must_change_password=0 AND (?=0 OR a.role='admin'))`;
export const sessionBindings = (session, now, admin = false) => [session.tokenHash, session.account.accountId, now, admin ? 1 : 0];

export async function requirePluginSession(env, session, admin = false) {
  if (session?.mode !== 'normal' || !['admin', 'member'].includes(session.account?.role)
    || (admin && session.account.role !== 'admin')) pluginFail('forbidden', 403);
  const row = await env.DB.prepare(`SELECT c.*,a.role AS current_role FROM account_credentials c
    JOIN accounts a ON a.account_id=c.account_id WHERE c.account_id=? AND ${sessionPredicate}`)
    .bind(session.account.accountId, ...sessionBindings(session, Date.now(), admin)).first();
  if (!row || !isUsableCredentialMaterial(row)) pluginFail('forbidden', 403);
  return { accountId: session.account.accountId, role: row.current_role };
}

export async function sha256(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
