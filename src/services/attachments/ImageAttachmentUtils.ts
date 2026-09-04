/**
 * Host-side image validation helpers (Stage 4A.2.3).
 *
 * Magic-byte based format recognition. Never trusts the file extension.
 * Supported initial set: PNG, JPEG, WEBP, GIF. SVG is intentionally NOT
 * supported (XML with potential active/external content). BMP is rejected
 * to keep provider image support clean.
 */

export interface DetectedImage {
  mimeType: string;
  width?: number;
  height?: number;
}

function readU16BE(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1];
}

function readU16LE(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}

function readU24LE(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
}

function startsWith(b: Uint8Array, prefix: number[]): boolean {
  if (b.length < prefix.length) {
    return false;
  }
  for (let i = 0; i < prefix.length; i++) {
    if (b[i] !== prefix[i]) {
      return false;
    }
  }
  return true;
}

function ascii(b: Uint8Array, o: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) {
    s += String.fromCharCode(b[o + i]);
  }
  return s;
}

function pngDimensions(b: Uint8Array): { width: number; height: number } | undefined {
  // Signature (8) + IHDR length (4) + 'IHDR' (4) + width (4 BE) + height (4 BE).
  if (b.length < 24 || ascii(b, 12, 4) !== 'IHDR') {
    return undefined;
  }
  const width = (b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19];
  const height = (b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23];
  if (width <= 0 || height <= 0) {
    return undefined;
  }
  return { width, height };
}

function gifDimensions(b: Uint8Array): { width: number; height: number } | undefined {
  if (b.length < 10) {
    return undefined;
  }
  const width = readU16LE(b, 6);
  const height = readU16LE(b, 8);
  if (width <= 0 || height <= 0) {
    return undefined;
  }
  return { width, height };
}

function jpegDimensions(b: Uint8Array): { width: number; height: number } | undefined {
  // Scan markers for a Start-Of-Frame segment (baseline/progressive/etc).
  let o = 2;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) {
      return undefined;
    }
    const marker = b[o + 1];
    // Standalone markers without length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      o += 2;
      continue;
    }
    if (marker === 0xda || marker === 0x00) {
      return undefined; // start of scan / invalid
    }
    const segLen = readU16BE(b, o + 2);
    if (segLen < 2 || o + 2 + segLen > b.length + 1) {
      return undefined;
    }
    const isSof =
      (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc);
    if (isSof) {
      if (o + 9 > b.length) {
        return undefined;
      }
      const height = readU16BE(b, o + 5);
      const width = readU16BE(b, o + 7);
      if (width <= 0 || height <= 0) {
        return undefined;
      }
      return { width, height };
    }
    o += 2 + segLen;
  }
  return undefined;
}

function webpDimensions(b: Uint8Array): { width: number; height: number } | undefined {
  // RIFF....WEBP + chunk FourCC at offset 12.
  if (b.length < 20 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') {
    return undefined;
  }
  const fourCC = ascii(b, 12, 4);
  try {
    if (fourCC === 'VP8 ') {
      // Lossy bitstream: frame tag (3) + start code (3) + width/height (4, 14-bit LE).
      if (b.length < 30) {
        return undefined;
      }
      const width = readU16LE(b, 26) & 0x3fff;
      const height = readU16LE(b, 28) & 0x3fff;
      if (width <= 0 || height <= 0) {
        return undefined;
      }
      return { width, height };
    }
    if (fourCC === 'VP8L') {
      // 1 signature byte + 4 packed bytes: 14-bit width-1, 14-bit height-1.
      if (b.length < 25 || b[20] !== 0x2f) {
        return undefined;
      }
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >> 14) & 0x3fff) + 1;
      return { width, height };
    }
    if (fourCC === 'VP8X') {
      // Canvas size: 24-bit LE width-1 / height-1 at offsets 24/27.
      if (b.length < 30) {
        return undefined;
      }
      const width = readU24LE(b, 24) + 1;
      const height = readU24LE(b, 27) + 1;
      return { width, height };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Recognize PNG/JPEG/WEBP/GIF by magic bytes. Returns undefined when unsupported. */
export function detectImageBytes(bytes: Uint8Array): DetectedImage | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    const dims = pngDimensions(bytes);
    return { mimeType: 'image/png', width: dims?.width, height: dims?.height };
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    const dims = jpegDimensions(bytes);
    return { mimeType: 'image/jpeg', width: dims?.width, height: dims?.height };
  }
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) {
    const dims = gifDimensions(bytes);
    return { mimeType: 'image/gif', width: dims?.width, height: dims?.height };
  }
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && bytes.length >= 12 && ascii(bytes, 8, 4) === 'WEBP') {
    const dims = webpDimensions(bytes);
    if (!dims && bytes.length < 20) {
      return undefined;
    }
    return { mimeType: 'image/webp', width: dims?.width, height: dims?.height };
  }
  return undefined;
}
