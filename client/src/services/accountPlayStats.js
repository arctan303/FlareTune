import { getApiBaseUrl } from './apiBase.js';
import { requestAccountJson } from './accountApiRequest.js';

export class AccountPlayStatsRequestError extends Error {
  constructor(message, { status = 0, code = 'REQUEST_FAILED', data } = {}) {
    super(message || code);
    this.name = 'AccountPlayStatsRequestError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export async function fetchAccountPlayStats({
  limit = 20,
  summaryOnly = false,
  expectedSubject,
  fetchImpl = globalThis.fetch,
  apiBase,
} = {}) {
  const base = typeof apiBase === 'string' ? apiBase.replace(/\/$/, '') : getApiBaseUrl();
  return requestAccountJson({
    fetchImpl,
    base,
    path: `/api/account/play-stats?limit=${encodeURIComponent(limit)}${summaryOnly ? '&view=summary' : ''}`,
    init: {
      method: 'GET',
      headers: expectedSubject ? { 'X-FlareTune-Expected-Account': expectedSubject } : {},
    },
    ErrorType: AccountPlayStatsRequestError,
    errorLabel: '获取播放统计失败',
  });
}

export async function submitAccountPlayStats(events, {
  expectedSubject,
  fetchImpl = globalThis.fetch,
  apiBase,
  keepalive = false,
} = {}) {
  if (!Array.isArray(events) || events.length === 0) return { recorded: 0, acceptedEventIds: [] };
  const base = typeof apiBase === 'string' ? apiBase.replace(/\/$/, '') : getApiBaseUrl();
  return requestAccountJson({
    fetchImpl,
    base,
    path: '/api/account/play-stats',
    init: {
      method: 'POST',
      body: JSON.stringify({ events }),
      keepalive,
      headers: expectedSubject ? { 'X-FlareTune-Expected-Account': expectedSubject } : {},
    },
    ErrorType: AccountPlayStatsRequestError,
    errorLabel: '提交播放统计失败',
  });
}
