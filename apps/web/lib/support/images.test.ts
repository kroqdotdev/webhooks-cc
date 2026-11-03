import { describe, expect, it } from "vitest";
import { cleanImage, ImageError, sniffImage } from "./images";

function crcTable(): number[] {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table.push(c >>> 0);
  }
  return table;
}
const TABLE = crcTable();
function crc(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc(Buffer.concat([Buffer.from(type, "latin1"), data])), 0);
  return Buffer.concat([head, data, tail]);
}

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IHDR = pngChunk("IHDR", Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]));
const IDAT = pngChunk("IDAT", Buffer.from([0x78, 0x9c, 0x63, 0x60, 0x60, 0x60, 0, 0, 0, 4, 0, 1]));
const IEND = pngChunk("IEND", Buffer.alloc(0));

function jpegSegment(marker: number, data: Buffer): Buffer {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([head, data]);
}

function webpChunk(fourcc: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(fourcc, 0, "latin1");
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function webp(chunks: Buffer[]): Buffer {
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(body.length + 4, 4);
  header.write("WEBP", 8, "latin1");
  return Buffer.concat([header, body]);
}

describe("support images", () => {
  it("sniffs by bytes, not names", () => {
    expect(sniffImage(Buffer.concat([SIG, IHDR, IEND]))).toBe("image/png");
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
  });

  it("refuses anything that is not PNG, JPEG or WebP", () => {
    expect(() => cleanImage(Buffer.from("<svg onload=alert(1)>"))).toThrow(ImageError);
    expect(() => cleanImage(Buffer.from("GIF89a"))).toThrow(ImageError);
  });

  it("drops PNG text and EXIF chunks and keeps the image", () => {
    const text = pngChunk("tEXt", Buffer.from("Comment\0secret location"));
    const exif = pngChunk("eXIf", Buffer.from("MM\0*GPS"));
    const input = Buffer.concat([SIG, IHDR, text, exif, IDAT, IEND]);
    const { bytes, type } = cleanImage(input);
    expect(type).toBe("image/png");
    expect(bytes.equals(Buffer.concat([SIG, IHDR, IDAT, IEND]))).toBe(true);
    expect(bytes.includes(Buffer.from("secret"))).toBe(false);
  });

  it("refuses a PNG that is cut short or does not start with IHDR", () => {
    expect(() => cleanImage(Buffer.concat([SIG, IHDR, IDAT]))).toThrow(ImageError);
    expect(() => cleanImage(Buffer.concat([SIG, IDAT, IEND]))).toThrow(ImageError);
  });

  it("drops JPEG EXIF, XMP and comments, keeps JFIF and the scan", () => {
    const jfif = jpegSegment(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1"));
    const exif = jpegSegment(0xe1, Buffer.from("Exif\0\0GPS-position", "latin1"));
    const comment = jpegSegment(0xfe, Buffer.from("taken at home"));
    const dqt = jpegSegment(0xdb, Buffer.alloc(65, 1));
    const sos = Buffer.concat([
      jpegSegment(0xda, Buffer.alloc(10, 2)),
      Buffer.from([9, 9, 9, 0xff, 0xd9]),
    ]);
    const input = Buffer.concat([Buffer.from([0xff, 0xd8]), jfif, exif, comment, dqt, sos]);
    const { bytes } = cleanImage(input);
    expect(bytes.equals(Buffer.concat([Buffer.from([0xff, 0xd8]), jfif, dqt, sos]))).toBe(true);
    // Anything appended after the end marker is dropped.
    const appended = cleanImage(Buffer.concat([input, Buffer.from("<html>hidden</html>")]));
    expect(appended.bytes.includes(Buffer.from("hidden"))).toBe(false);
    expect(bytes.includes(Buffer.from("GPS"))).toBe(false);
    expect(bytes.includes(Buffer.from("home"))).toBe(false);
  });

  it("drops WebP EXIF and XMP and clears their flags", () => {
    const vp8x = Buffer.alloc(10);
    vp8x[0] = 0x0c | 0x10;
    const input = webp([
      webpChunk("VP8X", vp8x),
      webpChunk("VP8 ", Buffer.alloc(20, 3)),
      webpChunk("EXIF", Buffer.from("GPS")),
      webpChunk("XMP ", Buffer.from("<x:xmpmeta>")),
      webpChunk("ZZZZ", Buffer.from("private payload")),
    ]);
    const { bytes, type } = cleanImage(input);
    expect(type).toBe("image/webp");
    expect(bytes.includes(Buffer.from("GPS"))).toBe(false);
    expect(bytes.includes(Buffer.from("xmpmeta"))).toBe(false);
    expect(bytes.includes(Buffer.from("private payload"))).toBe(false);
    // The flags byte of VP8X follows its 8-byte chunk header at offset 12.
    expect(bytes[20] & 0x0c).toBe(0);
    expect(bytes[20] & 0x10).toBe(0x10);
    expect(bytes.readUInt32LE(4)).toBe(bytes.length - 8);
  });

  it("refuses a WebP without image data", () => {
    expect(() => cleanImage(webp([webpChunk("EXIF", Buffer.from("x"))]))).toThrow(ImageError);
  });
});
