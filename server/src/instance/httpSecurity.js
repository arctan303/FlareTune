export const AUTH_REQUEST_HEADER = 'X-Requested-With';
export const AUTH_REQUEST_VALUE = 'FlareTune';

export class RequestBodyError extends Error {
  constructor(code) {
    super(code);
    this.name = 'RequestBodyError';
    this.code = code;
  }
}

export function isTrustedMutationRequest(request, allowedOrigins = []) {
  const origin = request.headers.get('Origin');
  return (origin === new URL(request.url).origin || allowedOrigins.includes(origin))
    && request.headers.get(AUTH_REQUEST_HEADER) === AUTH_REQUEST_VALUE;
}

export function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const item of header.split(';')) {
    const [key, ...rest] = item.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

export async function readBoundedJson(request, maxBytes = 8192) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get('Content-Type') || '')) {
    throw new RequestBodyError('invalid_content_type');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new RequestBodyError('invalid_body');
  let length = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new RequestBodyError('body_too_large');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new RequestBodyError('invalid_json');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RequestBodyError('invalid_json');
  return value;
}
