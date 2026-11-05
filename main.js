// Zero Desk —— 主进程 v2
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const store = require('./src/store');
const shortcuts = require('./src/shortcuts');
const icon = require('./src/icon');
const adopt = require('./src/adopt');
const launch = require('./src/launch');

/* ---------------- 命令行维护入口 ----------------
 * 用法：Zero Desk.exe --write-lnk <输出.lnk> <target> <args> <icon|-> <cwd>
 * 为什么要有这条：手写 ShellLink 二进制时 Windows 只认 StringData（图标位置）
 * 却不认手搓的 LinkInfo/IDList（实测全部落到通用图标）。而 shell.writeShortcutLink
 * 走的就是系统同一套实现，写出来的 lnk 带完整 IDList，一定能被 Explorer 解析。
 * 只在显式带 --write-lnk 时走这里，写完立刻退出，不建窗口不进 GUI。
 */
(function cliWriteLnk() {
  // 两种形态：--write-lnk <参数...>（简单场景）
  //           --write-lnk-json <file>（参数走 JSON 文件——explorer.exe/shell: 这类
  //           内容出现在命令行上会被外部安全策略按 LOLBin 特征拦杀，实测 exit 127）
  const j = process.argv.indexOf('--write-lnk-json');
  if (j >= 0) {
    const file = process.argv[j + 1];
    try {
      const p = JSON.parse(fs.readFileSync(file, 'utf8'));
      const ok = shell.writeShortcutLink(p.out, 'replace', {
        target: p.target, args: p.args || '', cwd: p.cwd || '',
        icon: p.icon || p.target, iconIndex: 0
      });
      console.log(ok ? 'WRITE-LNK-OK' : 'WRITE-LNK-FAIL');
      process.exit(ok ? 0 : 1);
    } catch (e) {
      console.error('WRITE-LNK-ERROR', e.message);
      process.exit(1);
    }
  }
  const i = process.argv.indexOf('--write-lnk');
  if (i < 0) return;
  const [out, target, args, iconPath, cwd] = process.argv.slice(i + 1, i + 6);
  try {
    const ok = shell.writeShortcutLink(out, 'replace', {
      target, args: args || '', cwd: cwd || '',
      icon: iconPath && iconPath !== '-' ? iconPath : target,
      iconIndex: 0
    });
    console.log(ok ? 'WRITE-LNK-OK' : 'WRITE-LNK-FAIL');
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error('WRITE-LNK-ERROR', e.message);
    process.exit(1);
  }
})();

// 固定一个干净的英文 userData 目录（默认会用中文 productName 当目录名）
app.setPath('userData', path.join(app.getPath('appData'), 'desktop-launcher'));

/* ---------------- 落盘日志 ----------------
 * 打包后的 exe 是 GUI 子系统，没有 stdout —— console.log 全部丢失。
 * 一旦启动阶段抛异常（窗口不出来、桌面图标不自愈），用户看到的就是"双击没反应"，
 * 而我这边什么线索都没有。所以把 console 同时往 userData/main.log 里写一份。
 * 只保留最近 512KB，滚动一份 .1，不会无限长。
 */
