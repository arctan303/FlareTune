// Reused unchanged from legacy FlareTune (7dcda9b), Apache-2.0.
// License: ../../../../licenses/legacy-flaretune-Apache-2.0.txt
// Cloudflare Workers Web Crypto does not expose MD5. This small implementation is
// intentionally local to the legacy Subsonic t+s compatibility boundary.
const ROTATIONS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const CONSTANTS = Array.from(
  { length: 64 },
  (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) >>> 0,
);

function rotateLeft(value, shift) {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

function wordToHex(word) {
  let output = '';
  for (let index = 0; index < 4; index += 1) {
    output += ((word >>> (index * 8)) & 0xff).toString(16).padStart(2, '0');
  }
  return output;
}

export function md5(value) {
  const source = new TextEncoder().encode(String(value));
  const paddedLength = Math.ceil((source.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(source);
  bytes[source.length] = 0x80;

  const bitLength = BigInt(source.length) * 8n;
  const lengthView = new DataView(bytes.buffer);
  lengthView.setUint32(paddedLength - 8, Number(bitLength & 0xffffffffn), true);
  lengthView.setUint32(paddedLength - 4, Number((bitLength >> 32n) & 0xffffffffn), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < paddedLength; offset += 64) {
    const words = Array.from({ length: 16 }, (_, index) =>
      lengthView.getUint32(offset + index * 4, true));
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let index = 0; index < 64; index += 1) {
      let f;
      let wordIndex;
      if (index < 16) {
        f = (b & c) | (~b & d);
        wordIndex = index;
      } else if (index < 32) {
        f = (d & b) | (~d & c);
        wordIndex = (5 * index + 1) % 16;
      } else if (index < 48) {
        f = b ^ c ^ d;
        wordIndex = (3 * index + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        wordIndex = (7 * index) % 16;
      }

      const nextD = c;
      c = b;
      const sum = (a + f + CONSTANTS[index] + words[wordIndex]) >>> 0;
      b = (b + rotateLeft(sum, ROTATIONS[index])) >>> 0;
      a = d;
      d = nextD;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  return wordToHex(a0) + wordToHex(b0) + wordToHex(c0) + wordToHex(d0);
}
