import { LYRIC_DOCUMENT_LIMITS, createLyricDocument, isSingableLineText } from '../utils/lyricDocument.js';
import { isValidSongLanguage } from '../utils/songLanguage.js';
import { mediaObjectKey, mediaPrefix } from './adminMusicMedia.js';
import { createRequestSingleFlight } from '../utils/sharedRequestTask.js';

export const LYRIC_ARTIFACT_SCHEMA_VERSION = 1;
export const MAX_LYRIC_ARTIFACT_BYTES = 4 * 1024 * 1024;

const READY_FIELDS = Object.freeze([
  'schemaVersion',
  'songId',
  'status',
  'original',
  'translation',
  'aiCompletion',
  'offsetMs',
  'textHash',
  'provenance',
  'updatedAt',
]);
const NOT_FOUND_FIELDS = Object.freeze(['schemaVersion', 'songId', 'status', 'updatedAt']);
const RESET_MARKER_FIELDS = Object.freeze(['schemaVersion', 'songId', 'status', 'updatedAt']);
const DELETING_MARKER_FIELDS = Object.freeze(['schemaVersion', 'songId', 'status', 'operationId', 'updatedAt']);
const ORIGINAL_FIELDS = Object.freeze(['source', 'format', 'syncMode', 'lines']);
const TRANSLATION_FIELDS = Object.freeze(['source', 'originalTextHash', 'lines', 'updatedAt', 'language']);
const AI_COMPLETION_FIELDS = Object.freeze(['status', 'errorCode', 'candidateIndices', 'reviewAccountId', 'processingKey', 'updatedAt']);
const PROVENANCE_FIELDS = Object.freeze([
  'providerLyricId',
  'matchedTitle',
  'matchedArtist',
  'matchedDuration',
]);
const LINE_FIELDS = Object.freeze(['time', 'endTime', 'text', 'words']);
const WORD_FIELDS = Object.freeze(['text', 'startTime', 'endTime']);
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9_]{0,63}$/;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

export class LyricArtifactValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LyricArtifactValidationError';
    this.code = 'invalid_lyric_artifact';
  }
}

export class LyricArtifactStoreError extends Error {
  constructor(code, operation, message, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'LyricArtifactStoreError';
    this.code = code;
    this.operation = operation;
  }
}

const validationError = (message) => {
  throw new LyricArtifactValidationError(message);
};

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactFields(value, fields) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === fields.length && keys.every((field) => fields.includes(field));
}

function isLegacyLyricPayload(value) {
  if (!hasExactFields(value, ['success', 'data']) || typeof value.success !== 'boolean') return false;
  if (!hasExactFields(value.data, ['source', 'type', 'lyrics', 'translated_lyrics'])) return false;
  const { source, type, lyrics, translated_lyrics: translatedLyrics } = value.data;
  if (![source, type, lyrics, translatedLyrics].every((field) => typeof field === 'string')) return false;
  if (!['plain', 'synced'].includes(type)) return false;
  if (value.success) {
    return ['Netease', 'LRCLib'].includes(source) && Boolean(lyrics.trim());
  }
  return source === '' && type === 'plain' && lyrics === '' && translatedLyrics === '';
}

function validateLegacyLyricText(value, maxBytes) {
  if (typeof value !== 'string') validationError('legacy lyric artifact must be serialized JSON text');
  if (new TextEncoder().encode(value).byteLength > maxBytes) {
    validationError(`legacy lyric artifact exceeds ${maxBytes} byte limit`);
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    validationError('legacy lyric artifact must be valid JSON');
  }
  if (!isLegacyLyricPayload(parsed)) validationError('legacy lyric artifact does not match the known schema');
  return value;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) validationError(`${label} must be a plain object`);
}

function assertExactFields(value, allowed, required, label) {
  assertPlainObject(value, label);
  const unknown = Object.keys(value).filter((field) => !allowed.includes(field));
  if (unknown.length > 0) validationError(`${label} contains unknown fields: ${unknown.join(', ')}`);
  const missing = required.filter((field) => !Object.prototype.hasOwnProperty.call(value, field));
  if (missing.length > 0) validationError(`${label} is missing fields: ${missing.join(', ')}`);
}

export function normalizeLyricArtifactSongId(value) {
  if (typeof value !== 'string'
    || !value
    || value !== value.trim()
    || value.length > 128
    || value === '.'
    || value === '..'
    || /[\\/]/u.test(value)
    || CONTROL_CHARACTER_PATTERN.test(value)) {
    validationError('songId must be a non-empty path-safe string of at most 128 characters');
  }
  return value;
}

