export function createLatestRequest() {
  let generation = 0;
  return {
    begin() {
      const request = ++generation;
      return () => request === generation;
    },
    invalidate() { generation += 1; },
  };
}
