export function orderedLyricSources({ sources = [], order = [] } = {}) {
  const available = new Map(sources.filter(source => source?.enabled !== false && typeof source?.id === 'string')
    .map(source => [source.id, source]));
  const ids = [...new Set([...order, ...available.keys()])];
  return ids.filter(id => available.has(id)).map(id => available.get(id));
}

export function moveLyricSource(order, id, direction) {
  const index = order.indexOf(id), target = index + direction;
  if (index < 0 || target < 0 || target >= order.length || ![-1, 1].includes(direction)) return order;
  const next = [...order];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
