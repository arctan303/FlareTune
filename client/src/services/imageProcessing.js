export const IMAGE_INPUT_LIMIT = 5 * 1024 * 1024;
export function imageFileDimensions(buffer, type) {
  const b = new Uint8Array(buffer); const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const text = at => String.fromCharCode(...b.subarray(at, at + 4));
  if (type === 'image/png' && b.length >= 24 && [137,80,78,71,13,10,26,10].every((n,i)=>b[i]===n) && text(12) === 'IHDR') {
    return { width: v.getUint32(16), height: v.getUint32(20) };
  }
  if (type === 'image/jpeg' && b[0] === 255 && b[1] === 216) {
    for (let at = 2; at + 4 < b.length;) {
      if (b[at++] !== 255) break;
      while (b[at] === 255) at += 1;
      const marker = b[at++]; if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (at + 2 > b.length) break;
      const length = v.getUint16(at); if (length < 2 || at + length > b.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && length >= 8) {
        return { width: v.getUint16(at + 5), height: v.getUint16(at + 3) };
      }
      at += length;
    }
  }
  if (type === 'image/webp' && b.length >= 20 && text(0) === 'RIFF' && text(8) === 'WEBP' && v.getUint32(4,true)+8===b.length) {
    for(let at=12; at+8<=b.length;) {
      const kind=text(at), length=v.getUint32(at+4,true), p=at+8;
      if(p+length>b.length) break;
      if(kind==='VP8X' && length===10) return { width:1+b[p+4]+(b[p+5]<<8)+(b[p+6]<<16),height:1+b[p+7]+(b[p+8]<<8)+(b[p+9]<<16) };
      if(kind==='VP8 ' && length>=10 && b[p+3]===157 && b[p+4]===1 && b[p+5]===42) return { width:v.getUint16(p+6,true)&16383,height:v.getUint16(p+8,true)&16383 };
      if(kind==='VP8L' && length>=5 && b[p]===47) {const bits=v.getUint32(p+1,true);return {width:(bits&16383)+1,height:((bits>>>14)&16383)+1};}
      at=p+length+(length%2);
    }
  }
  throw new Error('请选择不超过 5 MiB 的 JPEG、PNG 或 WebP 图片。');
}
export async function decodeUserImage(file) {
  if (!['image/jpeg','image/png','image/webp'].includes(file?.type) || !file.size || file.size > IMAGE_INPUT_LIMIT) {
    throw new Error('请选择不超过 5 MiB 的 JPEG、PNG 或 WebP 图片。');
  }
  const dimensions = imageFileDimensions(await file.arrayBuffer(), file.type);
  if (!dimensions.width || !dimensions.height || dimensions.width * dimensions.height > 20000000) {
    throw new Error('图片尺寸超过 2000 万像素，请缩小后重试。');
  }
  const image = await createImageBitmap(file, { imageOrientation: 'from-image' });
  if (!image.width || !image.height || image.width * image.height > 20000000) {
    image.close(); throw new Error('图片尺寸超过 2000 万像素，请缩小后重试。');
  }
  return image;
}
export function cropRectangle(width, height, zoom = 1, x = 0.5, y = 0.5) {
  const size = Math.min(width, height) / Math.max(1, Math.min(4, zoom));
  return { x: (width - size) * Math.max(0, Math.min(1, x)), y: (height - size) * Math.max(0, Math.min(1, y)), size };
}
// Some Chromium canvases attach an ICC profile even after pixel re-encoding.
// Our canvas is sRGB; remove optional metadata before private storage.
export function stripCanvasWebpMetadata(buffer) {
  const bytes = new Uint8Array(buffer); const view = new DataView(bytes.buffer);
  const chunks = []; let size = 12;
  for (let at = 12; at + 8 <= bytes.length;) {
    const type = String.fromCharCode(...bytes.subarray(at, at + 4));
    const length = view.getUint32(at + 4, true); const end = at + 8 + length + length % 2;
    if (end > bytes.length) throw new Error('图片处理失败，请缩小后重试。');
    if (!['ICCP', 'EXIF', 'XMP '].includes(type)) {
      const chunk = bytes.slice(at, end);
      if (type === 'VP8X') chunk[8] &= ~(32 | 8 | 4);
      chunks.push(chunk); size += chunk.length;
    }
    at = end;
  }
  const output = new Uint8Array(size); output.set(bytes.subarray(0, 12));
  new DataView(output.buffer).setUint32(4, size - 8, true);
  let offset = 12; for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}
export async function encodeUserImage(image, { purpose, zoom = 1, x = 0.5, y = 0.5 } = {}) {
  const canvas = document.createElement('canvas');
  if (purpose === 'chat') {
    const ratio = Math.min(1, 2048 / Math.max(image.width, image.height));
    canvas.width = Math.max(1, Math.round(image.width * ratio)); canvas.height = Math.max(1, Math.round(image.height * ratio));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  } else {
    canvas.width = canvas.height = purpose === 'avatar' ? 512 : 1024;
    const crop = cropRectangle(image.width, image.height, zoom, x, y);
    canvas.getContext('2d').drawImage(image, crop.x, crop.y, crop.size, crop.size, 0, 0, canvas.width, canvas.height);
  }
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.92));
  if (!blob || blob.type !== 'image/webp' || blob.size > IMAGE_INPUT_LIMIT) throw new Error('图片处理失败，请缩小后重试。');
  return new Blob([stripCanvasWebpMetadata(await blob.arrayBuffer())], { type: 'image/webp' });
}
