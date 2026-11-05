// 开发期自测：onNativeDrag 的分支逻辑（build/ 不参与打包）
//
// 把 main.js 里的 onNativeDrag 整段切出来，用假的 startDrag / 光标 / 桌面判定跑真实代码，
// 验证"什么时候才允许把分区条目移出"。真拖拽摸不了，但分支必须锁死：
//   · 落回桌面      → 移出
//   · 落在别的程序  → 保留（2026-11-04 丢条目的元凶）
//   · 落在自己窗口里 → 排序，不移出
//   · startDrag 秒返回（没拖起来）→ 什么都不动
//
//   node build/test-dragflow.js
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const a = src.indexOf('async function onNativeDrag(');
const b = src.indexOf('async function onAppIcon(');
if (a < 0 || b < 0 || b < a) { console.error('切不出 onNativeDrag，main.js 结构变了'); process.exit(2); }

const TMP = 'C:\\Users\\x\\AppData\\Local\\Temp\\desktop-launcher-drag\\GitHub Desktop.lnk';

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)})`);
  ok ? pass++ : fail++;
};

async function run({ landed, insideCursor, dragMs, fileExists = true }) {
  const sent = [];
  const removed = [];
  const cleaned = [];
  let prepareCalls = 0;

  const g = { id: 'g1', apps: [{ name: 'GitHub Desktop', path: 'C:\\shortcuts\\abc.lnk' }] };
  const a0 = g.apps[0];

  const env = {
    fs: {
      existsSync: () => fileExists,
      unlinkSync: () => {},
      mkdirSync: () => {},
      copyFileSync: () => {}
    },
    path,
    console: { log: () => {}, error: () => {} },
    prepareDragSource: () => { prepareCalls++; return TMP; },
    dragIconFor: () => ({ getSize: () => ({ width: 64, height: 64 }) }),
    snapshotDesktop: () => new Map(),
    waitLandedOnDesktop: async () => { await new Promise((r) => setTimeout(r, 10)); return landed; },
    cleanupDragTemp: (p) => cleaned.push(p),
    removeEntry: (grp, app) => { removed.push(app.name); return { ok: true, name: app.name, state: { sentinel: true } }; },
    store: { findGroup: (id) => (id === g.id ? g : null) },
    screen: { getCursorScreenPoint: () => (insideCursor ? { x: 200, y: 200 } : { x: 1500, y: 900 }) },
    win: {
      isDestroyed: () => false,
      getContentBounds: () => ({ x: 100, y: 100, width: 780, height: 540 }),
      webContents: { send: (ch, payload) => sent.push(payload) }
    }
  };

  const e = {
    sender: {
      startDrag: () => {
        const t = Date.now();
        while (Date.now() - t < dragMs) { /* 模拟 startDrag 阻塞到松手 */ }
      }
    }
  };

  const fn = new Function(
    'fs', 'path', 'console', 'prepareDragSource', 'dragIconFor', 'snapshotDesktop',
    'waitLandedOnDesktop', 'cleanupDragTemp', 'removeEntry', 'store', 'screen', 'win',
    src.slice(a, b) + '\nreturn onNativeDrag;'
  )(env.fs, path, env.console, env.prepareDragSource, env.dragIconFor, env.snapshotDesktop,
    env.waitLandedOnDesktop, env.cleanupDragTemp, env.removeEntry, env.store, env.screen, env.win);

  await fn(e, { groupId: g.id, path: a0.path });
  return { sent, removed, cleaned, g };
}

(async () => {
  // 1. 真的落回桌面 → 移出条目
  let r = await run({ landed: true, insideCursor: false, dragMs: 300 });
  check('落回桌面：条目被移出', r.removed, ['GitHub Desktop']);
  check('落回桌面：界面收到 state', r.sent[0] && r.sent[0].state, { sentinel: true });
  check('落回桌面：没有 kept 标记', !r.sent[0].kept, true);

  // 2. 落在别的程序（聊天窗口）→ 条目必须留着
  r = await run({ landed: false, insideCursor: false, dragMs: 595 });
  check('拖到别的程序：条目保留', r.removed, []);
  check('拖到别的程序：kept=true', r.sent[0] && r.sent[0].kept, true);
  check('拖到别的程序：不下发 state（界面无需重绘）', r.sent[0].state, undefined);
  check('拖到别的程序：暂存文件照常清理', r.cleaned.length, 1);

  // 3. 落在自己窗口里 → 排序信号，不移出
  r = await run({ landed: false, insideCursor: true, dragMs: 400 });
  check('窗口内松手：不移出', r.removed, []);
  check('窗口内松手：inside=true 且带坐标', [r.sent[0].inside, r.sent[0].x, r.sent[0].y], [true, 100, 100]);

  // 4. startDrag 秒返回（拖拽没起来）→ 什么都不动
  r = await run({ landed: true, insideCursor: false, dragMs: 20 });
  check('拖拽没起来：不移出', r.removed, []);
  check('拖拽没起来：canceled=true', r.sent[0] && r.sent[0].canceled, true);

  // 5. 文件已经不存在
  r = await run({ landed: true, insideCursor: false, dragMs: 300, fileExists: false });
  check('文件不存在：报错且不移出', [r.removed.length, r.sent[0].ok, r.sent[0].msg], [0, false, '文件已不存在']);

  console.log(`\n${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})();
