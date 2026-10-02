import packageMetadata from '../../../package.json' with { type: 'json' };

const escape = (value) => String(value).replace(/[&<>"']/g,
  (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
// Literal attribute whitespace is normalized by XML parsers; entities preserve byte offsets.
const escapeAttribute = (value) => escape(value).replace(/[\t\n\r]/g,
  (char) => ({ '\t': '&#9;', '\n': '&#10;', '\r': '&#13;' })[char]);
const attributes = (value) => Object.entries(value).filter(([, v]) => v != null)
  .map(([key, v]) => ` ${key}="${escapeAttribute(v)}"`).join('');

function element(name, value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map((item) => element(name, item)).join('');
  if (typeof value !== 'object') return `<${name}>${escape(value)}</${name}>`;
  const attrs = {};
  let children = '';
  for (const [key, item] of Object.entries(value)) {
    // line/cue/lyrics use text nodes. OpenSubsonic v2 cueLine.value is an attribute.
    if (key === 'value' && name !== 'cueLine') children += escape(item);
    else if (item !== null && typeof item === 'object') children += element(key, item);
    else if (item != null) attrs[key] = item;
  }
  return `<${name}${attributes(attrs)}>${children}</${name}>`;
}

export function reply(payload = {}, format = 'xml', error = null, httpStatus = 200) {
  const base = { status: error ? 'failed' : 'ok', version: '1.16.1', type: 'FlareTune',
    serverVersion: packageMetadata.version, openSubsonic: true };
  const body = error ? { error } : payload;
  const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'Content-Type': format === 'json'
      ? 'application/json; charset=utf-8' : 'application/xml; charset=utf-8' };
  let contents = Object.entries(body).map(([key, value]) => element(key, value)).join('');
  if (body.openSubsonicExtensions) contents = '<openSubsonicExtensions>'
    + body.openSubsonicExtensions.map((extension) => `<openSubsonicExtension name="${escape(extension.name)}">`
      + extension.versions.map((version) => element('version', version)).join('') + '</openSubsonicExtension>').join('')
    + '</openSubsonicExtensions>';
  return new Response(format === 'json' ? JSON.stringify({ 'subsonic-response': { ...base, ...body } })
    : `<?xml version="1.0" encoding="UTF-8"?><subsonic-response xmlns="http://subsonic.org/restapi"${attributes(base)}>${contents}</subsonic-response>`,
  { status: httpStatus, headers });
}

export class ProtocolError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export const reject = (code, message) => { throw new ProtocolError(code, message); };
export function integer(params, key, fallback, maximum = 500) {
  const raw = params.get(key);
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > maximum) {
    reject(10, `Invalid ${key}`);
  }
  return Number(raw);
}
export function required(params, key) {
  const value = params.get(key);
  if (!value || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) reject(10, `Missing or invalid ${key}`);
  return value;
}