function normalizeIsoTimestamp(value, label) {
  if (typeof value !== 'string' || !value) validationError(`${label} must be an ISO-8601 timestamp`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) validationError(`${label} must be an ISO-8601 timestamp`);
  return date.toISOString();
}

function normalizeHash(value, label) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    validationError(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function normalizePublicMetadataText(value, maximumLength, label) {
  if (typeof value !== 'string'
    || !value
    || value.length > maximumLength
    || CONTROL_CHARACTER_PATTERN.test(value)) {
    validationError(`${label} must be a non-empty public string of at most ${maximumLength} characters`);
  }
  return value;
}

function normalizeOriginalLine(value, index) {
  const label = `original.lines[${index}]`;
  assertExactFields(value, LINE_FIELDS, ['text'], label);
  const line = { text: value.text };
  if (Object.prototype.hasOwnProperty.call(value, 'time')) line.time = value.time;
  if (Object.prototype.hasOwnProperty.call(value, 'endTime')) line.endTime = value.endTime;
  if (Object.prototype.hasOwnProperty.call(value, 'words')) {
    if (!Array.isArray(value.words)) validationError(`${label}.words must be an array`);
    line.words = value.words.map((word, wordIndex) => {
      const wordLabel = `${label}.words[${wordIndex}]`;
      assertExactFields(word, WORD_FIELDS, WORD_FIELDS, wordLabel);
      return { text: word.text, startTime: word.startTime, endTime: word.endTime };
    });
  }
  return line;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

const sameJsonValue = (left, right) => (
  JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right))
);

function normalizeOriginal(value) {
  assertExactFields(value, ORIGINAL_FIELDS, ORIGINAL_FIELDS, 'original');
  if (!Array.isArray(value.lines) || value.lines.length === 0) {
    validationError('original.lines must contain lyrics');
  }
  if (value.lines.length > LYRIC_DOCUMENT_LIMITS.maxLines) {
    validationError('original.lines exceeds safe line count');
  }
  const lines = value.lines.map(normalizeOriginalLine);
  let document;
  try {
    document = createLyricDocument({
      source: value.source,
      format: value.format,
      lines,
    });
  } catch (error) {
    validationError(error instanceof Error ? error.message : String(error));
  }
  if (!document.lines.some((line) => isSingableLineText(line.text))) {
    validationError('original.lines must contain at least one singable lyric line');
  }
  const normalized = {
    source: document.source,
    format: document.format,
    syncMode: document.syncMode,
    lines: document.lines,
  };
  if (!sameJsonValue(value, normalized)) {
    validationError('original must use the canonical lyric line and word structure');
  }
  return normalized;
}

function normalizeTranslation(value, original, textHash) {
  if (value === null) return null;
  assertExactFields(value, TRANSLATION_FIELDS,
    ['source', 'originalTextHash', 'lines', 'updatedAt'], 'translation');
  if (!['kugou', 'netease', 'ai', 'manual'].includes(value.source)) {
    validationError('translation.source must be kugou, netease, ai, or manual');
  }
  const originalTextHash = normalizeHash(value.originalTextHash, 'translation.originalTextHash');
  if (originalTextHash !== textHash) validationError('translation.originalTextHash must match textHash');
  if (!Array.isArray(value.lines) || value.lines.length !== original.lines.length) {
    validationError('translation.lines must align one-to-one with original.lines');
  }
  const lines = value.lines.map((line, index) => {
    if (typeof line !== 'string'
      || line.length > LYRIC_DOCUMENT_LIMITS.maxLineTextLength
      || /[\r\n]/u.test(line)) {
      validationError(`translation.lines[${index}] must be a single-line string within the safe length`);
    }
    return line;
  });
  if (!lines.some((line) => line.trim())) validationError('translation.lines must contain translated text');
  if (value.language !== undefined && (!isValidSongLanguage(value.language)
    || ['instrumental', 'other'].includes(value.language))) {
    validationError('translation.language must be a supported spoken language');
  }
  return {
    source: value.source,
    originalTextHash,
    lines,
    updatedAt: normalizeIsoTimestamp(value.updatedAt, 'translation.updatedAt'),
    ...(value.language ? { language: value.language } : {}),
  };
}

