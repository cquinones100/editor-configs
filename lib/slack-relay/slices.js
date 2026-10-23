// Part of bin/slack-relay; see the comment at the top of that file.

const zlib = require("node:zlib");

// ── Tall images, sliced for Slack ───────────────────────────────────────────

// Slack shows an image at a size set by its longest side, so a very tall one,
// a long diff's screenshot, is shrunk until its width is a sliver and its text
// unreadable, on a phone above all. A PNG more than MAX_RATIO times as tall as
// it is wide is cut into slices about as tall as it is wide, even in height
// and in order, and those are shared instead. It is read and written with
// zlib alone: 8-bit RGB and RGBA PNGs without interlacing, which is what
// Chrome and Playwright save. Anything else, or one too big to decode in
// memory (MAX_RAW_BYTES), is shared as it is.
const MAX_RATIO = 2;
const MAX_RAW_BYTES = 512 * 1024 * 1024;
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// { width, height, bitDepth, colorType, interlace, data } with data the
// inflated, still filtered rows, or undefined when it isn't a PNG this reads.
const readPng = (buffer) => {
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(SIGNATURE)) return undefined;
  let header;
  const idat = [];
  for (let at = 8; at + 8 <= buffer.length; ) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString("latin1", at + 4, at + 8);
    const data = buffer.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), bitDepth: data[8], colorType: data[9], interlace: data[12] };
    if (type === "IDAT") idat.push(data);
    if (type === "IEND") break;
    at += 12 + length;
  }
  return header && { ...header, idat };
};

// The PNG for `rows` (each a row's raw pixels, unfiltered), with the given
// width and color type, its rows stored without filtering.
const writePng = (width, colorType, rows) => {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(rows.length, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const raw = Buffer.concat(rows.flatMap((row) => [Buffer.from([0]), row]));
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
};

// Undoes PNG's per-row filters (none, sub, up, average, Paeth) on `line`
// in place, given the row above it.
const unfilter = (filter, line, above, bpp) => {
  for (let i = 0; i < line.length; i++) {
    const a = i >= bpp ? line[i - bpp] : 0;
    const b = above[i];
    const c = i >= bpp ? above[i - bpp] : 0;
    let add = 0;
    if (filter === 1) add = a;
    else if (filter === 2) add = b;
    else if (filter === 3) add = (a + b) >> 1;
    else if (filter === 4) {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
    line[i] = (line[i] + add) & 255;
  }
};

// [{ filename, content }]: the file as it is, or its slices, named
// "<name>-part<k>of<n>.png".
const sliced = ({ filename, content }) => {
  const png = readPng(content);
  const bpp = png && png.bitDepth === 8 && !png.interlace ? { 2: 3, 6: 4 }[png.colorType] : undefined;
  if (!bpp || png.height <= png.width * MAX_RATIO) return [{ filename, content }];
  const stride = png.width * bpp;
  if ((stride + 1) * png.height > MAX_RAW_BYTES) return [{ filename, content }];
  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(png.idat));
  } catch {
    return [{ filename, content }];
  }
  if (raw.length < (stride + 1) * png.height) return [{ filename, content }];
  const parts = Math.ceil(png.height / png.width);
  const each = Math.ceil(png.height / parts);
  const base = filename.replace(/\.png$/i, "");
  const slices = Array.from({ length: parts }, () => []);
  let above = Buffer.alloc(stride);
  for (let y = 0; y < png.height; y++) {
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    unfilter(raw[y * (stride + 1)], line, above, bpp);
    slices[Math.floor(y / each)].push(line);
    above = line;
  }
  return slices.map((rows, i) => ({ filename: `${base}-part${i + 1}of${parts}.png`, content: writePng(png.width, png.colorType, rows) }));
};

module.exports = { MAX_RATIO, readPng, writePng, sliced };
