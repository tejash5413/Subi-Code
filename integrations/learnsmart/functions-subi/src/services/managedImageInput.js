// Explicit inline image contract. No remote fetches, paths or image logging.
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 4 * 1024 * 1024;
function fail(code) { const e = new Error('Invalid managed image input.'); e.code = code; throw e; }
function matchesType(bytes, mimeType) {
  if (mimeType === 'image/png') return bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0;
  if (mimeType === 'image/jpeg') return bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes[bytes.length-2] === 255 && bytes[bytes.length-1] === 217;
  if (mimeType === 'image/gif') return bytes.length >= 10 && ['GIF87a','GIF89a'].includes(bytes.toString('ascii', 0, 6)) && bytes.readUInt16LE(6) > 0 && bytes.readUInt16LE(8) > 0;
  if (mimeType === 'image/webp') return bytes.length >= 16 && bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP' && ['VP8 ','VP8L','VP8X'].includes(bytes.toString('ascii',12,16));
  return false;
}
function validateManagedImages(images, budget) {
  if (images === undefined) return undefined;
  if (!Array.isArray(images) || images.length === 0) fail('INVALID_REQUEST');
  if (images.length + budget.count > MAX_IMAGES) fail('REQUEST_TOO_LARGE');
  return images.map(image => {
    if (!image || typeof image !== 'object' || Array.isArray(image) || Object.keys(image).some(k => !['mimeType','base64'].includes(k)) || typeof image.mimeType !== 'string' || typeof image.base64 !== 'string') fail('INVALID_REQUEST');
    if (image.base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) fail('REQUEST_TOO_LARGE');
    if (!image.base64.length || image.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.base64)) fail('INVALID_REQUEST');
    const bytes = Buffer.from(image.base64, 'base64');
    if (bytes.toString('base64') !== image.base64 || !matchesType(bytes, image.mimeType)) fail('INVALID_REQUEST');
    budget.bytes += bytes.length; budget.count += 1;
    if (bytes.length > MAX_IMAGE_BYTES || budget.bytes > MAX_TOTAL_IMAGE_BYTES) fail('REQUEST_TOO_LARGE');
    return { mimeType: image.mimeType, base64: image.base64 };
  });
}
module.exports = { validateManagedImages, MAX_IMAGES, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES };
