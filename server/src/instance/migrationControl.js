const validToken = (token) => typeof token === 'string' && /^[a-f0-9]{32,128}$/i.test(token);
const validTime = (value) => Number.isSafeInteger(value) && value > 0;

export async function acquireMigrationLease(db, ownerToken, now = Date.now(), leaseMs = 60_000) {
  if (!validToken(ownerToken) || !validTime(now) || !Number.isSafeInteger(leaseMs) || leaseMs < 10_000 || leaseMs > 300_000) {
    throw new TypeError('Invalid migration lease parameters');
  }
  const result = await db.prepare(`UPDATE ft_migration_lock
    SET owner_token = ?, lease_expires_at = ?, updated_at = ?
    WHERE id = 1 AND (owner_token IS NULL OR lease_expires_at <= ?)`)
    .bind(ownerToken, now + leaseMs, now, now).run();
  return result?.meta?.changes === 1;
}

export async function releaseMigrationLease(db, ownerToken, now = Date.now()) {
  if (!validToken(ownerToken) || !validTime(now)) throw new TypeError('Invalid migration lease parameters');
  const result = await db.prepare(`UPDATE ft_migration_lock
    SET owner_token = NULL, lease_expires_at = 0, updated_at = ?
    WHERE id = 1 AND owner_token = ?`)
    .bind(now, ownerToken).run();
  return result?.meta?.changes === 1;
}