function normalizeAiCompletion(value, lineCount) {
  if (value === null) return null;
  assertExactFields(value, AI_COMPLETION_FIELDS, ['status', 'updatedAt'], 'aiCompletion');
  if (!['pending', 'failed', 'review', 'completed'].includes(value.status)) {
    validationError('aiCompletion.status must be pending, failed, review, or completed');
  }
  const hasErrorCode = Object.prototype.hasOwnProperty.call(value, 'errorCode');
  if (value.status !== 'failed' && hasErrorCode) {
    validationError('only failed aiCompletion may contain errorCode');
  }
  if (value.status === 'failed'
    && (!hasErrorCode || typeof value.errorCode !== 'string' || !ERROR_CODE_PATTERN.test(value.errorCode))) {
    validationError('failed aiCompletion requires a safe errorCode');
  }
  const hasCandidates = Object.prototype.hasOwnProperty.call(value, 'candidateIndices');
  const hasReviewer = Object.prototype.hasOwnProperty.call(value, 'reviewAccountId');
  const hasProcessingKey = Object.prototype.hasOwnProperty.call(value, 'processingKey');
  if (value.status === 'completed') {
    if (hasProcessingKey && (typeof value.processingKey !== 'string'
      || !/^[a-z]{2,5}(?:(?:\|[01]){4}|(?:\|[01]){6})$/u.test(value.processingKey))) {
      validationError('completed aiCompletion has an invalid processingKey');
    }
  } else if (hasProcessingKey) validationError('processingKey requires completed aiCompletion');
  if (value.status === 'review') {
    if (!hasCandidates || !hasReviewer || typeof value.reviewAccountId !== 'string'
      || value.reviewAccountId.length < 1 || value.reviewAccountId.length > 128
      || CONTROL_CHARACTER_PATTERN.test(value.reviewAccountId)
      || !Array.isArray(value.candidateIndices)
      || value.candidateIndices.length === 0 || value.candidateIndices.length > lineCount
      || new Set(value.candidateIndices).size !== value.candidateIndices.length
      || value.candidateIndices.some((index) => !Number.isInteger(index) || index < 0 || index >= lineCount)) {
      validationError('review aiCompletion requires valid candidateIndices');
    }
  } else if (hasCandidates || hasReviewer) validationError('review fields require review aiCompletion');
  return {
    status: value.status,
    ...(hasErrorCode ? { errorCode: value.errorCode } : {}),
    ...(hasCandidates ? { candidateIndices: [...value.candidateIndices].sort((a, b) => a - b) } : {}),
    ...(hasReviewer ? { reviewAccountId: value.reviewAccountId } : {}),
    ...(hasProcessingKey ? { processingKey: value.processingKey } : {}),
    updatedAt: normalizeIsoTimestamp(value.updatedAt, 'aiCompletion.updatedAt'),
  };
}

function normalizeProvenance(value) {
  assertExactFields(value, PROVENANCE_FIELDS, [], 'provenance');
  const normalized = {};
  if (Object.prototype.hasOwnProperty.call(value, 'providerLyricId')) {
    if (typeof value.providerLyricId !== 'string' || !PROVIDER_ID_PATTERN.test(value.providerLyricId)) {
      validationError('provenance.providerLyricId must be a safe public provider id');
    }
    normalized.providerLyricId = value.providerLyricId;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'matchedTitle')) {
    normalized.matchedTitle = normalizePublicMetadataText(value.matchedTitle, 1_000, 'provenance.matchedTitle');
  }
  if (Object.prototype.hasOwnProperty.call(value, 'matchedArtist')) {
    normalized.matchedArtist = normalizePublicMetadataText(value.matchedArtist, 1_000, 'provenance.matchedArtist');
  }
  if (Object.prototype.hasOwnProperty.call(value, 'matchedDuration')) {
    if (typeof value.matchedDuration !== 'number'
      || !Number.isFinite(value.matchedDuration)
      || value.matchedDuration < 0
      || value.matchedDuration > LYRIC_DOCUMENT_LIMITS.maxTimeSeconds) {
      validationError('provenance.matchedDuration must be a safe non-negative duration');
    }
    normalized.matchedDuration = value.matchedDuration;
  }
  return normalized;
}

