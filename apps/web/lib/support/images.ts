/**
 * Screenshots on support tickets: PNG, JPEG or WebP, checked by their bytes
 * (never the name or the browser's type) and rewritten without metadata.
 * EXIF can carry a GPS position and camera serial numbers, and text chunks
 * can carry anything, so only the chunks needed to draw the image are kept.
 * Anything that does not parse as one of the three formats is refused; SVG
 * in particular never gets through, since it can carry script.
 */

export type ImageType = "image/png" | "image/jpeg" | "image/webp";

export class ImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageError";
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The format by its leading bytes, or null. */
export function sniffImage(bytes: Uint8Array): ImageType | null {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (
    buf.length >= 12 &&
    buf.toString("latin1", 0, 4) === "RIFF" &&
    buf.toString("latin1", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

// Chunks that change how the pixels look; everything else (text, EXIF,
// timestamps, unknown private chunks) is dropped.
const PNG_KEEP = new Set([
  "IHDR",
  "PLTE",
  "IDAT",
  "IEND",
  "tRNS",
  "gAMA",
  "cHRM",
  "sRGB",
  "iCCP",
  "sBIT",
  "pHYs",
  "bKGD",
]);

function cleanPng(buf: Buffer): Buffer {
  const parts: Buffer[] = [PNG_SIGNATURE];
  let offset = 8;
  let first = true;
  let ended = false;
  while (offset < buf.length) {
    if (offset + 12 > buf.length) throw new ImageError("The PNG file is cut short.");
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("latin1", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (!/^[A-Za-z]{4}$/.test(type) || end > buf.length) {
      throw new ImageError("The PNG file is damaged.");
    }
    if (first && type !== "IHDR") throw new ImageError("The PNG file is damaged.");
    first = false;
    if (PNG_KEEP.has(type)) parts.push(buf.subarray(offset, end));
    offset = end;
    if (type === "IEND") {
      ended = true;
      break;
    }
  }
  if (!ended) throw new ImageError("The PNG file is cut short.");
  return Buffer.concat(parts);
}

function cleanJpeg(buf: Buffer): Buffer {
  const parts: Buffer[] = [buf.subarray(0, 2)];
  let offset = 2;
  while (offset < buf.length) {
    if (buf[offset] !== 0xff) throw new ImageError("The JPEG file is damaged.");
    // Fill bytes before a marker.
    while (buf[offset + 1] === 0xff) offset++;
    const marker = buf[offset + 1];
    if (marker === undefined) throw new ImageError("The JPEG file is cut short.");
    if (marker === 0xd9) {
      parts.push(buf.subarray(offset, offset + 2));
      return Buffer.concat(parts);
    }
    // Markers without a length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(buf.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }
    if (offset + 4 > buf.length) throw new ImageError("The JPEG file is cut short.");
    const length = buf.readUInt16BE(offset + 2);
    const end = offset + 2 + length;
    if (length < 2 || end > buf.length) throw new ImageError("The JPEG file is damaged.");
    if (marker === 0xda) {
      // Start of scan: the compressed data and everything after it (further
      // scans of a progressive image) up to the end marker are image data.
      // Inside compressed data a 0xFF is always followed by 0x00 or a
      // restart marker, so the first FF D9 is the end; bytes appended after
      // it are dropped.
      let eoi = -1;
      for (let i = end; i + 1 < buf.length; i++) {
        if (buf[i] === 0xff && buf[i + 1] === 0xd9) {
          eoi = i;
          break;
        }
      }
      if (eoi === -1) throw new ImageError("The JPEG file is cut short.");
      parts.push(buf.subarray(offset, eoi + 2));
      return Buffer.concat(parts);
    }
    const isApp = marker >= 0xe0 && marker <= 0xef;
    const keepApp =
      marker === 0xe0 || // JFIF
      marker === 0xee || // Adobe: colour transform
      (marker === 0xe2 && buf.toString("latin1", offset + 4, offset + 15) === "ICC_PROFILE");
    const isComment = marker === 0xfe;
    if ((!isApp || keepApp) && !isComment) parts.push(buf.subarray(offset, end));
    offset = end;
  }
  throw new ImageError("The JPEG file is cut short.");
}

// Chunks that draw the image; EXIF, XMP and anything unknown are dropped.
const WEBP_KEEP = new Set(["VP8 ", "VP8L", "VP8X", "ALPH", "ANIM", "ANMF", "ICCP"]);

function cleanWebp(buf: Buffer): Buffer {
  const declared = buf.readUInt32LE(4) + 8;
  if (declared > buf.length || declared < 12) throw new ImageError("The WebP file is damaged.");
  const parts: Buffer[] = [];
  let offset = 12;
  let sawImage = false;
  while (offset < declared) {
    if (offset + 8 > declared) throw new ImageError("The WebP file is damaged.");
    const fourcc = buf.toString("latin1", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const end = offset + 8 + size + (size % 2);
    if (end > declared) throw new ImageError("The WebP file is damaged.");
    if (!WEBP_KEEP.has(fourcc)) {
      offset = end;
      continue;
    }
    let chunk = buf.subarray(offset, end);
    if (fourcc === "VP8X" && size >= 1) {
      // Clear the flags that announce the EXIF and XMP chunks dropped above.
      chunk = Buffer.from(chunk);
      chunk[8] = chunk[8] & ~0x0c;
    }
    if (fourcc === "VP8 " || fourcc === "VP8L" || fourcc === "ANMF") sawImage = true;
    parts.push(chunk);
    offset = end;
  }
  if (!sawImage) throw new ImageError("The WebP file holds no image.");
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(body.length + 4, 4);
  header.write("WEBP", 8, "latin1");
  return Buffer.concat([header, body]);
}

/** The image with its metadata removed, and its type. Throws ImageError. */
export function cleanImage(bytes: Uint8Array): { bytes: Buffer; type: ImageType } {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = sniffImage(buf);
  if (!type) throw new ImageError("Only PNG, JPEG and WebP images can be attached.");
  const cleaned =
    type === "image/png" ? cleanPng(buf) : type === "image/jpeg" ? cleanJpeg(buf) : cleanWebp(buf);
  return { bytes: cleaned, type };
}
