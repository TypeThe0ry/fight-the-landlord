#!/usr/bin/env node
/*
 * Dependency-free layout smoke test for the fixed room controls.
 * It mirrors the CSS breakpoints for the room top bar, exit button,
 * user badge, spectator badge, self avatar and bottom hand area, then
 * emits SVG snapshots that can be opened as screenshot artifacts.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const outDir = path.join(process.cwd(), 'artifacts', 'ui-layout');
fs.mkdirSync(outDir, { recursive: true });

const viewports = [
  { name: 'desktop-1366x768', w: 1366, h: 768 },
  { name: 'tablet-1024x768', w: 1024, h: 768 },
  { name: 'mobile-landscape-667x375', w: 667, h: 375 },
  { name: 'narrow-landscape-480x320', w: 480, h: 320 },
];

function cardH(w) {
  if (w <= 640) return 72;
  if (w <= 1024) return 94;
  return 120;
}

function rects(vp) {
  const ch = cardH(vp.w);
  const isMobile = vp.w <= 768;
  const isTiny = vp.w <= 480;
  const topbarW = isMobile
    ? vp.w - 20
    : Math.min(vp.w <= 1024 ? 620 : 720, vp.w - (vp.w <= 1024 ? 300 : 360));
  const topbarH = isMobile ? 76 : 44;
  const topbarTop = isMobile ? 54 : 14;
  const exitW = isTiny ? 96 : 124;
  const userW = isMobile ? (isTiny ? 110 : Math.min(220, vp.w - 150)) : 150;
  const handBottom = vp.w <= 480 ? 46 : 44;
  const handH = ch;
  const avatarVisible = vp.w > 768;
  const avatarH = 108;
  return {
    exit: { x: isMobile ? 8 : 18, y: isMobile ? 8 : 18, w: exitW, h: 36 },
    userBadge: { x: vp.w - (isMobile ? 8 : 24) - userW, y: isMobile ? 8 : 14, w: userW, h: 32 },
    topbar: { x: (vp.w - topbarW) / 2, y: topbarTop, w: topbarW, h: topbarH },
    specBadge: isMobile ? { x: (vp.w - 150) / 2, y: 8, w: 150, h: 34 } : { x: (vp.w - 240) / 2, y: 66, w: 240, h: 34 },
    hand: { x: vp.w <= 480 ? 8 : 86, y: vp.h - handBottom - handH, w: vp.w <= 480 ? vp.w - 16 : vp.w - 172, h: handH },
    selfAvatar: avatarVisible ? { x: Math.max(18, Math.min(vp.w / 2 - 370, 430)), y: vp.h - (44 + ch + 10) - avatarH, w: 96, h: avatarH } : null,
    actionBar: { x: (vp.w - Math.min(500, vp.w - (isMobile ? 20 : 360))) / 2, y: vp.h - (isMobile ? (vp.h <= 360 ? 118 : 158) : 184) - 64, w: Math.min(500, vp.w - (isMobile ? 20 : 360)), h: 64 },
  };
}

function overlaps(a, b) {
  return Boolean(a && b && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y);
}

function assertNoOverlap(vp, map, a, b, allowed = false) {
  if (!allowed && overlaps(map[a], map[b])) {
    throw new Error(`${vp.name}: ${a} overlaps ${b}`);
  }
}


function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function writePng(file, vp, map) {
  const width = vp.w;
  const height = vp.h;
  const data = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    data[row] = 0;
    for (let x = 0; x < width; x++) {
      const i = row + 1 + x * 4;
      data[i] = 10; data[i + 1] = 20; data[i + 2] = 22; data[i + 3] = 255;
    }
  }
  const rgba = {
    exit: [232, 90, 79], userBadge: [233, 193, 120], topbar: [79, 182, 163],
    specBadge: [200, 54, 47], hand: [141, 213, 196], selfAvatar: [251, 241, 207], actionBar: [212, 168, 90]
  };
  for (const [name, r] of Object.entries(map)) {
    if (!r) continue;
    const [rr, gg, bb] = rgba[name];
    const x0 = Math.max(0, Math.floor(r.x));
    const y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(width, Math.ceil(r.x + r.w));
    const y1 = Math.min(height, Math.ceil(r.y + r.h));
    for (let y = y0; y < y1; y++) {
      const row = y * (width * 4 + 1);
      for (let x = x0; x < x1; x++) {
        const border = x - x0 < 2 || x1 - x <= 2 || y - y0 < 2 || y1 - y <= 2;
        const i = row + 1 + x * 4;
        data[i] = border ? rr : Math.round(data[i] * 0.55 + rr * 0.45);
        data[i + 1] = border ? gg : Math.round(data[i + 1] * 0.55 + gg * 0.45);
        data[i + 2] = border ? bb : Math.round(data[i + 2] * 0.55 + bb * 0.45);
        data[i + 3] = 255;
      }
    }
  }
  const signature = Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  fs.writeFileSync(file, Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(data)), chunk('IEND', Buffer.alloc(0))]));
}

function svg(vp, map) {
  const colors = {
    exit: '#e85a4f', userBadge: '#e9c178', topbar: '#4fb6a3', specBadge: '#c8362f', hand: '#8dd5c4', selfAvatar: '#fbf1cf', actionBar: '#d4a85a'
  };
  const items = Object.entries(map).filter(([, r]) => r);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${vp.w}" height="${vp.h}" viewBox="0 0 ${vp.w} ${vp.h}">
  <rect width="100%" height="100%" fill="#0a1416"/>
  <text x="18" y="${vp.h - 18}" fill="#ecead9" font-family="monospace" font-size="14">${vp.name} room UI overlap verification</text>
${items.map(([name, r]) => `  <rect x="${r.x.toFixed(1)}" y="${r.y.toFixed(1)}" width="${r.w.toFixed(1)}" height="${r.h.toFixed(1)}" rx="8" fill="${colors[name]}" fill-opacity="0.32" stroke="${colors[name]}" stroke-width="2"/>
  <text x="${(r.x + 6).toFixed(1)}" y="${(r.y + 18).toFixed(1)}" fill="#fff" font-family="monospace" font-size="12">${name}</text>`).join('\n')}
</svg>\n`;
}

for (const vp of viewports) {
  const map = rects(vp);
  assertNoOverlap(vp, map, 'exit', 'topbar');
  assertNoOverlap(vp, map, 'exit', 'userBadge');
  assertNoOverlap(vp, map, 'userBadge', 'topbar');
  assertNoOverlap(vp, map, 'specBadge', 'topbar');
  assertNoOverlap(vp, map, 'selfAvatar', 'hand');
  assertNoOverlap(vp, map, 'selfAvatar', 'actionBar');
  const file = path.join(outDir, `${vp.name}.svg`);
  fs.writeFileSync(file, svg(vp, map));
  const pngFile = path.join(outDir, `${vp.name}.png`);
  writePng(pngFile, vp, map);
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
  console.log(`wrote ${path.relative(process.cwd(), pngFile)}`);
}
console.log('UI layout overlap verification passed');
