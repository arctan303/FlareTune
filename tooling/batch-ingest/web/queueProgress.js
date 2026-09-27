export function beginProgress(entries) {
  return { total: entries.reduce((sum, entry) => sum + entry.file.size + (entry.coverFile?.size || 0), 0),
    loaded: new Map() };
}

export function updateProgress(progress, entry, current) {
  const itemTotal = entry.file.size + (entry.coverFile?.size || 0);
  const loaded = Math.min(itemTotal, (entry.progressBase || 0) + current);
  progress.loaded.set(entry.identity, Math.max(loaded, progress.loaded.get(entry.identity) || 0));
  const sum = [...progress.loaded.values()].reduce((count, value) => count + value, 0);
  return { item: Math.round(loaded / itemTotal * 100),
    batch: progress.total ? Math.round(sum / progress.total * 100) : 0 };
}
