const guards = new Set();
export function registerPluginLeaveGuard(guard) {
  guards.add(guard);
  return () => guards.delete(guard);
}
export function approvePluginNavigation(destination) {
  for (const guard of [...guards]) if (guard(destination) === false) return false;
  return true;
}
