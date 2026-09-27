export function filterEntries(entries, { query = '', status = 'all', language = 'all' } = {}) {
  const text = query.trim().toLocaleLowerCase();
  return entries.filter((entry) => (!text ||
    `${entry.draft.title} ${entry.draft.artist} ${entry.path}`.toLocaleLowerCase().includes(text))
    && (language === 'all' || entry.draft.language === language)
    && (status === 'all' || status === 'saved' && entry.status === 'saved'
      || status === 'error' && entry.status === 'error'
      || status === 'duplicate' && entry.status !== 'saved' && !entry.skip
        && (entry.reviewStale || entry.matches.length && !entry.allowDuplicate)
      || status === 'pending' && entry.status !== 'saved' && entry.status !== 'error' && !entry.skip
        && !entry.reviewStale && (!entry.matches.length || entry.allowDuplicate)));
}