const LOG_FILE = path.join(app.getPath('userData'), 'main.log');
(function teeConsole() {
  const fmt = (a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || a.message;
    try { return JSON.stringify(a); } catch (e) { return String(a); }
  };
  const write = (level, args) => {
    try {
      if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 512 * 1024) {
        try { fs.renameSync(LOG_FILE, LOG_FILE + '.1'); } catch (e) { /* 占用中就算了 */ }
      }
      fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} [${level}] ${args.map(fmt).join(' ')}\n`);
    } catch (e) { /* 日志写不进去也绝不能影响功能 */ }
  };
  ['log', 'error', 'warn'].forEach((k) => {
    const orig = console[k].bind(console);
    console[k] = (...args) => { orig(...args); write(k, args); };
  });
  logStartupBanner();
})();

function logStartupBanner() {
  try {
    fs.appendFileSync(LOG_FILE, `\n===== 启动 ${new Date().toISOString()} =====\n`
      + `版本 ${app.getVersion()}  打包=${app.isPackaged}  execPath=${process.execPath}\n`
      + `userData=${app.getPath('userData')}  desktop=${app.getPath('desktop')}\n`
      + `argv=${JSON.stringify(process.argv.slice(1))}\n`);
  } catch (e) { /* ignore */ }
}

// 仅开发态：把 userData / 桌面重定向到临时目录。
// 自动化测试要能反复建分区、删快捷方式，绝不能拿用户真实的桌面当试验场。
if (!app.isPackaged) {
  if (process.env.DL_USERDATA) app.setPath('userData', process.env.DL_USERDATA);
  if (process.env.DL_DESKTOP) app.setPath('desktop', process.env.DL_DESKTOP);
}

let win = null;
let tray = null;
let quitting = false;        // true 表示这次是真的退出，不是收进托盘
let pendingGroupId = null;   // 需要显示的分区（来自 --group=）
const iconMem = {};          // path -> dataURL
// 从"选择图片"对话框里拿到的路径白名单：renderer 不该有权让主进程去读任意磁盘文件
const pickedImages = new Set();

/* ---------------- 启动参数 ---------------- */
function parseGroupArg(argv) {
  for (const a of argv) {
    if (typeof a === 'string') {
      const m = /^--group=(.+)$/.exec(a);
      if (m) return m[1];
    }
  }
  return null;
}

/* ---------------- 单实例 ---------------- */
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  // 已经有实例在跑：把分区参数交给它，自己退出
  app.quit();
} else {
  pendingGroupId = parseGroupArg(process.argv);

  app.on('second-instance', (event, argv) => {
    const gid = parseGroupArg(argv);
    if (gid) pendingGroupId = gid;
    console.log('[second-instance] 收到唤起请求，group =', gid || '(无)');
    if (quitting) return;            // 正在退出：别把半死的窗口再拽出来

    // 窗口可能还不存在（首启没建完）或已经销毁（退出途中）。以前这里直接跳过，
    // 结果就是"双击了桌面图标，什么都没发生"。重建一个承接这次唤起。
    if (!win || win.isDestroyed()) {
      try { createWindow(); } catch (e) { console.error('[second-instance] 重建窗口失败', e); }
      return;
    }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (gid) sendGroupSwitch(gid);
  });

  app.whenReady().then(bootstrap).catch((e) => {
    // 启动阶段任何一步抛错，以前都会被 promise 吞掉，表现成"双击没反应"
    console.error('[启动失败]', e);
    try {
      dialog.showErrorBox('启动失败', `${e && (e.stack || e.message) || e}\n\n日志：${LOG_FILE}`);
    } catch (e2) { /* 对话框都弹不出来就只能靠日志了 */ }
  });

  process.on('uncaughtException', (e) => console.error('[uncaught]', e));
  process.on('unhandledRejection', (e) => console.error('[未处理的 Promise]', e));
}

/* ---------------- 初始化 ---------------- */
function bootstrap() {
  app.setAppUserModelId('com.zerodesk.app');

  store.init();
  icon.init(app.getPath('userData'));
  adopt.init(app.getPath('userData'));
  loadIconCache();
  console.log('[bootstrap] 数据层就绪，分区数 =', store.get().groups.length);

  // 配置里存了材质但系统不支持：归一回 solid，让渲染层的半透明皮肤与真实能力一致。
  // 用户在设置里再选亚克力/云母时会得到明确提示，而不是看到"假毛玻璃"。
  if ((store.get().material || 'solid') !== 'solid' && !materialSupported()) {
    console.log('[bootstrap] 系统不支持界面材质，材质设置归一为 solid');
    store.get().material = 'solid';
    store.save();
  }

  bootstrapFirstRun();      // 首启必须有分区，否则首屏是空的
  createWindow();
  console.log('[bootstrap] 窗口已创建');
  if (store.get().closeToTray) createTray();
  registerIpc();

  // 自愈 / 迁移 / 图标预热都是同步磁盘操作，软件越多越慢。
  // 先让窗口出来，这些等首屏渲染完再补，别挤在冷启动的关键路径上。
  setImmediate(async () => {
    if (quitting) return;
    let migrated = 0;
    try {
      // 改名前的老入口先正名，否则后面的迁移/自愈都还在按旧名字打转
      await migrateMainLnkName();
      if (quitting) return;
      // 先做一次性迁移：老版本留在桌面的那堆分区图标要收走，之后 repair 才不会
      // 把它们当成"该有的入口"又认领回来。
      migrated = await migrateEntryMode();
      if (quitting) return;
    } catch (e) { console.error('[bootstrap:migrate]', e); }

    try {
      repairShortcuts();
      migrateAdoptOldApps();
      gcIconFiles();
      warmIcons();
    } catch (e) { console.error('[bootstrap:deferred]', e); }

    // 界面已经开着了，得当面告诉用户桌面发生了什么，别让图标"自己消失"
    if (migrated && win && !win.isDestroyed()) {
      win.webContents.send('entry:migrated', { moved: migrated });
    }

    // 配置读坏过：明说，不要假装一切正常
    const broken = store.getBrokenBackup && store.getBrokenBackup();
    if (broken && win && !win.isDestroyed()) {
      dialog.showMessageBox(win, {
        type: 'warning',
        title: '配置曾损坏',
        message: '上次的配置文件读不出来，已经存了一份备份。',
        detail: `备份位置：\n${broken}\n\n当前是空配置。如果原来的分区很重要，把备份文件发我，可以手工恢复。`,
        buttons: ['知道了']
      });
    }
  });
}

function bootstrapFirstRun() {
  const cfg = store.get();
  if (cfg.inited) return;
  // 老版本升级上来的：已经有分区了，直接标记初始化过，不再补建
  if (cfg.groups.length) { cfg.inited = true; store.save(); return; }

  const g = {
    id: store.newId(),
    name: '我的软件',
    apps: [],
    createdAt: Date.now()
  };
  try {
    g.iconPath = icon.makeDefaultGroupIco(g.name, g.id);
  } catch (e) { console.error('默认图标生成失败', e); }

  // 单主入口模式不往桌面撒图标；分区只活在窗口的标签栏里
  if (entryMode() === 'multi') {
    try {
      const r = shortcuts.write(shortcuts.lnkPathFor(app.getPath('desktop'), g.name), {
        groupId: g.id, groupName: g.name, iconPath: g.iconPath
      });
      g.lnkPath = r.path;
    } catch (e) {
      g.lnkPath = '';
      g.lnkError = e.message;
      console.error('创建桌面快捷方式失败：', e.message);
    }
  }

  cfg.groups.push(g);
  cfg.inited = true;
  store.save();
}

/* ---------------- 补建失败过的快捷方式 ---------------- */
// 只处理"从未创建成功"的分区；用户自己删掉的桌面快捷方式不会被偷偷加回来
/**
 * 启动自愈：不仅要补"没有的"，还要修"过期了的"。
 *
 * 打包后 process.execPath 会从 electron.exe 变成 app.exe，
 * 桌面存量 .lnk 的 target 全指向旧路径，双击直接失效。早期版本这里
 * `if (g.lnkPath) return` 一跳而过，等于把自愈路堵死，只能让用户手动删图标重来。
 * 现在逐个校验 target 与 --group，不一致就整条重写。
 *
 * 但"重写"要克制，见 needTargetFix()：另一份**活着的**安装建的 lnk 不抢，
 * 否则 portable 版和安装版会互相把桌面图标改来改去，每次启动都全量重写一遍。
 */
function repairShortcuts() {
  const cfg = store.get();
  const desktop = app.getPath('desktop');
  const me = path.normalize(process.execPath).toLowerCase();
  // 桌面只扫一遍，按 --group 指纹分组。一个分区的入口"应该只有一个"，
  // 但历史上可能出现多个（见下面第 3 步），这里统一收敛。
  const lnkIndex = scanDesktopLnkIndex(desktop);
  let changed = false;

  // 单主入口模式：桌面上就不该有分区图标。切换前遗留的、从旧备份恢复回来的，
  // 一律收进回收站；然后保证唯一那个主入口在、且指向当前这份程序。
  if (entryMode() === 'single') {
    const leftovers = [];
    lnkIndex.forEach((list, gid) => {
      const known = cfg.groups.some((g) => g.id === gid);
      list.forEach((p) => { if (known || shortcuts.isOurs(p)) leftovers.push(p); });
    });
    if (leftovers.length) convergeLnks(leftovers).catch(() => {});
    cfg.groups.forEach((g) => {
      if (!g.lnkPath) return;
      if (!fs.existsSync(g.lnkPath) || !samePath(path.dirname(g.lnkPath), desktop)) {
        g.lnkPath = '';
        g.lnkError = '';
        changed = true;
      }
    });
    if (changed) store.save();
    ensureMainLnk();
    return;
  }

  ensureMainLnk();   // 多入口模式下主入口也在（它是"本程序"自己的图标）

  cfg.groups.forEach((g) => {
    const candidates = lnkIndex.get(g.id) || [];
    let alive = g.lnkPath && fs.existsSync(g.lnkPath);
    let cur = alive ? shortcuts.read(g.lnkPath) : null;

    // 1) 按记录的路径找不到：可能是用户在资源管理器里手动改了名。
    //    先在桌面按 --group 指纹认领，别急着重建成第二个图标（"工作" + "工作 - 副本"）。
    if (!alive || !cur) {
      const pick = pickBestLnk(candidates, g, desktop);
      if (pick) {
        g.lnkPath = pick;
        g.lnkError = '';
        alive = true;
        cur = shortcuts.read(pick);
        changed = true;
        console.log('[repair] 认领桌面入口:', path.basename(pick), '→', g.name,
          candidates.length > 1 ? `（桌面共有 ${candidates.length} 个同分区入口）` : '');
      }
    }

    // 2) 认领也找不到：桌面上确实没有这个分区的入口了。
    //    这里必须区分两种"没有"：
    //      a. 从来没建成过（lnkPath 为空，比如首次创建就被同名文件挡住）→ 补建
    //      b. 建成功过，现在被删/被挪走 → **尊重这个操作，不重建**。
    //    以前一律补建，于是用户把桌面上多余的图标删掉，下次打开启动器它又回来了，
    //    感受就是"删不掉"。想恢复入口走右键菜单的「重新创建桌面快捷方式」。
    //    注意：target 过期（换版本）不属于"没有"，仍由第 4 步修复。
    if (!alive) {
      if (g.lnkPath) {
        if (g.lnkError !== '桌面快捷方式已被删除') {
          g.lnkError = '桌面快捷方式已被删除';
          changed = true;
          console.log('[repair] 桌面入口已被删除，不自动重建:', g.name);
        }
        return;
      }
      try {
        const r = shortcuts.write(shortcuts.lnkPathFor(desktop, g.name), {
          groupId: g.id, groupName: g.name, iconPath: g.iconPath
        });
        g.lnkPath = r.path;
        g.lnkError = '';
        changed = true;
      } catch (e) {
        g.lnkError = e.message;
        changed = true;
      }
      return;
    }

    // 文件在，但读不出内容（损坏）：只报告，不猜、不覆盖
    if (!cur) {
      if (g.lnkError !== '桌面快捷方式读不出来') {
        g.lnkError = '桌面快捷方式读不出来';
        changed = true;
      }
      return;
    }

    // 3) 记录那条还在，但桌面上还躺着同一分区的其它入口。
    //    这就是"改个名又冒出一个图标、旧的删了下次启动又回来"的来源：
    //    旧文件本来就没人引用，而自愈逻辑一认领，它又活过来了。
    //    保留当前这条，其余进回收站（可撤销），保证一个分区一个图标。
    const extras = candidates.filter((p) => !samePath(p, g.lnkPath));
    if (extras.length) {
      console.log('[repair] 发现重复入口', extras.length, '个，保留', path.basename(g.lnkPath),
        '清理：', extras.map((p) => path.basename(p)).join(', '));
      convergeLnks(extras).catch(() => {});
    }

    // 4) 在，但 target / 参数过期：重写
    const targetFix = needTargetFix(cur.target, me);
    const argsBad = !shortcuts.groupArgRe(g.id).test(cur.args || '');
    console.log('[repair]', g.name, '| targetFix =', targetFix, '| argsBad =', argsBad, '| 现 target =', cur.target);
    if (!targetFix && !argsBad) return;

    try {
      shortcuts.write(g.lnkPath, { groupId: g.id, groupName: g.name, iconPath: g.iconPath });
      console.log('[repair] 修正过期快捷方式:', g.name, targetFix ? '(target)' : '', argsBad ? '(args)' : '');
      g.lnkError = '';
    } catch (e) {
      g.lnkError = e.message;
    }
    changed = true;
  });

  if (changed) store.save();
}

/**
 * 扫一遍桌面，按 .lnk 里的 --group 指纹分组。
 * 只读 shell.readShortcutLink，不碰文件内容；解析不出来的（损坏的、别人的）直接跳过。
 */
function scanDesktopLnkIndex(desktop) {
  const idx = new Map();
  let names = [];
  try { names = fs.readdirSync(desktop); } catch (e) { return idx; }
  for (const f of names) {
    if (!/\.lnk$/i.test(f)) continue;
    const full = path.join(desktop, f);
    const s = shortcuts.read(full);
    if (!s) continue;
    const m = /--group=([^\s"]+)/.exec(s.args || '');
    if (!m) continue;
    if (!idx.has(m[1])) idx.set(m[1], []);
    idx.get(m[1]).push(full);
  }
  return idx;
}

function samePath(a, b) {
  return !!a && !!b && path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
}

/**
 * 同一分区在桌面有多个入口时，该留哪一个？
 * 顺序：与分区名同名的那条 > 配置里记着的那条 > 第一个。
 * 用户手动改名过的场景下，"与分区名同名"就是他自己认可的那个。
 */
function pickBestLnk(candidates, g, desktop) {
  if (!candidates || !candidates.length) return '';
  const want = path.basename(shortcuts.lnkPathFor(desktop, g.name)).toLowerCase();
  return candidates.find((p) => path.basename(p).toLowerCase() === want)
    || (g.lnkPath ? candidates.find((p) => samePath(p, g.lnkPath)) : '')
    || candidates[0];
}

/** 把多余的分区入口送进回收站（可撤销，绝不永久删除） */
async function convergeLnks(paths) {
  let n = 0;
  for (const p of paths) {
    try {
      await shell.trashItem(p);
      n++;
      console.log('[converge] 多余入口已进回收站:', path.basename(p));
    } catch (e) {
      // Shell 偶尔会回报 "Operation was aborted"，但文件其实已经被移走了
      // （连着删多个 .lnk 时尤其常见）。以文件是否还在为准，别把成功报成失败。
      if (!fs.existsSync(p)) {
        n++;
        console.log('[converge] 已移除（回收站回报中止，但文件确实没了）:', path.basename(p));
      } else {
        console.error('[converge] 清理失败:', p, e.message);
      }
    }
  }
  return n;
}

/* ---------------- 桌面入口：单主入口 / 每区一个图标 ----------------
 *
 * single（默认）：桌面上只有本程序一个图标。双击它 → 窗口打开 → 顶部标签栏就是全部分区。
 *                 "0 图标桌面"的语义就靠这个：桌面不再被一堆分区 .lnk 占满。
 * multi        ：每个分区一个桌面图标（老行为），多入口派。
 *
 * 两种模式共用同一个主入口图标；区别只在于"要不要额外撒分区图标"。
 */
const MAIN_LNK_NAME = 'Zero Desk';

/**
 * 产品改名前的老名字。桌面入口还叫这些名字时，启动会自动换成新名字
 * （旧的进回收站，可撤销），否则 findMainLnk 会认回旧名，桌面永远停在旧名字上。
 */
const LEGACY_MAIN_NAMES = ['桌面分区启动器'];

function entryMode() {
  return store.get().entryMode === 'multi' ? 'multi' : 'single';
}

function mainLnkTargetPath() {
  return path.join(app.getPath('desktop'), `${MAIN_LNK_NAME}.lnk`);
}

function launcherIconPath() {
  try { return icon.makeLauncherIco(); }
  catch (e) { console.error('[main] 主入口图标生成失败', e.message); return ''; }
}

/**
 * 主入口的真身在哪。
 * 配置里的 mainLnk 只是缓存：用户可能改名、搬走、删掉。认得住的只有"target 是本程序 +
 * 不带 --group"这一条指纹，所以缓存对不上就把桌面扫一遍。
 */
function findMainLnk() {
  const cfg = store.get();
  const desktop = app.getPath('desktop');
  // 缓存必须落在"当前桌面"里。用户改过桌面位置（OneDrive 接管、换盘）时，
  // 旧路径那枚 lnk 还在磁盘上、指纹也还对得上，不加这条就会一直认着不在桌面上的文件，
  // 桌面这边反而只剩一个死图标。
  const inDesktop = (p) => {
    try { return path.normalize(path.dirname(p)).toLowerCase() === path.normalize(desktop).toLowerCase(); }
    catch (e) { return false; }
  };
  // 第一优先：配置里记着的那条。只要它还躺在桌面上、还是个"不带 --group"的入口就认，
  // **不要求 target 已经对上** —— exe 改名（桌面分区启动器 → Zero Desk）、换版本目录时，
  // target 必然过期。修 target 是 ensureMainLnk 的活儿，这里认不出来反而会让
  // 程序以为"主入口被用户删了"，把桌面留成一个点不开的死图标。
  if (cfg.mainLnk && inDesktop(cfg.mainLnk) && fs.existsSync(cfg.mainLnk)) {
    const s = shortcuts.read(cfg.mainLnk);
    if (s && s.target && !/--group=/.test(s.args || '')) return cfg.mainLnk;
  }

  let names = [];
  try { names = fs.readdirSync(desktop); } catch (e) { return ''; }
  const hits = [];
  for (const f of names) {
    if (!/\.lnk$/i.test(f)) continue;
    const full = path.join(desktop, f);
    if (shortcuts.isMain(full)) hits.push(full);
  }
  if (!hits.length) return '';
  const want = path.basename(mainLnkTargetPath()).toLowerCase();
  return hits.find((p) => path.basename(p).toLowerCase() === want) || hits[0];
}

/**
 * 保证桌面上那个唯一入口在、且指向当前这份程序。
 * @param {boolean} force true = 用户明确点了"重建"，即使之前判定"被删掉了"也重建
 */
function ensureMainLnk(force) {
  const cfg = store.get();
  const existing = findMainLnk();

  if (existing) {
    const cur = shortcuts.read(existing);
    const me = path.normalize(process.execPath).toLowerCase();
    cfg.mainLnk = existing;
    cfg.mainLnkError = '';
    // 打包升级后 execPath 会变（electron.exe → Zero Desk.exe），lnk 会变成死链。
    // 这里跟分区入口共用同一套判定：别人还活着就别抢。
    //
    // 图标也得比对：产品换图标后 ico 是**带内容指纹的新文件名**，
    // 只修 target 的话桌面会继续显示旧图标（甚至指向已被回收的旧文件 → 白图）。
    const wantIcon = launcherIconPath();
    const curIcon = cur && cur.icon ? expandEnvPath(String(cur.icon).replace(/,\s*-?\d+$/, '')) : '';
    const iconStale = !!wantIcon && path.normalize(curIcon || '').toLowerCase()
      !== path.normalize(wantIcon).toLowerCase();
    if (cur && (needTargetFix(cur.target, me) || iconStale)) {
      try {
        // force：这条路径是 findMainLnk 认出来的主入口，就地覆盖。
        // 不加的话 writeMain 会因为"target 对不上"判定成别人的文件，另存成 Zero Desk-2.lnk。
        const r = shortcuts.writeMain(existing, { iconPath: wantIcon, force: true });
        if (r && r.path) cfg.mainLnk = r.path;
        console.log('[main] 修正主入口:', path.basename(existing), iconStale ? '(图标已更新)' : '');
      } catch (e) { cfg.mainLnkError = e.message; }
    }
    store.save();
    return { ok: true, path: existing };
  }

  // 曾经建过、现在没了 = 用户自己删的。**尊重这个操作**，不偷偷复活，
  // 想恢复走设置里的「重建桌面主入口」。
  // 只在"这条记录本来就在当前桌面里"时才算数：换过桌面位置的老记录不代表用户删过图标。
  const recordedOnDesktop = !!cfg.mainLnk
    && path.normalize(path.dirname(cfg.mainLnk)).toLowerCase() === path.normalize(app.getPath('desktop')).toLowerCase();
  if (recordedOnDesktop && !force) {
    if (cfg.mainLnkError !== '桌面主入口已被删除') {
      cfg.mainLnkError = '桌面主入口已被删除';
      store.save();
      console.log('[main] 主入口已被删除，不自动重建');
    }
    return { ok: false, msg: '桌面主入口已被删除' };
  }

  try {
    const r = shortcuts.writeMain(mainLnkTargetPath(), { iconPath: launcherIconPath() });
    cfg.mainLnk = r.path;
    cfg.mainLnkError = '';
    store.save();
    console.log('[main] 主入口已创建:', path.basename(r.path));
    return { ok: true, path: r.path };
  } catch (e) {
    cfg.mainLnkError = e.message;
    store.save();
    console.error('[main] 创建主入口失败:', e.message);
    return { ok: false, msg: e.message };
  }
}

/**
 * 改名迁移：桌面上还挂着老名字的主入口（桌面分区启动器.lnk）时，换成 Zero Desk.lnk。
 * 先按新名字建一份，再把旧的送进回收站 —— 顺序不能反，中途失败也不能出现"一个都没有"。
 * 新名已被占用（用户自己建过 / 上次中途失败）时不覆盖，只收旧的。
 */
async function migrateMainLnkName() {
  const desktop = app.getPath('desktop');
  const target = mainLnkTargetPath();
  const olds = [];
  for (const n of LEGACY_MAIN_NAMES) {
    const p = path.join(desktop, `${n}.lnk`);
    if (path.basename(p).toLowerCase() === path.basename(target).toLowerCase()) continue;
    if (fs.existsSync(p) && shortcuts.isMain(p)) olds.push(p);
  }
  if (!olds.length) return 0;

  if (!fs.existsSync(target)) {
    try {
      shortcuts.writeMain(target, { iconPath: launcherIconPath() });
      console.log('[main] 改名：已创建', path.basename(target));
    } catch (e) {
      // 新名字建不出来（桌面只读/权限），宁可留着旧的，也不能让桌面一个入口都没有
      console.error('[main] 改名失败，保留旧入口:', e.message);
      return 0;
    }
  }

  let n = 0;
  for (const p of olds) {
    try {
      await shell.trashItem(p);
      n++;
      console.log('[main] 改名：旧入口已进回收站', path.basename(p));
    } catch (e) {
      // trashItem 会谎报 "Operation was aborted"，以文件还在不在为准
      if (!fs.existsSync(p)) n++;
      else console.error('[main] 旧入口收走失败:', e.message);
    }
  }
  const cfg = store.get();
  if (fs.existsSync(target)) { cfg.mainLnk = target; cfg.mainLnkError = ''; store.save(); }
  return n;
}

/**
 * 把桌面上所有分区入口收进回收站（可撤销）。
 * 只认带 `--group=` 的 .lnk；分区已删除、图标却赖在桌面上那种历史残留也一并收走。
 */
async function trashAllGroupLnks(reason) {
  const desktop = app.getPath('desktop');
  const cfg = store.get();
  const idx = scanDesktopLnkIndex(desktop);

  const doomed = [];
  idx.forEach((list, gid) => {
    const known = cfg.groups.some((g) => g.id === gid);
    list.forEach((p) => {
      // 分区还在：确定是我们的，收。
      // 分区已不存在：入口是我们建的才会带 --group，但为了不误伤别人，
      // 只收 target 确实指向本程序的那些。
      if (known || shortcuts.isOurs(p)) doomed.push(p);
    });
  });

  let n = 0;
  for (const p of doomed) {
    try { await shell.trashItem(p); n++; }
    catch (e) {
      // 同上：Shell 可能回报 "Operation was aborted"，而文件其实已经进回收站了。
      // 以"文件还在不在"为准，否则界面上会报一个假的失败数。
      if (!fs.existsSync(p)) { n++; console.log('[main] 已移除（回收站回报中止，但文件确实没了）:', path.basename(p)); }
      else console.error('[main] 收走分区图标失败', path.basename(p), e.message);
    }
  }

  // 记录同步清空：以后若切回多入口模式，repair 会按"从没建过"重新补出来。
  // 只在文件真的没了（或者压根不在这个桌面上）时清；删失败的保留记录，下次启动接着收拾。
  let changed = false;
  cfg.groups.forEach((g) => {
    if (!g.lnkPath) return;
    const gone = !fs.existsSync(g.lnkPath);
    const elsewhere = !samePath(path.dirname(g.lnkPath), desktop);
    if (gone || elsewhere) { g.lnkPath = ''; g.lnkError = ''; changed = true; }
  });
  if (changed) store.save();
  if (n) console.log(`[main] ${reason}：${n} 个分区图标已进回收站`);
  return n;
}

/** 切回多入口模式：给每个分区把桌面图标补回来 */
function ensureGroupLnks() {
  const cfg = store.get();
  const desktop = app.getPath('desktop');
  let n = 0;
  cfg.groups.forEach((g) => {
    const existing = pickBestLnk(shortcuts.findAllByGroup(desktop, g.id), g, desktop);
    if (existing) { g.lnkPath = existing; g.lnkError = ''; return; }
    try {
      const r = shortcuts.write(shortcuts.lnkPathFor(desktop, g.name), {
        groupId: g.id, groupName: g.name, iconPath: g.iconPath
      });
      g.lnkPath = r.path;
      g.lnkError = '';
      n++;
    } catch (e) { g.lnkError = e.message; }
  });
  store.save();
  return n;
}

/** 老配置升级到单主入口：桌面那堆分区图标只收一次 */
async function migrateEntryMode() {
  const cfg = store.get();
  if (cfg.entryMigrated) return 0;
  cfg.entryMigrated = true;
  store.save();
  if (entryMode() !== 'single') return 0;
  return trashAllGroupLnks('升级为单主入口');
}

/** 展环境变量：lnk 的 target 可能是 %SystemRoot%\... 或者别的 %VAR% */
function expandEnvPath(p) {
  return String(p || '').replace(/%([^%]+)%/g, (m, k) => process.env[k] || m);
}

/**
 * 这个 lnk 的 target 需要改成当前进程吗？
 *
 * 关键规则：**别人还活着就别抢。** 同一份 userData 被安装版 + portable 版共用时，
 * 谁后启动谁就把所有 lnk 的 target 改成自己 —— 用户交替用两个版本，桌面图标就永远
 * 在两边来回翻转，每次启动都要全量重写一遍。target 指向的 exe 还存在，说明那份
 * 安装是能用的，保持它，只校验参数。
 *
 * 唯一的例外：我现在是打包版，而 lnk 指的还是一个活着的 electron.exe（开发态），
 * 那正是"打包升级"的场景，必须接管，否则用户会以为打包没生效。
 */
function needTargetFix(curTarget, meLower) {
  const raw = expandEnvPath(curTarget || '');
  if (!raw) return true;                       // 没 target：必须写
  const t = path.normalize(raw).toLowerCase();
  if (t === meLower) return false;             // 就是我
  let alive = false;
  try { alive = fs.existsSync(raw); } catch (e) { alive = false; }
  if (!alive) return true;                     // 死链（卸载/挪走了旧 exe）：接管
  if (app.isPackaged && /[\\/]electron\.exe$/.test(t)) return true;  // 开发态 → 打包版
  return false;                                // 另一份活着的安装：不动它
}

/** icons/ 里都是可再生的衍生文件：清掉没人引用的，别让它们攒几年 */
function gcIconFiles() {
  // 配置读坏过的时候 groups 是空的 —— 这时清理等于把用户的图标全删了，跳过
  if (store.getBrokenBackup && store.getBrokenBackup()) return;
  const cfg = store.get();
  if (!cfg.groups.length) return;
  const refs = [];
  cfg.groups.forEach((g) => {
    if (g.iconPath) refs.push(g.iconPath);
    (g.apps || []).forEach((a) => { if (a.iconFile) refs.push(a.iconFile); });
  });
  try {
    const n = icon.gcIcons(refs);
    if (n) console.log('[gc] 清理无主图标文件', n, '个');
  } catch (e) { console.error('[gc]', e.message); }
}

/**
 * 老数据迁移：早期版本把桌面 .lnk 的原始路径直接存进了配置，
 * 一旦桌面图标被删，分区里的条目就跟着失效。
 * 这里把它们逐个收养成副本，之后桌面怎么清都不影响。
 */
function migrateAdoptOldApps() {
  const cfg = store.get();
  let changed = false;

  cfg.groups.forEach((g) => {
    (g.apps || []).forEach((a) => {
      // 老条目没有 fromDesktop 字段。以前运行时按"来自桌面"兜底，结果是老用户每次
      // 移除都会撞上三选对话框 —— 明明是从开始菜单收来的。这里一次性判定并落盘。
      if (a.fromDesktop === undefined && a.orig) {
        a.fromDesktop = adopt.isOnDesktop(a.orig);
        changed = true;
      }
      if (!adopt.isShortcut(a.path)) return;
      if (adopt.isAdopted(a.path)) return;
      if (!fs.existsSync(a.path)) return;   // 文件已经没了，留给界面显示失效
      const stored = adopt.adopt(a.path);
      if (stored && stored !== a.path) {
        if (iconMem[a.path] && !iconMem[stored]) iconMem[stored] = iconMem[a.path];
        a.path = stored;
        changed = true;
      }
    });
  });

  if (changed) { store.save(); saveIconCache(); }
  return changed;
}

/* ---------------- 图标缓存 ---------------- */
function iconCacheFile() {
  return path.join(app.getPath('userData'), 'icons.json');
}

function loadIconCache() {
  try {
    Object.assign(iconMem, JSON.parse(fs.readFileSync(iconCacheFile(), 'utf8')));
  } catch (e) { /* 首次没有缓存 */ }
}

function saveIconCache(extraPaths) {
  try {
    // 只留还在分区里的条目：删掉的软件不再永久占着缓存（数据 URL 很占地方）
    const alive = new Set();
    store.get().groups.forEach((g) => g.apps.forEach((a) => alive.add(a.path)));
    // 关键：collectApps() 取完图标时，这批 app 还**没写进 store**。
    // 以前这里只认 store 里的 path，于是刚抓好的一批图标被判成"没人引用"当场删掉，
    // 内存和磁盘同时清零 —— 表现就是"加完一大堆软件，全是字母占位，重开也一样"
    // （磁盘里永远只有以前单独加的那几个）。必须把在途的 path 一并放行。
    (extraPaths || []).forEach((p) => { if (p) alive.add(p); });

    Object.keys(iconMem).forEach((k) => { if (!alive.has(k)) delete iconMem[k]; });

    // 和 config.json 一样走原子写，别在强杀时留半截 JSON
    const f = iconCacheFile();
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(iconMem), 'utf8');
    fs.renameSync(tmp, f);
  } catch (e) { console.error('图标缓存写入失败', e); }
}

/* ---------------- 补齐 / 重抓 图标 ---------------- */
/**
 * @param {boolean} force true = 无视已有缓存全部重抓（设置里的"重新抓取图标"用它）
 */
async function warmIcons(force) {
  const queue = [];
  for (const g of store.get().groups) {
    for (const a of g.apps) {
      if (force) delete iconMem[a.path];      // 旧的可能就是张白纸，必须清掉再取
      else if (iconMem[a.path]) continue;
      if (!fs.existsSync(a.path)) continue;
      queue.push(a.path);
    }
  }
  if (!queue.length) return { total: 0, ok: 0 };

  // 串行取图标时，20 个软件要等 20 次 getFileIcon；图标一个个往外蹦，很难看。
  // 8 路并发足够喂饱 io，又不会把主进程的 native 调用挤死。
  const CONCURRENCY = 8;
  let cursor = 0;
  let ok = 0;
  const flush = () => {
    saveIconCache();
    if (win && !win.isDestroyed()) win.webContents.send('icons:updated');
  };

  const worker = async () => {
    while (cursor < queue.length) {
      const p = queue[cursor++];
      try {
        const d = await icon.appIconDataURL(p);
        if (d) { iconMem[p] = d; ok++; }
      } catch (e) { /* 单个失败不影响其他 */ }
      // 每 6 个落一次盘：以前只在全部跑完后写一次，用户中途关窗口就全丢，
      // 下次启动又从零开始，永远补不齐。
      if (ok && ok % 6 === 0) flush();
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));

  flush();
  console.log(`[icons] 抓取 ${queue.length} 个，成功 ${ok} 个${force ? '（强制重抓）' : ''}`);
  return { total: queue.length, ok };
}

/* ---------------- 托盘 ---------------- */
function createTray() {
  try {
    const img = icon.makeTrayImage();
    tray = new Tray(img && !img.isEmpty() ? img : nativeImage.createEmpty());
    tray.setToolTip('Zero Desk');
    tray.on('click', () => showWindow());
    tray.on('double-click', () => showWindow());
    refreshTrayMenu();
  } catch (e) {
    console.error('托盘创建失败（不影响主功能）', e);
    tray = null;
  }
}

function refreshTrayMenu() {
  if (!tray) return;
  const cfg = store.get();
  const items = [
    { label: '打开窗口', click: () => showWindow() },
    { type: 'separator' }
  ];
  if (cfg.groups.length) {
    cfg.groups.forEach((g) => {
      items.push({
        label: g.name + (g.apps.length ? `　(${g.apps.length})` : ''),
        click: () => switchTo(g.id)
      });
    });
  } else {
    items.push({ label: '（还没有分区）', enabled: false });
  }
  items.push({ type: 'separator' });
  items.push({
    label: '退出',
    click: () => { quitting = true; app.quit(); }
  });

  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function showWindow() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function switchTo(id) {
  pendingGroupId = id;
  showWindow();
  sendGroupSwitch(id);
}

/**
 * 通知渲染层切分区。
 * 窗口刚建好、页面还在加载时直接 send 会被丢掉（ipcRenderer.on 是订阅式，没有回放），
 * 表现为"双击了 B 分区，窗口却停在 A"。所以加载中就先排队，等 did-finish-load。
 */
function sendGroupSwitch(id) {
  if (!id || !win || win.isDestroyed()) return;
  const wc = win.webContents;
  if (wc.isLoading()) {
    wc.once('did-finish-load', () => {
      if (win && !win.isDestroyed()) win.webContents.send('group:switch', id);
    });
    return;
  }
  wc.send('group:switch', id);
}

/* ---------------- 窗口 ---------------- */
/* 亚克力/云母（DWMWA_SYSTEMBACKDROP_TYPE）需要 Win11 22H2（build 22621）起。
   以前只有一句"系统不支持时会自动回退"的提示文案，回退逻辑根本不存在——
   旧系统上窗口会变半透明却没有任何毛玻璃，如今真正补上。 */
function materialSupported() {
  try {
    const build = parseInt(String(os.release()).split('.')[2] || '0', 10);
    return build >= 22621;
  } catch (e) { return false; }
}

function applyMaterial() {
  if (!win || win.isDestroyed()) return;
  const m = store.get().material || 'solid';
  try {
    if (typeof win.setBackgroundMaterial === 'function') {
      const effective = (m !== 'solid' && materialSupported()) ? m : 'none';
      win.setBackgroundMaterial(effective);
    }
  } catch (e) { /* 老系统不支持就静默回退 */ }
}

/**
 * 把记住的坐标夹回可见区域。
 * 用户上次双屏用、副屏在右边；这次拔掉副屏 → 窗口还开在 (2560, 300)，
 * 主屏看不到，任务栏也点不出来（frame:false），用户只会以为"程序没启动"。
 */
function clampToVisible(b) {
  let displays = [];
  try { displays = screen.getAllDisplays(); } catch (e) { displays = []; }
  const visible = displays.some((d) => {
    const wa = d.workArea;
    return b.x >= wa.x - b.width + 80 && b.x < wa.x + wa.width - 80
      && b.y >= wa.y - 40 && b.y < wa.y + wa.height - 80;
  });
  if (visible || !displays.length) return b;
  const wa = (screen.getPrimaryDisplay && screen.getPrimaryDisplay().workArea)
    || { x: 0, y: 0, width: 1280, height: 800 };
  return {
    ...b,
    x: Math.round(wa.x + Math.max(0, (wa.width - b.width) / 2)),
    y: Math.round(wa.y + Math.max(0, (wa.height - b.height) / 2))
  };
}

function createWindow() {
  const cfg = store.get();
  const w = cfg.win || {};

  const size = { width: w.width || 780, height: w.height || 540 };
  const bounds = Number.isFinite(w.x) && Number.isFinite(w.y)
    ? clampToVisible({ ...size, x: w.x, y: w.y })
    : size;

  // 任务栏 / Alt+Tab 用的是这个图标。不写的话 Electron 退回 exe 内嵌图标，
  // 换产品图标时就会「桌面是新的、任务栏还是旧的」。
  // 走 nativeImage 而不是直接给路径：asar 内的路径交给 createFromPath 更稳妥，
  // 拿不到时传 undefined，退回 exe 图标，不至于让窗口创建失败。
  const winIcon = nativeImage.createFromPath(path.join(app.getAppPath(), 'assets', 'icon.png'));

  win = new BrowserWindow({
    ...bounds,
    minWidth: 560,
    minHeight: 420,
    frame: false,
    roundedCorners: true,
    icon: winIcon.isEmpty() ? undefined : winIcon,
    // 全透明底：亚克力/云母材质画在窗口表面后面，这里不透明就永远透不出来。
    // 纯色模式下渲染层的 body 会铺实色，观感不变。
    backgroundColor: '#00000000',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  // 明确不置顶（需求：不要默认置顶）
  win.setAlwaysOnTop(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    win.show();
    win.focus();
    applyMaterial();
  });

  // 拖动/缩放窗口时 Windows 会连续触发 moved，一次拖动就是几十次"全量 JSON + 原子写"。
  // 防抖到 400ms，并且跳过最大化（最大化的 bounds 不是用户想要的记忆尺寸）。
  let rememberTimer = null;
  const rememberNow = () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMaximized() || win.isMinimized()) return;
    const b = win.getBounds();
    if (!Number.isFinite(b.width) || !Number.isFinite(b.height)) return;
    cfg.win = { width: b.width, height: b.height, x: b.x, y: b.y };
    store.save();
  };
  const remember = () => {
    clearTimeout(rememberTimer);
    rememberTimer = setTimeout(rememberNow, 400);
  };
  win.on('moved', remember);
  win.on('resized', remember);

  // 最大化状态变化：双击标题栏、Win+↑、系统贴靠都会走这里，界面据此切按钮图标
  const sendMax = () => {
    if (!win || win.isDestroyed()) return;
    const v = win.isMaximized();
    try { win.webContents.send('window:maximized', v); } catch (e) { /* 页面还没就绪 */ }
  };
  win.on('maximize', sendMax);
  win.on('unmaximize', sendMax);
  win.webContents.on('did-finish-load', sendMax);

  // 点窗口的 X / Alt+F4：按设置决定是收进托盘还是真退出
  win.on('close', (e) => {
    if (quitting) {
      // 关窗前把最后一帧窗口位置落盘（防抖里没来得及写的）
      clearTimeout(rememberTimer);
      rememberNow();
      return;
    }
    // 必须同时要求"托盘真的存在"：托盘创建失败时 closeToTray 还是 true，
    // 窗口一 hide 就彻底没有入口能唤回来了（任务栏没有、托盘没有、进程活着）。
    if (store.get().closeToTray && tray) {
      e.preventDefault();
      win.hide();
      return;
    }
    clearTimeout(rememberTimer);
    rememberNow();
  });

  win.on('closed', () => { win = null; });

  // ---- 以下全是开发期调试钩子，打包后一律不生效 ----
  // 原因：WIDGET_SHOT_JS_FILE 会执行任意 JS，而渲染层通过 preload 拿到 launch/removeApp，
  // 等于"能设环境变量的人 = 能跑任意代码"。生产版必须关掉这扇门。
  const DEBUG = !app.isPackaged;

  if (DEBUG && process.env.WIDGET_AUTOQUIT) {
    setTimeout(() => { quitting = true; app.quit(); }, Number(process.env.WIDGET_AUTOQUIT) * 1000);
  }

  if (DEBUG && process.env.WIDGET_SHOT) {
    win.webContents.once('did-finish-load', async () => {
      // 脚本立即注入（不等截图延时），便于测试"点击后是否退出"这类行为
      const script = process.env.WIDGET_SHOT_JS_FILE
        ? fs.readFileSync(process.env.WIDGET_SHOT_JS_FILE, 'utf8')
        : process.env.WIDGET_SHOT_JS;
      if (script) {
        try {
          const ret = await win.webContents.executeJavaScript(script);
          // executeJavaScript 的返回值单独打出来，测试脚本靠它回传结果
          if (ret !== undefined) console.log('[test]', typeof ret === 'string' ? ret : JSON.stringify(ret));
        }
        catch (e) { console.error('[shot:js]', e.message); }
      }
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(process.env.WIDGET_SHOT, img.toPNG());
          console.log('[shot] saved');
        } catch (e) { console.error('[shot]', e); }
        quitting = true;
        app.quit();
      }, Number(process.env.WIDGET_SHOT_DELAY || 2400));
    });
  }
}

app.on('before-quit', () => {
  quitting = true;
  // Windows 上进程直接退出而不 destroy 托盘图标，通知区域会留一个"幽灵图标"，
  // 要等鼠标划过去才消失。
  if (tray) {
    try { tray.destroy(); } catch (e) { /* ignore */ }
    tray = null;
  }
});

// 不留后台：最后一个窗口关掉就退出（"收进托盘"模式下窗口是 hide，不会走到这里）
app.on('window-all-closed', () => { quitting = true; app.quit(); });

/* ---------------- 序列化 ---------------- */
// 图标 dataURL 缓存：每次 state:get 都重新 readFileSync + base64，改个图标/拖个排序都要
// 把十几个 PNG 从头读一遍。按 mtime 命中，文件变了才重读。
const fileDataCache = new Map();   // 绝对路径 -> { mtime, mime, url }

function dataUrlOfFile(file, mime) {
  try {
    const st = fs.statSync(file);
    const hit = fileDataCache.get(file);
    if (hit && hit.mtime === st.mtimeMs && hit.mime === mime) return hit.url;
    const url = `data:${mime};base64,` + fs.readFileSync(file).toString('base64');
    if (fileDataCache.size > 400) fileDataCache.clear();   // 防无界增长
    fileDataCache.set(file, { mtime: st.mtimeMs, mime, url });
    return url;
  } catch (e) { return null; }
}

function serializeGroup(g) {
  const iconData = g.iconPath && fs.existsSync(g.iconPath)
    ? dataUrlOfFile(g.iconPath, 'image/x-icon')
    : null;

  return {
    id: g.id,
    name: g.name,
    iconData,
    lnkPath: g.lnkPath || '',
    lnkError: g.lnkError || '',
    lnkExists: !!(g.lnkPath && fs.existsSync(g.lnkPath)),
    apps: g.apps.map((a) => ({
      name: a.name,
      path: a.path,
      icon: (a.iconFile && fs.existsSync(a.iconFile))
        ? dataUrlOfFile(a.iconFile, 'image/png')
        : (iconMem[a.path] || null),
      customIcon: !!a.iconFile,
      exists: fs.existsSync(a.path),
      // 字母占位的颜色由主进程算，免得界面上分区图标是紫的、占位字是青的
      hue: icon.hueOf(a.name),
      // 能"放回桌面"的前提：是收养的副本 + 当初就来自桌面。
      // 少了后半个条件，从开始菜单拖进来的条目也会显示"放回桌面"，
      // 一点就在桌面凭空长出个图标 —— 正是 collectApps 注释里说要避免的事。
      canRestore: adopt.isShortcut(a.path) && adopt.isAdopted(a.path) && a.fromDesktop === true
    }))
  };
}

function serializeState() {
  const cfg = store.get();
  const first = cfg.groups[0];
  const current = (pendingGroupId && cfg.groups.some((g) => g.id === pendingGroupId))
    ? pendingGroupId
    : (first ? first.id : null);

  return {
    groups: cfg.groups.map(serializeGroup),
    currentGroupId: current,
    settings: {
      theme: cfg.theme || 'system',
      material: cfg.material || 'solid',
      closeToTray: !!cfg.closeToTray,
      cleanDesktopOnAdd: cfg.cleanDesktopOnAdd,
      iconSize: cfg.iconSize || 'm',
      entryMode: entryMode(),
      mainLnkExists: !!(cfg.mainLnk && fs.existsSync(cfg.mainLnk)),
      mainLnkError: cfg.mainLnkError || ''
    }
  };
}

/* ---------------- 分区操作 ---------------- */
function nameTaken(name, exceptId) {
  const n = name.toLowerCase();
  return store.get().groups.some((g) => g.id !== exceptId && g.name.toLowerCase() === n);
}

function createGroup(name, iconSrc) {
  const cfg = store.get();
  const clean = shortcuts.sanitizeName(name);
  if (!clean) return { ok: false, msg: '分区名不能为空' };
  if (nameTaken(clean)) return { ok: false, msg: `已经有叫「${clean}」的分区了` };
  // iconSrc 来自渲染层。只认"用户刚在系统对话框里亲手选的那个文件"，
  // 否则 renderer 一旦被攻破，就能让主进程把任意磁盘图片读成 ICO 再以 dataURL 吐回来。
  if (iconSrc && !pickedImages.has(iconSrc)) {
    return { ok: false, msg: '图标必须通过「选择图标图片」按钮选取' };
  }

  const g = { id: store.newId(), name: clean, apps: [], createdAt: Date.now() };

  try {
    g.iconPath = iconSrc
      ? icon.imageToIco(iconSrc, `group-${g.id}`)
      : icon.makeDefaultGroupIco(g.name, g.id);
  } catch (e) {
    return { ok: false, msg: '图标处理失败：' + e.message };
  }

  // 单主入口模式：桌面不新增任何图标，分区只出现在窗口的标签栏里
  if (entryMode() === 'multi') {
    try {
      const r = shortcuts.write(shortcuts.lnkPathFor(app.getPath('desktop'), g.name), {
        groupId: g.id, groupName: g.name, iconPath: g.iconPath
      });
      g.lnkPath = r.path;
    } catch (e) {
      // 桌面已有同名快捷方式（别人的），不覆盖。刚写出来的图标文件也就没人引用了，顺手清掉。
      if (g.iconPath && iconSrc) {
        try { fs.unlinkSync(g.iconPath); } catch (e2) { /* ignore */ }
        fileDataCache.delete(g.iconPath);
      }
      return { ok: false, msg: e.message };
    }
  }

  cfg.groups.push(g);
  store.save();
  pendingGroupId = g.id;
  refreshTrayMenu();
  return { ok: true, state: serializeState() };
}

/**
 * 桌面入口的真身到底在哪。
 *
 * 配置里的 `lnkPath` 只是一份缓存，用户随时可能在资源管理器里改名、搬走、删掉；
 * 一旦它和真实文件名对不上，任何"存在就改、不存在就建"的逻辑都会做出错误决定：
 * 桌面凭空多一个图标，旧的那个再没人引用 —— 用户看到的就是
 * "改个名又冒出一个，把原来那个删了，下次打开它又回来了"。
 * 所以以 `--group` 指纹在桌面上找出来的文件为准。
 */
function locateGroupLnk(g) {
  const desktop = app.getPath('desktop');
  const candidates = shortcuts.findAllByGroup(desktop, g.id);
  const pick = pickBestLnk(candidates, g, desktop);
  return { desktop, candidates, pick };
}

/**
 * 用户明确要求"再给我建一个桌面入口"。
 * 与 repairShortcuts 的自动补建区分开：自动补建只在"从来没建成过"时做，
 * 这里则是用户在界面上主动点的，可以放心重写。
 */
function restoreGroupLnk(id) {
  if (entryMode() === 'single') {
    return { ok: false, msg: '现在是单一主入口模式，桌面只保留一个图标；需要分区图标请先在设置里切换模式' };
  }
  const g = store.get().groups.find((x) => x.id === id);
  if (!g) return { ok: false, msg: '分区不存在' };

  const desktop = app.getPath('desktop');
  try {
    const existing = pickBestLnk(shortcuts.findAllByGroup(desktop, g.id), g, desktop);
    if (existing) {
      g.lnkPath = existing;
    } else {
      const r = shortcuts.write(shortcuts.lnkPathFor(desktop, g.name), {
        groupId: g.id, groupName: g.name, iconPath: g.iconPath
      });
      g.lnkPath = r.path;
    }
  } catch (e) {
    g.lnkError = e.message;
    store.save();
    return { ok: false, msg: e.message };
  }

  g.lnkError = '';
  store.save();
  const extras = shortcuts.findAllByGroup(desktop, g.id).filter((p) => !samePath(p, g.lnkPath));
  if (extras.length) convergeLnks(extras).catch(() => {});
  return { ok: true, state: serializeState() };
}

async function renameGroup(id, name) {
  const cfg = store.get();
  const g = cfg.groups.find((x) => x.id === id);
  if (!g) return { ok: false, msg: '分区不存在' };

  const clean = shortcuts.sanitizeName(name);
  if (!clean) return { ok: false, msg: '分区名不能为空' };
  if (clean === g.name) return { ok: true, state: serializeState() };
  if (nameTaken(clean, id)) return { ok: false, msg: `已经有叫「${clean}」的分区了` };

  // 单主入口模式：桌面没有分区图标可改名，只改分区名（标签栏上的名字）
  if (entryMode() === 'single') {
    g.name = clean;
    g.lnkPath = '';
    g.lnkError = '';
    store.save();
    refreshTrayMenu();
    return { ok: true, state: serializeState() };
  }

  const { desktop, candidates, pick } = locateGroupLnk(g);
  const newLnk = shortcuts.lnkPathFor(desktop, clean);

  let warn = '';
  try {
    if (pick) {
      // 认桌面上真实存在的那条来改名，而不是凭 g.lnkPath 猜
      console.log('[rename]', path.basename(pick), '→', path.basename(newLnk));
      const r = await shortcuts.rename(pick, newLnk, clean, g.id, g.iconPath);
      if (r && r.warn) warn = r.warn;
    } else if (!g.lnkPath) {
      // 从来没建成过（比如首建就被同名文件挡住）：顺手补上
      shortcuts.write(newLnk, { groupId: g.id, groupName: clean, iconPath: g.iconPath });
    } else {
      // 建成功过、现在桌面没有 = 用户删掉了。改名不该偷偷把它复活，
      // 保持"没有桌面入口"这个状态，只改分区名。
      warn = '桌面快捷方式已被删除';
    }
  } catch (e) {
    return { ok: false, msg: e.message };
  }

  g.name = clean;
  g.lnkPath = newLnk;
  g.lnkError = warn;
  store.save();

  // 搬家之后桌面上若还留着同分区的旧入口（历史错位攒下的），一并收敛。
  // 这步必须在 state 保存之后做：收敛失败也不能把改名结果回滚掉。
  const extras = shortcuts.findAllByGroup(desktop, g.id).filter((p) => !samePath(p, newLnk));
  if (extras.length) await convergeLnks(extras);

  refreshTrayMenu();
  if (warn) console.warn('[rename]', warn);
  return { ok: true, state: serializeState(), warn };
}

async function setGroupIcon(id) {
  const cfg = store.get();
  const g = cfg.groups.find((x) => x.id === id);
  if (!g) return { ok: false, msg: '分区不存在' };

  const r = await dialog.showOpenDialog(win, {
    title: '选择分区图标',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'ico', 'webp'] }]
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };

  try {
    // 文件名必须每次不同：Windows 图标缓存按「路径」缓存，固定名覆盖内容的话，
    // 桌面 lnk 虽然指对了文件，Explorer 仍然喂缓存的旧图 → 里外图标不一致。
    // 用带时间戳的新文件名逼它重新读图；旧的无主 .ico 由 gcIcons 统一回收。
    const ico = icon.imageToIco(r.filePaths[0], `group-${g.id}-${Date.now()}`);
    g.iconPath = ico;

    // 单主入口模式：桌面没有分区图标，换图标只影响标签栏
    if (entryMode() === 'single') {
      store.save();
      return { ok: true, state: serializeState() };
    }

    const { desktop, pick } = locateGroupLnk(g);
    if (pick) {
      shortcuts.update(pick, { groupId: g.id, groupName: g.name, iconPath: ico });
      g.lnkPath = pick;
    } else {
      const w = shortcuts.write(shortcuts.lnkPathFor(desktop, g.name), {
        groupId: g.id, groupName: g.name, iconPath: ico
      });
      g.lnkPath = w.path;
    }
    // 换图标不该在桌面上留下第二个图标：顺手把同分区的多余入口收敛掉
    const extras = shortcuts.findAllByGroup(desktop, g.id).filter((p) => !samePath(p, g.lnkPath));
    if (extras.length) await convergeLnks(extras);
  } catch (e) {
    return { ok: false, msg: '设置图标失败：' + e.message };
  }

  store.save();
  return { ok: true, state: serializeState() };
}

async function deleteGroup(id, removeLnk, appsBack) {
  const cfg = store.get();
  const i = cfg.groups.findIndex((x) => x.id === id);
  if (i < 0) return { ok: false, msg: '分区不存在' };

  const g = cfg.groups[i];

  // 用户明确选了「放回桌面」才做，且必须在 splice 之前：
  // 还原要用 g.apps，分区一删数组就没了。
  let restored = 0;
  let kept = 0;
  if (appsBack) {
    for (const a of g.apps) {
      const r = adopt.restoreToDesktop(a);
      if (r.ok) {
        restored++;
        console.log('[delete] 放回桌面:', r.name, r.existed ? '(本来就在)' : '');
      } else {
        // .exe 本体没有"桌面快捷方式"可还原；副本丢失的也过不去。都不算失败，但要记账。
        kept++;
        console.warn('[delete] 未能放回桌面:', a.name, '|', r.msg);
      }
    }
  }

  // 单主入口模式下分区本来就没有桌面图标，这一步自然什么都不做（findAllByGroup 为空），
  // 保留逻辑是为了用户切回多入口模式后行为依旧正确。
  if (removeLnk) {
    // 删"这个分区的桌面入口"，不是删"g.lnkPath 那一个文件"。
    // 历史重复图标就藏在 lnkPath 之外，只删记录里的那条等于永远删不干净。
    const desktop = app.getPath('desktop');
    const targets = new Set(shortcuts.findAllByGroup(desktop, g.id));
    if (g.lnkPath) targets.add(g.lnkPath);
    for (const p of targets) {
      if (!fs.existsSync(p)) continue;
      // 只删确认属于本分区的（--group 指纹），绝不因为路径相同就误删别人的
      if (!shortcuts.isOurs(p, g.id)) continue;
      try { await shortcuts.remove(p); } catch (e) { console.error('删除快捷方式失败', p, e.message); }
    }
    const left = shortcuts.findAllByGroup(desktop, g.id);
    if (left.length) console.warn('[delete] 仍有入口没删掉：', left.map((p) => path.basename(p)).join(', '));
  }

  cfg.groups.splice(i, 1);
  const next = cfg.groups[Math.min(i, cfg.groups.length - 1)];
  pendingGroupId = next ? next.id : null;
  store.save();
  refreshTrayMenu();
  return { ok: true, state: serializeState(), restored, kept };
}

/* ---------------- 软件操作 ---------------- */
async function collectApps(paths) {
  const list = (paths || []).filter((p) => p && fs.existsSync(p) && /\.(exe|lnk|url)$/i.test(p));

  // 一次拖 20 个文件时，串行 await 就是 20 次 getFileIcon 排队；并发一下快一个量级
  const CONCURRENCY = 6;
  const out = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < list.length) {
      const p = list[cursor++];
      // 快捷方式先收养一份副本到自己的目录：
      // 这样之后桌面上那个图标删掉，分区里这条依然能点开，不会跟着失效。
      const stored = adopt.adopt(p);
      if (!iconMem[stored]) {
        try {
          const data = await icon.appIconDataURL(stored);
          if (data) iconMem[stored] = data;
        } catch (e) { /* 取不到就用占位 */ }
      }
      out.push({
        name: path.basename(p).replace(/\.(exe|lnk|url)$/i, ''),
        path: stored,
        // 记住原件在哪，将来"放回桌面"才能用原名还原
        orig: stored !== p ? p : '',
        // 只有从桌面收来的才谈得上"还回桌面"；
        // 从开始菜单/别处收来的，还回去会莫名其妙在桌面多出个图标
        fromDesktop: stored !== p ? adopt.isOnDesktop(p) : false
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));

  // 必须把它们自己的 path 传进去：这几条此刻还没进 store，见 saveIconCache 的注释
  saveIconCache(out.map((a) => a.path));
  return out;
}

/**
 * 加完软件后，问一句要不要把桌面上的原件移走。
 * 首次询问会提供"记住选择"；之后的决定存在 settings.cleanDesktopOnAdd。
 */
async function maybeCleanDesktop(sources) {
  const cfg = store.get();
  const onDesktop = (sources || []).filter((p) => {
    if (!p || !fs.existsSync(p) || !adopt.isShortcut(p)) return false;
    // 用户桌面 + 公共桌面都要算。
    // 之前这里只认用户桌面，理由是"公共桌面改动要管理员权限"—— 实测是错的：
    // C:\Users\Public\Desktop 对普通用户可写。而 C 盘安装的软件（Edge / NVIDIA /
    // 卡巴斯基 / Epic / Creative App）图标恰好都放在公共桌面，于是它们永远收不走，
    // 用户看到的就是"C 盘的只复制、D 盘的会被移走"，跟盘符半点关系没有。
    return adopt.isOnDesktop(p);
  });
  if (!onDesktop.length) return 0;

  let decision = cfg.cleanDesktopOnAdd;

  if (decision !== true && decision !== false) {
    // 窗口已经关了（收进托盘或正在退出）就别弹模态框：它会挂在一个看不见的窗口上，
    // 用户等半天没反应，还以为卡死了。这次不清理，下次再加东西时照常问。
    if (quitting || !win || win.isDestroyed() || !win.isVisible()) return 0;
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['移到回收站', '留在桌面'],
      defaultId: 0,
      cancelId: 1,
      title: '桌面图标怎么处理',
      message: `这 ${onDesktop.length} 个快捷方式已经加进分区了，要不要顺手从桌面移走？`,
      detail: '只移动桌面上的快捷方式，软件本体不受影响；移走的进回收站，随时能还原。',
      checkboxLabel: '记住我的选择，以后不再问',
      checkboxChecked: false
    });
    decision = r.response === 0;
    if (r.checkboxChecked) { cfg.cleanDesktopOnAdd = decision; store.save(); }
  }

  if (!decision) return 0;

  let moved = 0;
  for (const p of onDesktop) {
    try { await shell.trashItem(p); moved++; }
    catch (err) { console.error('[clean] 移走失败', p, err.message); }
  }
  return moved;
}

/**
 * 把"已经在分区里"的桌面快捷方式收走（进回收站）。
 *
 * 存在的理由：用户可能先把一堆软件拖进分区（当时选择"留在桌面"），
 * 事后再想清干净时，一条条对着删根本分不清哪个已经收过了。
 *
 * 判定要保守 —— 只认两种死死的对应关系：
 *   1) 桌面这条 .lnk/.url 的内容和 shortcuts/ 里某个副本一模一样（sha1 相同）
 *   2) 解析出来的 target + args 与分区里某条相同
 * 任何一条对不上就不动它。宁可少删，不能把用户桌面搞乱。
 */
async function cleanDesktopDupes() {
  const adoptDir = adopt.getAdoptDir();
  if (!adoptDir) return { ok: false, msg: '快捷方式副本目录不可用，无法比对' };

  const byHash = new Set();
  const byTarget = new Set();
  let files = [];
  try { files = fs.readdirSync(adoptDir); } catch (e) { return { ok: false, msg: '读不到副本目录' }; }
  for (const f of files) {
    if (!/\.(lnk|url)$/i.test(f)) continue;
    const p = path.join(adoptDir, f);
    try { byHash.add(crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex')); } catch (e) { /* 跳过 */ }
    if (/\.lnk$/i.test(p)) {
      const s = shortcuts.read(p);
      if (s && s.target) byTarget.add(path.normalize(s.target).toLowerCase() + '|' + (s.args || ''));
    }
  }

  // 用户桌面 + 公共桌面两处都要扫。
  // 公共桌面（C:\Users\Public\Desktop）装的大多是 C 盘软件：Edge、NVIDIA App、
  // 卡巴斯基、Epic、Creative App。只扫用户桌面的话，这些永远收不走，
  // 用户就会觉得"分区里明明有，桌面上还赖着一个"。
  const desktops = [];
  try { desktops.push({ dir: app.getPath('desktop'), label: '桌面' }); } catch (e) { /* 没有就算了 */ }
  const pubDir = path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Desktop');
  if (fs.existsSync(pubDir) && !desktops.some((d) => samePath(d.dir, pubDir))) {
    desktops.push({ dir: pubDir, label: '公共桌面' });
  }

  const groupLnks = store.get().groups.map((g) => g.lnkPath).filter(Boolean);
  const dupes = [];
  let readable = 0;

  for (const { dir, label } of desktops) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { continue; }
    readable++;
    for (const f of names) {
      if (!/\.(lnk|url)$/i.test(f)) continue;
      const full = path.join(dir, f);
      if (groupLnks.some((p) => samePath(p, full))) continue;   // 分区自己的入口，绝不动

      let hit = false;
      try { hit = byHash.has(crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex')); } catch (e) { /* 读不了就不动 */ }
      if (!hit && /\.lnk$/i.test(full)) {
        const s = shortcuts.read(full);
        if (s && s.target) hit = byTarget.has(path.normalize(s.target).toLowerCase() + '|' + (s.args || ''));
      }
      if (hit) dupes.push({ path: full, name: f, public: label === '公共桌面' });
    }
  }

  if (!readable) return { ok: false, msg: '读不到桌面目录' };
  if (!dupes.length) return { ok: true, moved: 0, names: [], publicMoved: 0 };

  let moved = 0;
  let publicMoved = 0;
  const done = [];
  for (const d of dupes) {
    try {
      await shell.trashItem(d.path);
      moved++;
      if (d.public) publicMoved++;
      done.push(d.name);
    } catch (e) {
      console.error('[cleanDupes] 移走失败', d.path, e.message);
    }
  }
  console.log('[cleanDupes] 收走', moved, '个重复快捷方式（公共桌面', publicMoved, '个）:', done.join(', '));
  return { ok: true, moved, names: done, publicMoved };
}

/* ---------------- IPC ---------------- */
function registerIpc() {
  ipcMain.handle('state:get', () => serializeState());

  ipcMain.handle('group:create', (e, { name, iconSrc }) => createGroup(name, iconSrc));
  ipcMain.handle('group:rename', (e, { id, name }) => renameGroup(id, name));
  ipcMain.handle('group:icon', (e, id) => setGroupIcon(id));
  ipcMain.handle('group:delete', (e, { id, removeLnk, appsBack }) => deleteGroup(id, removeLnk, appsBack));

  ipcMain.handle('dialog:pickImage', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择图标图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'ico', 'webp'] }]
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    const p = r.filePaths[0];
    pickedImages.clear();          // 只放行"这一次选中"的路径
    pickedImages.add(p);
    const img = nativeImage.createFromPath(p);
    if (img.isEmpty()) {
      return { ok: false, msg: '这个文件读不出来（webp 可能不被系统支持），请换 png' };
    }
    const prev = img.resize({ width: 96, height: 96 }).toDataURL();
    return { ok: true, path: p, preview: prev };
  });

  ipcMain.handle('apps:add', onAppsAdd);
  ipcMain.handle('apps:addPaths', onAppsAddPaths);
  ipcMain.handle('apps:remove', onAppsRemove);
  ipcMain.handle('apps:toDesktop', onAppToDesktop);
  ipcMain.handle('group:toDesktop', (e, id) => onGroupToDesktop(e, id));
  ipcMain.handle('apps:launch', onLaunch);
  ipcMain.handle('apps:reveal', (e, p) => {
    if (isRegisteredPath(p) && fs.existsSync(p)) shell.showItemInFolder(p);
  });
  ipcMain.handle('apps:reorder', onReorder);
  ipcMain.handle('apps:icon', onAppIcon);
  // 拖出窗口：交给系统原生拖拽，落点就是松手的位置
  ipcMain.on('apps:nativeDrag', (e, { groupId, path: p }) => {
    if (!isRegisteredPath(p)) return;
    // 异步（要等 1 秒左右确认文件到底落哪了），异常必须自己收掉，否则成为 unhandledRejection
    onNativeDrag(e, { groupId, path: p }).catch((err) => {
      console.error('[drag] 处理失败', err && err.stack || err);
      if (win && !win.isDestroyed()) win.webContents.send('apps:dragEnd', { ok: false, msg: '拖拽处理失败' });
    });
  });
  // 强制重抓所有图标：老版本在 collectApps 里误删过刚抓的缓存，用户手里可能全是字母块，
  // 有个一键入口就不用让他们删了重加
  ipcMain.handle('icons:refresh', async () => {
    const r = await warmIcons(true);
    return { ok: true, total: r.total, got: r.ok, state: serializeState() };
  });
  ipcMain.handle('apps:cleanDesktopDupes', () => cleanDesktopDupes());

  ipcMain.handle('group:switch', (e, id) => { pendingGroupId = id; return true; });
  ipcMain.handle('group:revealLnk', (e, lnk) => {
    // 认的是"这个分区的入口"，不是"某一条记忆中的路径"：
    // 用户手动改过名之后，界面上那串旧路径点开只会报"找不到"。
    const known = !!lnk && fs.existsSync(lnk) && store.get().groups.some(
      (g) => samePath(g.lnkPath, lnk) || shortcuts.isOurs(lnk, g.id)
    );
    if (known) { shell.showItemInFolder(lnk); return { ok: true }; }
    return { ok: false, msg: '桌面上找不到这个快捷方式' };
  });

  ipcMain.handle('group:restoreLnk', (e, id) => restoreGroupLnk(id));

  ipcMain.handle('settings:set', async (e, patch) => {
    const cfg = store.get();
    if (patch.theme) cfg.theme = patch.theme;
    let materialMsg = '';
    if (patch.material) {
      // 不支持的系统上诚实回退：设置存回 solid，并在返回值里告诉渲染层原因
      if (patch.material !== 'solid' && !materialSupported()) {
        materialMsg = '系统不支持界面材质（需要 Win11 22H2 及以上），已保持纯色';
        cfg.material = 'solid';
      } else {
        cfg.material = patch.material;
      }
    }

    // 桌面入口模式切换：这不只是改个开关，桌面上真会有图标进出，必须当场落实并回报数量
    let entryMsg = '';
    let trashed = 0;
    if ((patch.entryMode === 'single' || patch.entryMode === 'multi')
      && patch.entryMode !== entryMode()) {
      cfg.entryMode = patch.entryMode;
      store.save();
      if (patch.entryMode === 'single') {
        // 用户是主动切过来的：主入口必须马上在，否则桌面就真的空了
        trashed = await trashAllGroupLnks('切换到单主入口');
        ensureMainLnk(true);
        entryMsg = trashed
          ? `已把 ${trashed} 个分区图标移进回收站，桌面只留一个主入口`
          : '桌面只留一个主入口';
      } else {
        const n = ensureGroupLnks();
        entryMsg = `已为 ${n} 个分区重建桌面图标`;
      }
      refreshTrayMenu();
      store.save();
    }

    if (typeof patch.closeToTray === 'boolean') cfg.closeToTray = patch.closeToTray;
    // 三态：true=移到回收站 false=留在桌面 null=每次问。
    // 以前只收 boolean，于是用户一旦选了"记住"，就再也没法退回"每次问我"。
    if (patch.cleanDesktopOnAdd === null || typeof patch.cleanDesktopOnAdd === 'boolean') {
      cfg.cleanDesktopOnAdd = patch.cleanDesktopOnAdd;
    }
    if (patch.iconSize === 's' || patch.iconSize === 'm' || patch.iconSize === 'l') {
      cfg.iconSize = patch.iconSize;
    }
    store.save();
    if (patch.material) applyMaterial();
    // 托盘图标只在"收托盘"模式下存在，退出模式下不该占着任务栏角落
    if (typeof patch.closeToTray === 'boolean') {
      if (cfg.closeToTray && !tray) {
        createTray();
        // 托盘建不出来就退回"关闭即退出"：宁可少一个常驻功能，
        // 也不能让用户点 X 之后窗口消失、托盘没有、任务栏也没有。
        if (!tray) { cfg.closeToTray = false; store.save(); }
      } else if (!cfg.closeToTray && tray) {
        tray.destroy();
        tray = null;
      }
    }
    return {
      ok: true,
      state: serializeState(),
      closeToTray: !!cfg.closeToTray,
      msg: materialMsg || entryMsg,
      entryMsg,
      trashed
    };
  });

  // 用户亲手点"重建桌面主入口"：这是明确的意图，可以跳过"删了就别复活"的克制
  ipcMain.handle('main:restoreLnk', () => {
    const r = ensureMainLnk(true);
    return { ...r, state: serializeState() };
  });

  ipcMain.handle('window:minimize', () => { if (win) win.minimize(); });
  ipcMain.handle('window:toggleMaximize', () => {
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle('window:close', () => {
    if (!win) return;
    // 这份判断必须和 win.on('close') 保持一致：界面上的 X 走的是这条 IPC，
    // 不经过窗口的 close 事件。托盘不存在还 hide，就等于把用户关进
    // "任务栏没有、托盘没有、进程还活着"的死角。
    if (store.get().closeToTray && tray) win.hide();
    else { quitting = true; app.quit(); }
  });
}

async function onAppsAdd(e, groupId) {
  const g = store.findGroup(groupId);
  if (!g) return { ok: false, msg: '分区不存在' };

  const r = await dialog.showOpenDialog(win, {
    title: '选择要加入分区的程序',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '程序 / 快捷方式', extensions: ['exe', 'lnk', 'url'] },
      { name: '全部文件', extensions: ['*'] }
    ]
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };

  const added = await collectApps(r.filePaths);
  let n = 0;
  added.forEach((a) => {
    // 同一份快捷方式再拖一次时，副本文件名可能已经变了（.lnk 内容带时间戳），
    // 只比 path 挡不住；再按「原件在哪」比一次，免得同一个软件多出一个格子。
    if (g.apps.some((x) => x.path.toLowerCase() === a.path.toLowerCase()
      || (a.orig && x.orig && x.orig.toLowerCase() === a.orig.toLowerCase()))) return;
    g.apps.push(a);
    n++;
  });
  store.save();
  refreshTrayMenu();          // 托盘菜单里的「分区名 (N)」计数要跟着变
  const state = serializeState();
  // 问询对话框可能停在那儿很久，别把 IPC 响应挂住（挂住时界面看起来像卡死）
  setImmediate(() => {
    if (quitting) return;
    maybeCleanDesktop(r.filePaths).catch((e) => console.error('[clean]', e));
  });
  return { ok: true, added: n, moved: 0, state };
}

async function onAppsAddPaths(e, payload) {
  const { groupId, paths } = payload;
  // 拖入时落在哪个格子上就插到那个位置（-1 = 追加到末尾）
  const at = Number.isInteger(payload.at) && payload.at >= 0 ? payload.at : -1;
  const g = store.findGroup(groupId);
  if (!g) return { ok: false, msg: '分区不存在' };

  const added = await collectApps(paths || []);
  let n = 0;
  let ins = at;
  added.forEach((a) => {
    // 同一份快捷方式再拖一次时，副本文件名可能已经变了（.lnk 内容带时间戳），
    // 只比 path 挡不住；再按「原件在哪」比一次，免得同一个软件多出一个格子。
    if (g.apps.some((x) => x.path.toLowerCase() === a.path.toLowerCase()
      || (a.orig && x.orig && x.orig.toLowerCase() === a.orig.toLowerCase()))) return;
    if (ins >= 0) {
      g.apps.splice(Math.min(ins, g.apps.length), 0, a);
      ins++;
    } else {
      g.apps.push(a);
    }
    n++;
  });
  store.save();
  refreshTrayMenu();
  const state = serializeState();
  setImmediate(() => {
    if (quitting) return;
    maybeCleanDesktop(paths || []).catch((e) => console.error('[clean]', e));
  });
  return { ok: true, added: n, moved: 0, state };
}

async function onAppsRemove(e, { groupId, path: p, silent }) {
  const g = store.findGroup(groupId);
  if (!g) return { ok: false, msg: '分区不存在' };
  const a = g.apps.find((x) => x.path === p);
  if (!a) return { ok: false, msg: '这个程序不在分区里' };

  // 只有在「桌面上也早就没有了」的情况下"移除"才等于彻底消失，这时必须问一句。
  // 桌面上还有的话直接移除，不打扰。
  const adopted = adopt.isShortcut(p) && adopt.isAdopted(p);
  const onDesktopNow = !!(a.orig && fs.existsSync(a.orig));
  // 只在"确实来自桌面、且桌面上现在没有"时才问。fromDesktop 由 collectApps 写入，
  // 老数据在 migrateAdoptOldApps 里按 orig 路径补判（严格 true，不做宽松兜底）。
  const fromDesktop = a.fromDesktop === true;
  // silent：界面已经用自己的卡片问过了（比如"找不到这个软件，要移除吗"），
  // 这里再弹一次系统对话框就是重复打扰。而且那种场景下软件本体都没了，
  // 把失效快捷方式"放回桌面"纯属添乱，直接移除才是对的。
  const risky = adopted && fromDesktop && !onDesktopNow && !silent;

  let restored = '';

  if (risky) {
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      title: '移除前确认',
      message: `「${a.name}」桌面上已经没有图标了。`,
      detail: '移除后，快捷方式只剩启动器里的这一份副本。要不要先把它放回桌面？',
      buttons: ['放回桌面并移除', '只移除', '取消'],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    });
    if (r.response === 2) return { ok: false, canceled: true };
    if (r.response === 0) {
      const rr = adopt.restoreToDesktop(a);
      // 放回失败就别删了：用户点的是"放回桌面并移除"，只做到一半等于骗他。
      if (!rr.ok) {
        return { ok: false, msg: '放回桌面失败，已取消移除：' + (rr.msg || ''), state: serializeState() };
      }
      if (!rr.existed) restored = rr.name;
    }
  }

  g.apps = g.apps.filter((x) => x.path !== p);
  store.save();
  refreshTrayMenu();
  return { ok: true, restored, state: serializeState() };
}

/** 整个分区一键"全部放回桌面" */
function onGroupToDesktop(e, groupId) {
  const g = store.findGroup(groupId);
  if (!g) return { ok: false, msg: '分区不存在' };
  let added = 0, existed = 0, fail = 0, skipped = 0;
  g.apps.forEach((a) => {
    if (!adopt.isShortcut(a.path) || !adopt.isAdopted(a.path)) return;
    // 不是从桌面收来的（比如开始菜单），"还回去"只会在桌面凭空多一个图标
    if (a.fromDesktop !== true) { skipped++; return; }
    const r = adopt.restoreToDesktop(a);
    if (!r.ok) fail++;
    else if (r.existed) existed++;
    else added++;
  });
  return { ok: true, added, existed, fail, skipped };
}

/** 右键「放回桌面」：把副本按原名复制回桌面（条目保留，桌面和分区同时可用） */
function onAppToDesktop(e, { groupId, path: p }) {
  const g = store.findGroup(groupId);
  if (!g) return { ok: false, msg: '分区不存在' };
  const a = g.apps.find((x) => x.path === p);
  if (!a) return { ok: false, msg: '这个程序不在分区里' };
  if (a.fromDesktop !== true) {
    return { ok: false, msg: '这个快捷方式不是从桌面收来的，放回桌面没有意义' };
  }
  return adopt.restoreToDesktop(a);
}

function onReorder(e, { groupId, from, to }) {
  const g = store.findGroup(groupId);
  if (!g) return { ok: false, msg: '分区不存在' };
  if (from < 0 || from >= g.apps.length || to < 0 || to >= g.apps.length) {
    return { ok: false, msg: '位置无效' };
  }
  const [it] = g.apps.splice(from, 1);
  g.apps.splice(to, 0, it);
  store.save();
  return { ok: true, state: serializeState() };
}

/* ---------------- 拖出窗口 = 系统原生文件拖拽 ---------------- */

/**
 * 拖出走系统原生拖拽（webContents.startDrag）：文件跟着鼠标，松手落在哪就在哪——
 * 拖到桌面就进桌面，拖到某个文件夹就进那个文件夹。
 *
 * 三条实测出来的硬约束（都踩过）：
 * 1. startDrag 必须在 HTML5 dragstart 的同步上下文里发起，所以渲染层要先 preventDefault
 *    把 HTML5 拖拽掐掉再发 IPC。若等到 mousemove 中途再调，实测只阻塞 19ms、拖拽根本没起来。
 * 2. icon 不能省，也不能给 1×1 的占位图——那样 startDrag 秒返回、DoDragDrop 不接管。
 *    给真实图标时会一直阻塞到松手（实测 2317ms），我们也正是靠这个"阻塞"才知道拖拽结束了。
 * 3. 系统在松手时是"复制"而不是"移动"（源文件仍在），所以"移出分区"只能我们自己收掉。
 *    ——但收掉的门槛是**确认落在桌面上**（见 waitLandedOnDesktop），不是"光标在窗外"。
 */
const DRAG_TMP_DIR = () => path.join(app.getPath('temp'), 'desktop-launcher-drag');

const DRAG_FALLBACK_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAL0lEQVR42u3OIQEAAAgDMNIRjEz0gxg3E/Ornr2kEhAQEBAQEBAQEBAQEBAQSAcexgLsiFKJRcoAAAAASUVORK5CYII=';

function safeFileName(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '').trim().slice(0, 120) || 'shortcut';
}

/** 给这次拖拽准备一个"文件名正确"的中转文件：用户拖出去看到的该是软件原名，不是内部 hash */
function prepareDragSource(a) {
  const dir = DRAG_TMP_DIR();
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* 已存在 */ }

  if (adopt.isShortcut(a.path) && adopt.isAdopted(a.path)) {
    const ext = path.extname(a.path).toLowerCase();
    let base = path.basename(a.orig || '') || a.name || 'shortcut';
    if (!/\.(lnk|url)$/i.test(base)) base += ext;
    const dest = path.join(dir, safeFileName(base));
    fs.copyFileSync(a.path, dest);
    return dest;
  }

  // 裸 exe 绝不拖本体（可能几百兆，复制过去是场灾难），生成一个指向它的快捷方式
  const dest = path.join(dir, safeFileName((a.name || 'App') + '.lnk'));
  const ok = shell.writeShortcutLink(dest, 'create', { target: a.path, description: a.name || '' });
  if (!ok) throw new Error('生成快捷方式失败');
  return dest;
}

function dragIconFor(a) {
  try {
    const d = iconMem[a.path];
    if (d) {
      const im = nativeImage.createFromDataURL(d);
      if (!im.isEmpty()) return im;
    }
  } catch (e) { /* 落到兜底 */ }
  try {
    if (a.iconFile && fs.existsSync(a.iconFile)) {
      const im = nativeImage.createFromPath(a.iconFile);
      if (!im.isEmpty()) return im;
    }
  } catch (e) { /* 落到兜底 */ }
  return nativeImage.createFromDataURL(DRAG_FALLBACK_ICON);
}

function removeEntry(g, a) {
  g.apps = g.apps.filter((x) => x.path !== a.path);
  store.save();
  refreshTrayMenu();
  return { ok: true, name: a.name, state: serializeState() };
}

/* ---------------- 拖出后怎么判定"到底落在哪了" ---------------- */

/** 桌面目录：用户桌面 + 公共桌面。拖出到这两处才算"放回桌面"。 */
function desktopDirs() {
  const dirs = [];
  try {
    const d = app.getPath('desktop');
    if (d) dirs.push(d);
  } catch (e) { /* 取不到就算了 */ }
  const pub = path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Desktop');
  if (fs.existsSync(pub) && !dirs.some((d) => samePath(d, pub))) dirs.push(pub);
  return dirs;
}

/** 桌面快捷方式快照：绝对路径(小写) → "大小|mtime"。松手后再拍一次，比对即知有没有多出一份。 */
function snapshotDesktop() {
  const snap = new Map();
  for (const dir of desktopDirs()) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { continue; }
    for (const f of names) {
      if (!/\.(lnk|url)$/i.test(f)) continue;
      const full = path.join(dir, f);
      try {
        const st = fs.statSync(full);
        snap.set(full.toLowerCase(), st.size + '|' + st.mtimeMs);
      } catch (e) { /* 读不到就不记，最多是漏判 */ }
    }
  }
  return snap;
}

/**
 * 松手后确认这次拖拽是否真的落在了桌面上——**只认文件系统里的硬证据**。
 *
 * 为什么不看光标：光标落在窗口外 ≠ 落在桌面。它可能落在任何一个接收文件拖放的
 * 程序上（聊天窗口、邮件、解压软件……）。2026-11-04 用户就是拖出来松手在聊天窗口上，
 * 老代码凭"光标在窗外"就删了分区条目，用户看到的是"我只是拖给你看，它就消失了"。
 *
 * 判定条件：桌面上出现同名（含「名字 (2)」「名字 - 副本」这类系统改名）的 .lnk/.url，
 * 且它不在拖拽前的快照里、或大小/mtime 被改写。没有这条证据就当"没落在桌面"。
 */
async function waitLandedOnDesktop(before, baseName, budgetMs = 1200) {
  const want = String(baseName || '').toLowerCase();
  const stem = want.replace(/\.(lnk|url)$/i, '');
  if (!stem) return false;                     // 连名字都说不出来，就别赌

  const t0 = Date.now();
  for (;;) {
    for (const dir of desktopDirs()) {
      let names = [];
      try { names = fs.readdirSync(dir); } catch (e) { continue; }
      for (const f of names) {
        if (!/\.(lnk|url)$/i.test(f)) continue;
        const low = f.toLowerCase();
        // 同名，或系统为重名自动改的「xxx (2).lnk」「xxx - 副本.lnk」
        if (low !== want && !low.startsWith(stem + ' (') && !low.startsWith(stem + ' - ')) continue;
        const full = path.join(dir, f);
        let sig = '';
        try {
          const st = fs.statSync(full);
          sig = st.size + '|' + st.mtimeMs;
        } catch (e) { continue; }
        if (before.get(full.toLowerCase()) !== sig) return true;
      }
    }
    if (Date.now() - t0 >= budgetMs) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** 中转文件晚点再删：系统可能还在把文件往目标位置写（资源管理器的复制是异步的） */
function cleanupDragTemp(tmp) {
  setTimeout(() => {
    try { fs.unlinkSync(tmp); console.log('[drag] 暂存已删 ' + path.basename(tmp)); }
    catch (e2) { console.log('[drag] 暂存删除失败（仍被占用）: ' + e2.code); }
  }, 15000);
}

async function onNativeDrag(e, { groupId, path: p }) {
  const g = store.findGroup(groupId);
  const a = g && g.apps.find((x) => x.path === p);
  if (!a) return;
  if (!fs.existsSync(a.path)) {
    if (win && !win.isDestroyed()) win.webContents.send('apps:dragEnd', { ok: false, msg: '文件已不存在' });
    return;
  }

  let tmp = '';
  try { tmp = prepareDragSource(a); }
  catch (err) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('apps:dragEnd', { ok: false, msg: '准备拖拽文件失败：' + err.message });
    }
    return;
  }

  const iconImg = dragIconFor(a);
  const before = snapshotDesktop();          // 拍照必须在 startDrag 之前
  const t0 = Date.now();
  try {
    e.sender.startDrag({ file: tmp, icon: iconImg });   // 阻塞到松手才返回
    const sz = iconImg.getSize();
    console.log('[drag] startDrag ' + (Date.now() - t0) + 'ms | icon ' + sz.width + 'x' + sz.height + ' | ' + path.basename(tmp));
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* 忽略 */ }
    if (win && !win.isDestroyed()) win.webContents.send('apps:dragEnd', { ok: false, msg: '拖拽没有启动' });
    return;
  }

  // 秒返回 = 拖拽根本没起来（鼠标先松了 / DoDragDrop 没接管系统拖放）。
  // 这种既不是"落地"也不是"取消"，条目一律不动，别拿它当移出的理由。
  const elapsed = Date.now() - t0;
  if (elapsed < 80) {
    console.log('[drag] 拖拽没起来（' + elapsed + 'ms），条目保持不动');
    try { fs.unlinkSync(tmp); } catch (e2) { /* 忽略 */ }
    if (win && !win.isDestroyed()) win.webContents.send('apps:dragEnd', { ok: true, canceled: true });
    return;
  }

  // 松手了。落在窗口内容区里 = 想排序；落在外面 = 系统已经把文件复制到目标位置。
  // 但"落在外面"不等于"落在桌面"——见 waitLandedOnDesktop 的注释。
  let pt = null;
  let cb = null;
  try { pt = screen.getCursorScreenPoint(); cb = win.getContentBounds(); } catch (err) { /* 忽略 */ }
  const inside = !!(pt && cb) && pt.x >= cb.x && pt.y >= cb.y &&
                 pt.x < cb.x + cb.width && pt.y < cb.y + cb.height;

  if (inside) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* 没被复制走，清掉 */ }
    if (win && !win.isDestroyed()) {
      win.webContents.send('apps:dragEnd', { ok: true, inside: true, x: pt.x - cb.x, y: pt.y - cb.y });
    }
    return;
  }

  const landed = await waitLandedOnDesktop(before, path.basename(tmp));
  if (!landed) {
    // 落在别的程序或文件夹里：文件确实被复制出去了，但**分区必须留着**。
    // 拖出去发个截图/发个附件是正常操作，不该等于"从分区删掉"。
    cleanupDragTemp(tmp);
    console.log('[drag] 未落到桌面，条目保留: ' + a.name);
    if (win && !win.isDestroyed()) {
      win.webContents.send('apps:dragEnd', { ok: true, inside: false, kept: true, name: a.name });
    }
    return;
  }

  const r = removeEntry(g, a);
  cleanupDragTemp(tmp);
  console.log('[drag] 已落回桌面，条目移出: ' + a.name);
  if (win && !win.isDestroyed()) win.webContents.send('apps:dragEnd', Object.assign({ inside: false }, r));
}

async function onAppIcon(e, { groupId, path: p }) {

  const g = store.findGroup(groupId);
  if (!g) return { ok: false, msg: '分区不存在' };
  const a = g.apps.find((x) => x.path === p);
  if (!a) return { ok: false, msg: '这个程序不在分区里' };

  const r = await dialog.showOpenDialog(win, {
    title: '为「' + a.name + '」选择图标',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'ico', 'webp'] }]
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };

  try {
    const tag = 'app-' + crypto.createHash('md5').update(p).digest('hex').slice(0, 10);
    a.iconFile = icon.imageToPngFile(r.filePaths[0], tag);
  } catch (err) {
    return { ok: false, msg: '图标处理失败：' + err.message };
  }

  // 回写快捷方式本体：拖出功能落地到桌面的就是这份 .lnk，
  // 不同步 IconLocation 的话，桌面显示旧图标、分区显示新图标（里外不一致）。
  let warn = '';
  if (/\.lnk$/i.test(a.path || '')) {
    try {
      // 同分组图标：文件名带时间戳，绕开 Windows 图标缓存（固定名覆盖 = 桌面永远显示旧图）
      const icoPath = icon.imageToIco(a.iconFile, path.basename(a.iconFile, '.png') + '-' + Date.now());
      const old = shell.readShortcutLink(a.path);   // 原样保留 target/args/cwd
      const ok = shell.writeShortcutLink(a.path, 'replace', {
        target: old.target,
        args: old.args || '',
        cwd: old.cwd || '',
        icon: icoPath,
        iconIndex: 0,
      });
      if (!ok) warn = '快捷方式图标未同步';
    } catch (err) {
      // 个别怪格式 lnk 读不出来（如某些 UWP），换图标本身不受影响，只是桌面那头维持原样
      warn = '快捷方式图标未同步（' + err.message.slice(0, 40) + '）';
    }
  }
  store.save();
  return { ok: true, state: serializeState(), warn };
}

/** 这个路径是不是登记在某个分区里的？用来挡住 launch / reveal 的任意路径调用 */
function isRegisteredPath(p) {
  if (!p || typeof p !== 'string') return false;
  const low = path.normalize(p).toLowerCase();
  return store.get().groups.some(
    (g) => g.apps.some((a) => path.normalize(a.path || '').toLowerCase() === low)
  );
}

async function onLaunch(e, p) {
  if (!p) return { ok: false, msg: '路径为空' };
  // 渲染层只能启动"分区里登记过的"东西。产品语义本来就是启动器，
  // 但把这条链收窄之后，就算 renderer 哪天被 XSS 攻破也跑不了任意文件。
  if (!isRegisteredPath(p)) {
    console.warn('[launch] 拒绝未登记路径:', p);
    return { ok: false, msg: '这个路径不在任何分区里，已拒绝启动' };
  }
  // 交给 launch 模块分流：.url（Steam 游戏）、UWP 的 .lnk、普通 exe 各自有各自的打开方式，
  // 统一用 shell.openPath 会有一批直接返回 "Failed to open path"。
  const r = await launch.open(p);
  const base = path.basename(p);
  if (r.ok) {
    console.log('[launch] ok', base, '|', r.method || '', r.warn ? '(' + r.warn + ')' : '');
  } else {
    // 以前失败只 toast 一下、不落盘，事后完全无法复盘"哪个软件打不开、为什么"
    console.error('[launch] 失败', base, '|', r.msg);
  }
  return r;
}
