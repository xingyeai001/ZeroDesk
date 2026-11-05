// 开发期自测：验证「拖出后是否真的落在桌面」的判定函数（build/ 不参与打包）
//
// 直接从 main.js 里切出 desktopDirs / snapshotDesktop / waitLandedOnDesktop 三个函数，
// 用假的 app.getPath('desktop') 跑真实源码，避免抄一份副本测了个寂寞。
//
//   node build/test-landed.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const a = src.indexOf('function desktopDirs()');
const b = src.indexOf('function cleanupDragTemp');
if (a < 0 || b < 0 || b < a) { console.error('切不出函数，main.js 结构变了'); process.exit(2); }

const sandbox = path.join(os.tmpdir(), 'dl-test-desktop-' + Date.now());
fs.mkdirSync(sandbox, { recursive: true });
const publicDir = path.join(os.tmpdir(), 'dl-test-pub-' + Date.now());   // 故意不存在

const samePath = (x, y) => !!x && !!y && path.normalize(x).toLowerCase() === path.normalize(y).toLowerCase();
const app = { getPath: () => sandbox };
const fakeProcess = { env: { PUBLIC: publicDir } };

const mod = new Function('fs', 'path', 'app', 'samePath', 'process',
  src.slice(a, b) + '\nreturn { desktopDirs, snapshotDesktop, waitLandedOnDesktop };'
)(fs, path, app, samePath, fakeProcess);

const write = (name, body, mtimeOffsetMs) => {
  const p = path.join(sandbox, name);
  fs.writeFileSync(p, body);
  if (mtimeOffsetMs) fs.utimesSync(p, new Date(Date.now() + mtimeOffsetMs), new Date(Date.now() + mtimeOffsetMs));
  return p;
};

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (得到 ${got}，期望 ${want})`);
  ok ? pass++ : fail++;
};

(async () => {
  // 0. 目录扫描：只认用户桌面（公共桌面不存在时不报错）
  check('desktopDirs 只有一个存在的目录', mod.desktopDirs().length, 1);
  check('desktopDirs 指向测试桌面', mod.desktopDirs()[0], sandbox);

  // 1. 桌面上原本就有一条同名文件
  write('GitHub Desktop.lnk', 'OLD');
  write('Chrome.lnk', 'CHROME');

  // 2. 快照后：拖到聊天窗口 → 桌面毫无变化
  let before = mod.snapshotDesktop();
  check('没落地（拖到别的程序）', await mod.waitLandedOnDesktop(before, 'GitHub Desktop.lnk'), false);

  // 3. 拖到桌面 → 同名文件被系统重写（mtime 变）
  before = mod.snapshotDesktop();
  write('GitHub Desktop.lnk', 'NEW', 5000);
  check('落在桌面（同名被覆盖）', await mod.waitLandedOnDesktop(before, 'GitHub Desktop.lnk'), true);

  // 4. 拖到桌面 → 系统因重名改名成 "xxx (2).lnk"
  before = mod.snapshotDesktop();
  write('GitHub Desktop (2).lnk', 'NEW2');
  check('落在桌面（系统改成 (2)）', await mod.waitLandedOnDesktop(before, 'GitHub Desktop.lnk'), true);

  // 5. 拖到桌面 → 另一个程序在旁边新建了无关快捷方式（不该误判）
  before = mod.snapshotDesktop();
  write('WeChat.lnk', 'W');
  check('无关文件不算落地', await mod.waitLandedOnDesktop(before, 'GitHub Desktop.lnk'), false);

  // 6. 全新名字：快照后出现同名 → 落地
  before = mod.snapshotDesktop();
  write('Steam.lnk', 'S');
  check('落在桌面（全新文件）', await mod.waitLandedOnDesktop(before, 'Steam.lnk'), true);

  // 7. 名字都说不出来 → 一律不认（安全优先）
  check('无名可判 → false', await mod.waitLandedOnDesktop(new Map(), ''), false);

  fs.rmSync(sandbox, { recursive: true, force: true });
  console.log(`\n${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})();
