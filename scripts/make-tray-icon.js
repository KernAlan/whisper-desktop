// Draws the tray icon and writes it as a PNG.
//
// The icon is generated rather than hand-drawn so it can be tweaked in one
// place and regenerated: `node scripts/make-tray-icon.js`. Shapes are described
// in the final 32x32 coordinate space and rendered at 4x, then box-filtered
// down, which is what gives the curves their antialiased edges.
//
// The glyph is the product's gold (#ecc45f) rather than the usual monochrome.
// A white tray icon disappears on a light taskbar and a dark one disappears on
// Windows 11's default dark taskbar; the gold reads on both.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SIZE = 32;
const SCALE = 4;
const COLOR = { r: 0xec, g: 0xc4, b: 0x5f };

// Distance from a point to a line segment, used for the capsule body: every
// point within the cap radius of the segment is inside the shape.
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared
    ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared))
    : 0;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// True when the point is inside the microphone glyph. All coordinates are in
// 32x32 space, sampled at sub-pixel positions by the renderer.
function isInsideGlyph(x, y) {
  // Capsule body.
  if (distanceToSegment(x, y, 16, 11, 16, 15) <= 4.5) return true;
  // Cradle: the lower half of a ring, so it wraps under the body.
  const fromCenter = Math.hypot(x - 16, y - 16);
  if (y >= 15.5 && fromCenter >= 8.5 && fromCenter <= 10) return true;
  // Stem.
  if (x >= 15 && x <= 17 && y >= 25.25 && y <= 28) return true;
  // Base.
  if (x >= 11 && x <= 21 && y >= 28 && y <= 30) return true;
  return false;
}

function renderPixels() {
  const pixels = Buffer.alloc(SIZE * SIZE * 4);
  const samplesPerPixel = SCALE * SCALE;

  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      let covered = 0;
      for (let sy = 0; sy < SCALE; sy += 1) {
        for (let sx = 0; sx < SCALE; sx += 1) {
          // Sample at the centre of each sub-pixel.
          const px = x + (sx + 0.5) / SCALE;
          const py = y + (sy + 0.5) / SCALE;
          if (isInsideGlyph(px, py)) covered += 1;
        }
      }
      const offset = (y * SIZE + x) * 4;
      pixels[offset] = COLOR.r;
      pixels[offset + 1] = COLOR.g;
      pixels[offset + 2] = COLOR.b;
      pixels[offset + 3] = Math.round((covered / samplesPerPixel) * 255);
    }
  }
  return pixels;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  // Each scanline is prefixed with its filter type. Filter 0 (none) keeps this
  // encoder simple; the image is small enough that the size difference is noise.
  const stride = SIZE * 4;
  const raw = Buffer.alloc((stride + 1) * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const outputPath = path.join(__dirname, "..", "src", "main", "assets", "tray-icon.png");
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, encodePng(renderPixels()));
console.log(`Wrote ${path.relative(path.join(__dirname, ".."), outputPath)} (${SIZE}x${SIZE})`);
