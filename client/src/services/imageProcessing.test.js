import test from 'node:test';
import assert from 'node:assert/strict';
import { cropRectangle, imageFileDimensions, decodeUserImage, stripCanvasWebpMetadata } from './imageProcessing.js';
import { inspectUserWebp } from '../../../server/src/services/userImages.js';
test('canvas ICC/EXIF/XMP metadata is removed while alpha and pixel frame remain', () => {
  const chunk = (type, data) => { const out = new Uint8Array(8 + data.length + data.length % 2); out.set(new TextEncoder().encode(type)); new DataView(out.buffer).setUint32(4,data.length,true); out.set(data,8); return out; };
  const extended = new Uint8Array(10); extended[0] = 32|16|8|4; extended[4]=255;extended[5]=1;extended[7]=255;extended[8]=1;
  const frame = new Uint8Array(5);frame[0]=47;new DataView(frame.buffer).setUint32(1,511|(511<<14),true);
  const chunks=[chunk('VP8X',extended),chunk('ICCP',new Uint8Array(3)),chunk('VP8L',frame),chunk('EXIF',new Uint8Array(2)),chunk('XMP ',new Uint8Array(1))];
  const bytes=new Uint8Array(12+chunks.reduce((sum,c)=>sum+c.length,0));bytes.set(new TextEncoder().encode('RIFF'));bytes.set(new TextEncoder().encode('WEBP'),8);new DataView(bytes.buffer).setUint32(4,bytes.length-8,true);
  let offset=12;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
  assert.throws(()=>inspectUserWebp(bytes,'avatar'));
  const clean=stripCanvasWebpMetadata(bytes.buffer); assert.equal(clean[20],16);
  assert.deepEqual(inspectUserWebp(clean,'avatar'),{width:512,height:512,byteSize:clean.length});
  assert.deepEqual(clean.slice(-6,-1),frame);
});
test('square crop preserves aspect ratio and bounds on portrait, landscape and zoom', () => {
  assert.deepEqual(cropRectangle(1200,800), { x: 200, y: 0, size: 800 });
  assert.deepEqual(cropRectangle(800,1200), { x: 0, y: 200, size: 800 });
  assert.deepEqual(cropRectangle(800,800,2,1,0), { x: 400, y: 0, size: 400 });
  assert.deepEqual(cropRectangle(800,800,99,-1,2), { x: 0, y: 600, size: 200 });
});
test('file signatures and declared pixels are checked before allocating a decoded bitmap', async () => {
  const bytes = new Uint8Array(24); bytes.set([137,80,78,71,13,10,26,10]); bytes.set(new TextEncoder().encode('IHDR'),12);
  const view = new DataView(bytes.buffer); view.setUint32(16,10000); view.setUint32(20,10000);
  assert.deepEqual(imageFileDimensions(bytes.buffer,'image/png'),{width:10000,height:10000});
  await assert.rejects(decodeUserImage(new Blob([bytes],{type:'image/png'})),/2000/);
  assert.throws(()=>imageFileDimensions(new TextEncoder().encode('<svg/>').buffer,'image/png'));
  assert.throws(()=>imageFileDimensions(bytes.buffer,'image/jpeg'));
});