function normalizeReadyArtifact(value, expectedSongId) {
  assertExactFields(value, READY_FIELDS, READY_FIELDS, 'lyric artifact');
  const songId = normalizeLyricArtifactSongId(value.songId);
  if (expectedSongId !== undefined && songId !== expectedSongId) {
    validationError('lyric artifact songId does not match its object key');
  }
  if (value.schemaVersion !== LYRIC_ARTIFACT_SCHEMA_VERSION) {
    validationError(`schemaVersion must be ${LYRIC_ARTIFACT_SCHEMA_VERSION}`);
  }
  if (value.status !== 'ready') validationError('ready lyric artifact has an invalid status');
  const original = normalizeOriginal(value.original);
  const textHash = normalizeHash(value.textHash, 'textHash');
  if (!Number.isInteger(value.offsetMs) || value.offsetMs < -5_000 || value.offsetMs > 5_000) {
    validationError('offsetMs must be an integer between -5000 and 5000');
  }
  return {
    schemaVersion: LYRIC_ARTIFACT_SCHEMA_VERSION,
    songId,
    status: 'ready',
    original,
    translation: normalizeTranslation(value.translation, original, textHash),
    aiCompletion: normalizeAiCompletion(value.aiCompletion, original.lines.length),
    offsetMs: value.offsetMs,
    textHash,
    provenance: normalizeProvenance(value.provenance),
    updatedAt: normalizeIsoTimestamp(value.updatedAt, 'updatedAt'),
  };
}

function normalizeNotFoundArtifact(value, expectedSongId) {
  assertExactFields(value, NOT_FOUND_FIELDS, NOT_FOUND_FIELDS, 'lyric artifact');
  const songId = normalizeLyricArtifactSongId(value.songId);
  if (expectedSongId !== undefined && songId !== expectedSongId) {
    validationError('lyric artifact songId does not match its object key');
  }
  if (value.schemaVersion !== LYRIC_ARTIFACT_SCHEMA_VERSION) {
    validationError(`schemaVersion must be ${LYRIC_ARTIFACT_SCHEMA_VERSION}`);
  }
  if (value.status !== 'not_found') validationError('not-found lyric artifact has an invalid status');
  return {
    schemaVersion: LYRIC_ARTIFACT_SCHEMA_VERSION,
    songId,
    status: 'not_found',
    updatedAt: normalizeIsoTimestamp(value.updatedAt, 'updatedAt'),
  };
}

function normalizeLifecycleMarker(value, expectedSongId) {
  const deleting = value.status === 'deleting';
  if (!deleting && value.status !== 'reset') {
    validationError('lyric artifact status must be ready, not_found, reset, or deleting');
  }
  const fields = deleting ? DELETING_MARKER_FIELDS : RESET_MARKER_FIELDS;
  assertExactFields(value, fields, fields, 'lyric artifact marker');
  const songId = normalizeLyricArtifactSongId(value.songId);
  if (expectedSongId !== undefined && songId !== expectedSongId) {
    validationError('lyric artifact songId does not match its object key');
  }
  if (value.schemaVersion !== LYRIC_ARTIFACT_SCHEMA_VERSION) {
    validationError(`schemaVersion must be ${LYRIC_ARTIFACT_SCHEMA_VERSION}`);
  }
  if (deleting && (typeof value.operationId !== 'string' || !OPERATION_ID_PATTERN.test(value.operationId))) {
    validationError('deleting marker operationId must be a safe non-empty token of at most 128 characters');
  }
  return {
    schemaVersion: LYRIC_ARTIFACT_SCHEMA_VERSION,
    songId,
    status: value.status,
    ...(deleting ? { operationId: value.operationId } : {}),
    updatedAt: normalizeIsoTimestamp(value.updatedAt, 'updatedAt'),
  };
}

export function buildLyricArtifactMarker(songId, status, {
  now = Date.now(),
  operationId,
} = {}) {
  const updatedAt = new Date(now).toISOString();
  return normalizeLifecycleMarker({
    schemaVersion: LYRIC_ARTIFACT_SCHEMA_VERSION,
    songId,
    status,
    ...(status === 'deleting' ? { operationId } : {}),
    updatedAt,
  }, songId);
}

function serializeArtifact(value, { expectedSongId, maxBytes }) {
  assertPlainObject(value, 'lyric artifact');
  const artifact = value.status === 'ready'
    ? normalizeReadyArtifact(value, expectedSongId)
    : value.status === 'not_found'
      ? normalizeNotFoundArtifact(value, expectedSongId)
      : normalizeLifecycleMarker(value, expectedSongId);
  const json = JSON.stringify(artifact);
  const byteLength = new TextEncoder().encode(json).byteLength;
  if (byteLength > maxBytes) validationError(`lyric artifact exceeds ${maxBytes} byte limit`);
  return { artifact, json, byteLength };
}

