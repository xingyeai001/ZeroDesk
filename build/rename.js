const fs = require('fs');
const path = require('path');
const ROOT = 'D:/AI-workspace/work-buddy/002/desktop-launcher';
process.chdir(ROOT);

const edits = [
  ['src/shortcuts.js', "const APP_ID = 'com.zhudong.desktop-launcher';", "const APP_ID = 'com.zerodesk.app';"],
  ['src/shortcuts.js', 'description: `桌面分区启动器 · ${groupName}`', 'description: `Zero Desk · ${groupName}`'],
  ['src/shortcuts.js', "description: description || '桌面分区启动器 · 全部软件'", "description: description || 'Zero Desk · 全部软件'"],
  ['src/shortcuts.js', '桌面分区启动器.exe" --group=g123', 'Zero Desk.exe" --group=g123'],
  ['main.js', '用法：桌面分区启动器.exe --write-lnk', '用法：Zero Desk.exe --write-lnk'],
  ['main.js', '（electron.exe → 桌面分区启动器.exe）', '（electron.exe → Zero Desk.exe）'],
];

for (const [f, a, b] of edits) {
  let s = fs.readFileSync(f, 'utf8');
  if (!s.includes(a)) { console.log('MISS', f, '|', a.slice(0, 40)); continue; }
  fs.writeFileSync(f, s.split(a).join(b));
  console.log('OK  ', f, '|', a.slice(0, 36));
}
