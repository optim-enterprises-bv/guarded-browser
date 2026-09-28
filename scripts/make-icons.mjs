// Generates the app icon set (PNG, no dependencies): a blue rounded square with a white shield.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};

function pixel(x, y, n) {
  const u = (x + 0.5) / n;
  const v = (y + 0.5) / n;
  // rounded square
  const r = 0.2;
  const dx = Math.max(0, Math.abs(u - 0.5) - (0.5 - r));
  const dy = Math.max(0, Math.abs(v - 0.5) - (0.5 - r));
  const inSquare = Math.hypot(dx, dy) <= r;
  if (!inSquare) return [0, 0, 0, 0];
  // shield: top edge at 0.2, sides at 0.28..0.72, tapering to a point at 0.84
  const top = 0.2;
  const half = v < 0.55 ? 0.22 : 0.22 * Math.max(0, (0.84 - v) / 0.29);
  const inShield = v >= top && v <= 0.84 && Math.abs(u - 0.5) <= half;
  const inner = v >= top + 0.07 && v <= 0.74 && Math.abs(u - 0.5) <= half - 0.07;
  if (inShield && !inner) return [255, 255, 255, 255];
  if (inner && Math.abs(u - 0.5) <= 0.03 && v <= 0.62) return [255, 214, 0, 255]; // yellow bar
  return [47, 91, 211, 255];
}

function png(n) {
  const rows = [];
  for (let y = 0; y < n; y++) {
    const row = [0];
    for (let x = 0; x < n; x++) row.push(...pixel(x, y, n));
    rows.push(Buffer.from(row));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0);
  ihdr.writeUInt32BE(n, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

mkdirSync('build/icons', { recursive: true });
for (const n of [16, 32, 48, 64, 128, 256, 512]) writeFileSync(`build/icons/${n}x${n}.png`, png(n));
writeFileSync('build/icon.png', png(512));
console.log('icons written to build/icons');