export function validateLyricArtifact(value, {
  expectedSongId,
  maxBytes = MAX_LYRIC_ARTIFACT_BYTES,
} = {}) {
  try {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('maxBytes must be a positive safe integer');
    const result = serializeArtifact(value, { expectedSongId, maxBytes });
    return { valid: true, artifact: result.artifact, byteLength: result.byteLength, errors: [] };
  } catch (error) {
    if (!(error instanceof LyricArtifactValidationError)) throw error;
    return { valid: false, artifact: null, byteLength: null, errors: [error.message] };
  }
}

function etagFromObject(value) {
  const candidate = typeof value?.etag === 'string' && value.etag
    ? value.etag
    : value?.httpEtag;
  if (typeof candidate !== 'string' || !candidate) return null;
  const unquoted = candidate.startsWith('"') && candidate.endsWith('"')
    ? candidate.slice(1, -1)
    : candidate;
  return unquoted && unquoted.length <= 256 && !CONTROL_CHARACTER_PATTERN.test(unquoted)
    ? unquoted
    : null;
}

function isPreconditionFailure(error) {
  return error?.status === 412 || error?.statusCode === 412 || error?.code === 412 || error?.code === 'PRECONDITION_FAILED';
}

function storeFailure(code, operation, message, cause) {
  return new LyricArtifactStoreError(code, operation, message, { cause });
}

// Private object metadata is not part of the portable lyric JSON. Restores and
// ordinary management writes deliberately do not grant automatic replacement.
function automaticMetadata(value) {
  const checkedAt = value?.checkedAt;
  return typeof checkedAt === 'string' && Number.isFinite(Date.parse(checkedAt))
    ? { checkedAt: new Date(checkedAt).toISOString() } : null;
}

