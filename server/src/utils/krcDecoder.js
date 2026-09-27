const KRC_XOR_KEY = Uint8Array.from([
  64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105,
]);

export class KrcDecodeError extends Error {
  constructor(stage, message, options = {}) {
    super(message, options);
    this.name = 'KrcDecodeError';
    this.stage = stage;
  }
}

function decodeBase64(encodedContent, maximumCompressedBytes) {
  let binary;
  try {
    binary = atob(encodedContent);
  } catch (error) {
    throw new KrcDecodeError('download-krc', 'Kugou download-krc returned invalid base64', { cause: error });
  }
  if (binary.length > maximumCompressedBytes) {
    throw new KrcDecodeError('download-krc', 'Kugou download-krc content exceeds safe size');
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function decompressDeflate(bytes, maximumDecompressedBytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumDecompressedBytes) {
      await reader.cancel('decompressed lyrics exceed safe size');
      throw new RangeError('decompressed lyrics exceed safe size');
    }
    chunks.push(value);
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function decodeKrcPayload(encodedContent, {
  maximumCompressedBytes,
  maximumDecompressedBytes,
}) {
  if (typeof encodedContent !== 'string' || !encodedContent) {
    throw new KrcDecodeError('download-krc', 'Kugou download-krc omitted content');
  }
  const encoded = decodeBase64(encodedContent, maximumCompressedBytes);
  if (encoded.length < 5 || new TextDecoder('ascii').decode(encoded.subarray(0, 4)) !== 'krc1') {
    throw new KrcDecodeError('decode-krc', 'KRC header is missing');
  }
  const encrypted = encoded.subarray(4);
  const compressed = new Uint8Array(encrypted.length);
  for (let index = 0; index < encrypted.length; index += 1) {
    compressed[index] = encrypted[index] ^ KRC_XOR_KEY[index % KRC_XOR_KEY.length];
  }
  try {
    const decompressed = await decompressDeflate(compressed, maximumDecompressedBytes);
    return new TextDecoder('utf-8', { fatal: true }).decode(decompressed);
  } catch (error) {
    if (error instanceof KrcDecodeError) throw error;
    throw new KrcDecodeError('decode-krc', 'KRC decompression failed', { cause: error });
  }
}
