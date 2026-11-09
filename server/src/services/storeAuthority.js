// Composed stores move the authority gate past asynchronous preparation, so
// revocation is checked immediately before the actual I/O as well as after it.
export const storeAuthorityGuard = Symbol('storeAuthorityGuard');
const guardedAssertions = Symbol('storeAuthorityAssertions');
export function guardStoreAuthority(store, assertCurrent) {
  if (store[storeAuthorityGuard]) return store[storeAuthorityGuard](assertCurrent);
  if (store[guardedAssertions]?.has(assertCurrent)) return store;
  const guarded = Object.fromEntries(Object.entries(store).map(([key, value]) => [key,
    typeof value !== 'function' || key === 'key' ? value : async (...args) => {
      await assertCurrent();
      const result = await value.apply(store, args);
      await assertCurrent();
      return result;
    }]));
  Object.defineProperty(guarded, guardedAssertions, { value: new Set([...(store[guardedAssertions] || []), assertCurrent]) });
  return Object.freeze(guarded);
}
