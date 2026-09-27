import { getApiBaseUrl } from './apiBase.js';
import { authenticatedFetch } from './authenticatedFetch.js';

const normalizeThought = (value) => (
  typeof value === 'string' && value ? value : undefined
);

export function normalizeCloudThreadMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map((message, index) => ({
    id: message?.id || `cloud-${message?.createdAt || index}`,
    role: message?.role,
    content: typeof message?.content === 'string' ? message.content : '',
    createdAt: Number.isFinite(Number(message?.createdAt)) ? Number(message.createdAt) : undefined,
    thought: normalizeThought(message?.thought),
  }));
}

export function normalizeCloudThread(thread) {
  return {
    revision: Number(thread?.revision || 0),
    messages: normalizeCloudThreadMessages(thread?.messages),
  };
}

const fingerprintNormalizedThread = (thread) => JSON.stringify({
  revision: thread.revision,
  messages: thread.messages,
});

export class AiThreadRequestError extends Error {
  constructor(message, { status = 0, data } = {}) {
    super(message);
    this.name = 'AiThreadRequestError';
    this.status = status;
    this.data = data;
  }
}

export async function fetchCloudThread({
  fetchImpl = globalThis.fetch,
  apiBase = getApiBaseUrl(),
  signal,
} = {}) {
  const response = await authenticatedFetch(`${apiBase}/api/ai/thread`, {
    method: 'GET',
    credentials: 'include',
    headers: { Accept: 'application/json' },
    signal,
  }, fetchImpl);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new AiThreadRequestError(`云端线程响应异常 (${response.status})`, {
      status: response.status,
      data,
    });
  }
  const data = await response.json();
  const thread = normalizeCloudThread(data?.thread);
  return {
    thread,
    fingerprint: fingerprintNormalizedThread(thread),
  };
}

const comparableMessage = (message) => ({
  id: message?.id,
  role: message?.role,
  content: typeof message?.content === 'string' ? message.content : '',
  createdAt: Number.isFinite(Number(message?.createdAt)) ? Number(message.createdAt) : undefined,
  thought: normalizeThought(message?.thought),
});

const messagesMatch = (left, right) => (
  JSON.stringify(comparableMessage(left)) === JSON.stringify(comparableMessage(right))
);

export function planCloudThreadSync({
  thread,
  currentMessages,
  previousFingerprint = '',
}) {
  const current = Array.isArray(currentMessages) ? currentMessages : [];
  const normalizedThread = normalizeCloudThread(thread);
  const remote = normalizedThread.messages;
  const fingerprint = fingerprintNormalizedThread(normalizedThread);
  const hasCurrent = current.length > 0;

  if (fingerprint === previousFingerprint && hasCurrent) {
    return { kind: 'unchanged', fingerprint, messages: current };
  }
  if (remote.length === 0) {
    return { kind: 'empty', fingerprint, messages: [] };
  }

  const canAppend = hasCurrent
    && remote.length > current.length
    && remote.slice(0, current.length).every((message, index) => messagesMatch(message, current[index]));

  return {
    kind: canAppend ? 'append' : 'replace',
    fingerprint,
    messages: canAppend ? [...current, ...remote.slice(current.length)] : remote,
  };
}
