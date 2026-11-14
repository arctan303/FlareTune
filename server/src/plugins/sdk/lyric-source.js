// Optional hostApiVersion 2 capability. Implementations retain their own
// policy; the host validates identity, installation and result ownership.
export function defineLyricSource({ id, claim, resolve, translate, ...options }) {
  if (!/^[a-z][a-z0-9-]{0,79}$/u.test(id || '') || typeof claim !== 'function' || typeof resolve !== 'function'
    || translate !== undefined && typeof translate !== 'function') throw new TypeError('Invalid lyric source');
  return Object.freeze({ ...options, id, claim, resolve, ...(translate ? { translate } : {}) });
}