export function createLyricArtifactStore(env, { maxBytes = MAX_LYRIC_ARTIFACT_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('maxBytes must be a positive safe integer');
  if (!env?.MEDIA_BUCKET) {
    throw storeFailure('r2_unavailable', 'configure', 'MEDIA_BUCKET is not bound');
  }
  const prefix = mediaPrefix(env);
  if (!prefix) throw storeFailure('r2_unavailable', 'configure', 'MEDIA_PREFIX is invalid');

  const bucket = env.MEDIA_BUCKET;
  const sharedTask = createRequestSingleFlight();
  const key = (songId) => mediaObjectKey(prefix, `lyrics/${normalizeLyricArtifactSongId(songId)}.json`);

  const get = async (songId) => {
    const normalizedSongId = normalizeLyricArtifactSongId(songId);
    const objectKey = key(normalizedSongId);
    let object;
    try {
      object = await bucket.get(objectKey);
    } catch (error) {
      throw storeFailure('r2_read_failed', 'get', 'Failed to read lyric artifact from R2', error);
    }
    if (object === null || object === undefined) {
      return { state: 'missing', key: objectKey, artifact: null, etag: null };
    }
    const declaredSize = Number(object.size);
    if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
      throw storeFailure('invalid_stored_artifact', 'get', 'Stored lyric artifact exceeds the safe size limit');
    }
    if (typeof object.text !== 'function') {
      throw storeFailure('invalid_stored_artifact', 'get', 'Stored lyric artifact body is unreadable');
    }
    let text;
    try {
      text = await object.text();
    } catch (error) {
      throw storeFailure('r2_read_failed', 'get', 'Failed to read lyric artifact body from R2', error);
    }
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw storeFailure('invalid_stored_artifact', 'get', 'Stored lyric artifact exceeds the safe size limit');
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw storeFailure('invalid_stored_artifact', 'get', 'Stored lyric artifact is not valid JSON', error);
    }
    const etag = etagFromObject(object);
    const validated = validateLyricArtifact(parsed, { expectedSongId: normalizedSongId, maxBytes });
    if (!validated.valid) {
      if (etag && isLegacyLyricPayload(parsed)) {
        return {
          state: 'legacy',
          key: objectKey,
          artifact: null,
          etag,
          legacyText: text,
        };
      }
      throw storeFailure('invalid_stored_artifact', 'get', validated.errors[0]);
    }
    if (!etag) throw storeFailure('invalid_stored_artifact', 'get', 'Stored lyric artifact has no valid ETag');
    const automation = object.customMetadata?.lyricManagement === 'automatic-v1'
      ? automaticMetadata({ checkedAt: object.customMetadata.lyricCheckedAt }) : null;
    return { state: 'found', key: objectKey, artifact: validated.artifact, etag,
      ...(automation ? { automation } : {}) };
  };

  const conditionalPut = async (songId, artifact, onlyIf, successState, options = {}) => {
    const normalizedSongId = normalizeLyricArtifactSongId(songId);
    const objectKey = key(normalizedSongId);
    let serialized;
    try {
      serialized = serializeArtifact(artifact, { expectedSongId: normalizedSongId, maxBytes });
    } catch (error) {
      if (error instanceof LyricArtifactValidationError) throw error;
      throw storeFailure('invalid_lyric_artifact', 'put', 'Failed to serialize lyric artifact', error);
    }
    const automation = artifact.status === 'ready' && artifact.original?.source !== 'manual'
      && artifact.offsetMs === 0 ? automaticMetadata(options.automation) : null;
    let result;
    try {
      result = await bucket.put(objectKey, serialized.json, {
        onlyIf,
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
        ...(automation ? { customMetadata: {
          lyricManagement: 'automatic-v1', lyricCheckedAt: automation.checkedAt,
        } } : {}),
      });
    } catch (error) {
      if (isPreconditionFailure(error)) {
        return { state: 'conflict', key: objectKey, artifact: null, etag: null };
      }
      throw storeFailure('r2_write_failed', 'put', 'Failed to write lyric artifact to R2', error);
    }
    if (result === null || result === undefined) {
      return { state: 'conflict', key: objectKey, artifact: null, etag: null };
    }
    const etag = etagFromObject(result);
    if (!etag) throw storeFailure('r2_write_failed', 'put', 'R2 write returned no valid ETag');
    return { state: successState, key: objectKey, artifact: serialized.artifact, etag,
      ...(automation ? { automation } : {}) };
  };

  const createIfAbsent = (songId, artifact, options) => (
    conditionalPut(songId, artifact, { etagDoesNotMatch: '*' }, 'created', options)
  );

  const putIfMatch = (songId, artifact, etag, options) => {
    const normalizedEtag = etagFromObject({ etag });
    if (!normalizedEtag) validationError('etag must be a non-empty safe R2 ETag');
    return conditionalPut(songId, artifact, { etagMatches: normalizedEtag }, 'updated', options);
  };

  const restoreLegacyIfMatch = async (songId, legacyText, etag) => {
    const normalizedSongId = normalizeLyricArtifactSongId(songId);
    const objectKey = key(normalizedSongId);
    const normalizedEtag = etagFromObject({ etag });
    if (!normalizedEtag) validationError('etag must be a non-empty safe R2 ETag');
    const validatedText = validateLegacyLyricText(legacyText, maxBytes);
    let result;
    try {
      result = await bucket.put(objectKey, validatedText, {
        onlyIf: { etagMatches: normalizedEtag },
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
      });
    } catch (error) {
      if (isPreconditionFailure(error)) {
        return { state: 'conflict', key: objectKey, artifact: null, etag: null };
      }
      throw storeFailure('r2_write_failed', 'put', 'Failed to restore legacy lyric artifact to R2', error);
    }
    if (result === null || result === undefined) {
      return { state: 'conflict', key: objectKey, artifact: null, etag: null };
    }
    const restoredEtag = etagFromObject(result);
    if (!restoredEtag) throw storeFailure('r2_write_failed', 'put', 'R2 write returned no valid ETag');
    return { state: 'updated', key: objectKey, artifact: null, etag: restoredEtag };
  };

  const remove = async (songId) => {
    const objectKey = key(songId);
    try {
      await bucket.delete(objectKey);
    } catch (error) {
      throw storeFailure('r2_delete_failed', 'delete', 'Failed to delete lyric artifact from R2', error);
    }
    return { state: 'deleted', key: objectKey };
  };

  const singleflight = (songId, task, options) => {
    const normalizedSongId = normalizeLyricArtifactSongId(songId);
    if (typeof task !== 'function') throw new TypeError('singleflight task must be a function');
    return sharedTask(normalizedSongId, task, options);
  };

  return Object.freeze({
    key,
    get,
    createIfAbsent,
    putIfMatch,
    restoreLegacyIfMatch,
    delete: remove,
    singleflight,
  });
}
