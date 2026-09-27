import { notifyAuthenticationRequired } from '../authNavigation.js';

export async function authenticatedFetch(input, init, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(input, init);
  return notifyAuthenticationRequired(response);
}
