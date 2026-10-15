// The static Demo replaces this module at build time. Normal instances always
// use the native network transport and retain all server authentication gates.
export const runtimeFetch = (...args) => globalThis.fetch(...args);
