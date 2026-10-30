// Generates Prepium PWA icons (192, 512, maskable 512, apple-touch 180)
// from the brand palette using a pure-Node PNG encoder (no image deps).
// Usage: node scripts/generate-icons.js

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function crc32(buf) {
    let table = crc32.table;
    if (!table) {
        table = crc32.table = [];
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            table[n] = c >>> 0;
        }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
    return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const raw = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (width * 4 + 1)] = 0;
        rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
    }
    const idat = zlib.deflateSync(raw, { level: 9 });
    return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

// Brand gradient #2563eb -> #3b82f6, diagonal
function brandPixel(x, y) {
    const t = clamp01((x + y) / 2);
    const r = Math.round(0x25 + (0x3b - 0x25) * t);
    const g = Math.round(0x63 + (0x82 - 0x63) * t);
    const b = Math.round(0xeb + (0xf6 - 0xeb) * t);
    return [r, g, b];
}

// Draws the app tile: rounded square + white "P" letterform.
function drawTile(size, opts) {
    const { maskable } = opts || {};
    const rgba = Buffer.alloc(size * size * 4);
    const radius = maskable ? size * 0 : size * 0.22;
    // Maskable icons need a safe zone: content within the central 80%.
    const scale = maskable ? 0.78 : 0.86;
    const pad = (size * (1 - scale)) / 2;
    const tile = size - pad * 2;
    const tileR = radius * (tile / size);

    // "P" glyph metrics (relative to tile)
    const stemW = tile * 0.16;
    const stemX = pad + tile * 0.30;
    const topY = pad + tile * 0.24;
    const bowlH = tile * 0.34;
    const bowlW = tile * 0.34;
    const bowlR = pad + tile * 0.30 + stemW;
    const holeInset = stemW * 0.55;
    const stemBottom = pad + tile * 0.76;

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4;
            // Tile shape with anti-aliased rounded corners
            let alpha = 0;
            if (!maskable) {
                const cx = Math.max(Math.min(x, pad + tile - tileR), pad + tileR);
                const cy = Math.max(Math.min(y, pad + tile - tileR), pad + tileR);
                const d = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
                alpha = clamp01(tileR - d + 0.5);
            } else {
                alpha = 1;
            }
            let [r, g, b] = brandPixel((x - pad) / tile, (y - pad) / tile);

            // White "P": stem + bowl ring, subtract hole
            const inStem = x >= stemX && x <= stemX + stemW && y >= topY && y <= stemBottom;
            const inBowlX = x >= stemX && x <= bowlR + bowlW;
            const inBowlY = y >= topY && y <= topY + bowlH;
            const inHole = x >= stemX + stemW + holeInset * 0.4 &&
                x <= bowlR + bowlW - holeInset &&
                y >= topY + holeInset &&
                y <= topY + bowlH - holeInset;
            const inP = (inStem || (inBowlX && inBowlY)) && !inHole;

            if (inP) { r = 255; g = 255; b = 255; }
            rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b;
            rgba[i + 3] = Math.round(alpha * 255);
        }
    }
    return encodePNG(size, size, rgba);
}

const outDir = path.join(__dirname, '..', 'public', 'images');
fs.mkdirSync(outDir, { recursive: true });
const icons = [
    ['icon-192.png', 192, false],
    ['icon-512.png', 512, false],
    ['icon-maskable-512.png', 512, true],
    ['icon-180.png', 180, false]
];
for (const [name, size, maskable] of icons) {
    fs.writeFileSync(path.join(outDir, name), drawTile(size, { maskable }));
    console.log('wrote', name, size + 'x' + size);
}
