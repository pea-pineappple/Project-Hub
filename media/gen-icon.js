// 마켓플레이스 아이콘(256x256 PNG) 생성 — 외부 의존성 없이 zlib + 수동 PNG 인코딩
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const SS = 3; // 안티앨리어싱용 슈퍼샘플링
const BG = [27, 36, 49];
const FRONT = [127, 180, 255];
const BACK = [90, 124, 184];
const GREEN = [74, 222, 128];

// 24 그리드 SVG 좌표 → 캔버스 변환
const f = 8.8, o = 26;
const P = (x, y) => [o + x * f, o + y * f];

const backLine1 = [P(8, 2.5), P(13.5, 2.5)];
const backLine2 = [P(5.5, 5.5), P(11, 5.5), P(12.8, 7.3), P(20.5, 7.3)];
const frontPoly = [P(3, 8.5), P(8.5, 8.5), P(10.3, 10.3), P(21, 10.3), P(21, 20), P(3, 20)];
const DOT = { cx: 203, cy: 59, ring: 31, r: 23 };
const RRECT_R = 52;

function distSeg(px, py, ax, ay, bx, by) {
    const vx = bx - ax, vy = by - ay;
    const wx = px - ax, wy = py - ay;
    const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy || 1)));
    const dx = px - (ax + t * vx), dy = py - (ay + t * vy);
    return Math.hypot(dx, dy);
}

function distPolyline(px, py, pts, closed) {
    let d = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
        d = Math.min(d, distSeg(px, py, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
    }
    if (closed) {
        const a = pts[pts.length - 1], b = pts[0];
        d = Math.min(d, distSeg(px, py, a[0], a[1], b[0], b[1]));
    }
    return d;
}

function insideRoundRect(x, y) {
    const r = RRECT_R;
    const cx = Math.max(r, Math.min(SIZE - r, x));
    const cy = Math.max(r, Math.min(SIZE - r, y));
    return Math.hypot(x - cx, y - cy) <= r || (x >= r && x <= SIZE - r) || (y >= r && y <= SIZE - r)
        ? Math.hypot(x - cx, y - cy) <= r
        : false;
}

function sampleColor(x, y) {
    if (!insideRoundRect(x, y)) {
        return null;
    }
    let c = BG;
    if (distPolyline(x, y, backLine1, false) <= 6.5) c = BACK;
    if (distPolyline(x, y, backLine2, false) <= 6.5) c = BACK;
    if (distPolyline(x, y, frontPoly, true) <= 7.5) c = FRONT;
    const dDot = Math.hypot(x - DOT.cx, y - DOT.cy);
    if (dDot <= DOT.ring) c = BG;
    if (dDot <= DOT.r) c = GREEN;
    return c;
}

// 렌더링 (슈퍼샘플 평균)
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < SIZE; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let sy = 0; sy < SS; sy++) {
            for (let sx = 0; sx < SS; sx++) {
                const c = sampleColor(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
                if (c) {
                    r += c[0]; g += c[1]; b += c[2]; a += 255;
                }
            }
        }
        const n = SS * SS;
        const off = y * (SIZE * 4 + 1) + 1 + x * 4;
        const alpha = a / n;
        // straight alpha 저장 (색은 커버된 샘플 평균)
        const cov = a / 255 || 1;
        raw[off] = Math.round(r / cov);
        raw[off + 1] = Math.round(g / cov);
        raw[off + 2] = Math.round(b / cov);
        raw[off + 3] = Math.round(alpha);
    }
}

// PNG 인코딩
const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
})();
function crc32(buf) {
    let c = -1;
    for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // RGBA
const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
]);

const out = path.join(__dirname, 'icon.png');
fs.writeFileSync(out, png);
console.log('saved:', out, png.length, 'bytes');
