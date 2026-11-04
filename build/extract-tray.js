// 从 build/icon.ico 里抽出托盘要用的各档 PNG
const fs = require('fs');
const path = require('path');
const ROOT = 'D:/AI-workspace/work-buddy/002/desktop-launcher';
const ico = fs.readFileSync(path.join(ROOT, 'build/icon.ico'));
const out = path.join(ROOT, 'assets');
fs.mkdirSync(out, { recursive: true });

const n = ico.readUInt16LE(4);
const want = new Set([16, 20, 24, 32]);
for (let i = 0; i < n; i++) {
  const o = 6 + i * 16;
  const w = ico[o] || 256;
  if (!want.has(w)) continue;
  const len = ico.readUInt32LE(o + 8);
  const off = ico.readUInt32LE(o + 12);
  const png = ico.slice(off, off + len);
  fs.writeFileSync(path.join(out, `tray-${w}.png`), png);
  console.log('tray-' + w + '.png', len);
}

// 完整 ICO + 512 PNG 一起塞进包内，供主入口图标与将来重新打包使用
fs.copyFileSync(path.join(ROOT, 'build/icon.ico'), path.join(out, 'icon.ico'));
fs.copyFileSync(path.join(ROOT, 'build/icon.png'), path.join(out, 'icon.png'));
console.log('copied icon.ico / icon.png');
