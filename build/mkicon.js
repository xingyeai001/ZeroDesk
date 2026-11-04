// 生成程序图标：紫色圆角底 + 2×2 白色格子（和托盘图标同一套视觉语言）
// 纯 Node 实现（复用 src/png.js），不依赖 Electron，构建前跑一次即可。
const fs = require('fs');
const path = require('path');
const { encodePNG } = require('../src/png');

const OUT_DIR = __dirname;

function hslToRgb(h, s, l) {
  h = (((h % 360) + 360) % 360) / 360;
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

/** 圆角矩形的覆盖判定（像素中心到内缩圆心的距离） */
function inRoundRect(x, y, size, radius) {
  const r = radius;
  const cx = Math.min(Math.max(x, r), size - r);
  const cy = Math.min(Math.max(y, r), size - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** 在 4 倍超采样的画布上绘制，再降采样，得到抗锯齿边缘 */
function render(size) {
  const SS = 4;
  const W = size * SS;
  const src = Buffer.alloc(W * W * 4);

  const top = hslToRgb(262, 0.66, 0.62);
  const bottom = hslToRgb(276, 0.60, 0.46);
  const radius = W * 0.225;

  // 背景：竖向渐变 + 圆角遮罩
  for (let y = 0; y < W; y++) {
    const t = y / (W - 1);
    const r = Math.round(top[0] + (bottom[0] - top[0]) * t);
    const g = Math.round(top[1] + (bottom[1] - top[1]) * t);
    const b = Math.round(top[2] + (bottom[2] - top[2]) * t);
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (!inRoundRect(x + 0.5, y + 0.5, W, radius)) { src[i + 3] = 0; continue; }
      src[i] = r; src[i + 1] = g; src[i + 2] = b; src[i + 3] = 255;
    }
  }

  // 前景：2×2 白色圆角格
  const pad = W * 0.245;
  const gap = W * 0.052;
  const cell = (W - pad * 2 - gap) / 2;
  const cellR = cell * 0.20;
  for (let gy = 0; gy < 2; gy++) {
    for (let gx = 0; gx < 2; gx++) {
      const x0 = pad + gx * (cell + gap);
      const y0 = pad + gy * (cell + gap);
      for (let y = Math.floor(y0); y < Math.ceil(y0 + cell); y++) {
        for (let x = Math.floor(x0); x < Math.ceil(x0 + cell); x++) {
          if (x < 0 || y < 0 || x >= W || y >= W) continue;
          // 换算到格子自身的局部坐标再判圆角
          if (!inRoundRect(x + 0.5 - x0, y + 0.5 - y0, cell, cellR)) continue;
          const i = (y * W + x) * 4;
          if (src[i + 3] === 0) continue;   // 别画到圆角外面
          src[i] = 255; src[i + 1] = 255; src[i + 2] = 255; src[i + 3] = 255;
        }
      }
    }
  }

  // 降采样（预乘 alpha 平均，避免半透明边缘发黑）
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * W + (x * SS + sx)) * 4;
          const al = src[i + 3] / 255;
          r += src[i] * al; g += src[i + 1] * al; b += src[i + 2] * al; a += al;
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      if (a === 0) continue;
      out[i] = Math.round(r / a);
      out[i + 1] = Math.round(g / a);
      out[i + 2] = Math.round(b / a);
      out[i + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

/** 多尺寸 ICO：每个条目内嵌 PNG（Vista+ 支持），小尺寸也是原生绘制而非缩放 */
function buildIco(sizes) {
  const pngs = sizes.map((s) => ({ size: s, buf: encodePNG(s, s, render(s)) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);

  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const p of pngs) {
    const e = Buffer.alloc(16);
    e[0] = p.size >= 256 ? 0 : p.size;
    e[1] = p.size >= 256 ? 0 : p.size;
    e[2] = 0;
    e[3] = 0;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(p.buf.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += p.buf.length;
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.buf)]);
}

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const ico = buildIco(SIZES);
fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico);

// electron-builder 的部分目标只认 png，顺手给一张 512 的
fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), encodePNG(512, 512, render(512)));

console.log('icon.ico', (ico.length / 1024).toFixed(1) + 'KB', '尺寸', SIZES.join('/'));
console.log('icon.png 512×512');
