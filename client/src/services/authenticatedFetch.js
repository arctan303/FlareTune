import { runtimeFetch } from './runtimeFetch.js';
import { notifyAuthenticationRequired } from '../authNavigation.js';

export async function authenticatedFetch(input, init, fetchImpl = runtimeFetch) {
  const response = await fetchImpl(input, init);
  return notifyAuthenticationRequired(response);
}
