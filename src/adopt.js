// 「收养」用户拖进来的快捷方式：复制一份到自己的目录，条目指向副本
//
// 为什么要这么做：
//   以前直接把桌面 .lnk 的路径存进配置。一旦你把桌面上那个图标删掉，
//   启动器里这一条就跟着失效了 —— 等于启动器和桌面图标绑死。
//   复制一份之后，桌面爱怎么清怎么清，分区里的条目照样能点开。
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

let adoptDir = '';

function init(userDataDir) {
  const want = path.join(userDataDir, 'shortcuts');
  try {
    fs.mkdirSync(want, { recursive: true });
    adoptDir = want;
  } catch (e) {
    // 建不出来不能让主进程崩（权限 / 磁盘满 / 同名文件占位）。
    // 退到临时目录：本轮仍能收养，只是重启后副本可能没了。
    console.error('[adopt.init] 快捷方式目录不可用，降级到临时目录:', e.message);
    const fallback = path.join(require('os').tmpdir(), 'desktop-launcher-shortcuts');
    try {
      fs.mkdirSync(fallback, { recursive: true });
      adoptDir = fallback;
    } catch (e2) {
      console.error('[adopt.init] 临时目录也建不出来，收养功能将退化为引用原路径:', e2.message);
      adoptDir = '';
    }
  }
}

function getAdoptDir() { return adoptDir; }

function isShortcut(p) {
  return /\.(lnk|url)$/i.test(p || '');
}

/** 是否已经在自己的目录里（避免重复收养自己） */
function isAdopted(p) {
  if (!adoptDir) return false;
  return path.normalize(p).toLowerCase().startsWith(path.normalize(adoptDir).toLowerCase());
}

/**
 * 返回一个"用自己的副本"的路径。
 * - exe：原样返回（软件本体不复制，太重也没必要）
 * - lnk/url：复制到 shortcuts/ 下，返回副本路径
 * - 已经在 shortcuts/ 下：原样返回
 */
/**
 * 两份快捷方式是不是「同一个东西」。
 *
 * 为什么不能只比字节：.lnk 头里带写入时间戳（偏移 28/36/44 三个 FILETIME），
 * 同一条快捷方式由安装器重建一次、或者我们自己再 writeShortcutLink 一次，
 * 字节就全变了（实测：参数完全相同的两次写入，大小都是 954B，但偏移 36 起就不同）。
 * 只按字节比 → 每次再拖一次都判定"不一样" → 生成 hash-1.lnk，
 * 上层再按副本路径去重又对不上 → 用户看到同一个软件多出一个格子。
 *
 * 所以这里按「它指向谁、带什么参数、在哪个目录跑」来判断 —— 那才是用户眼里的"同一个"。
 */
function sameContent(a, b) {
  try { if (fs.readFileSync(a).equals(fs.readFileSync(b))) return true; } catch (e) { return false; }

  const ext = path.extname(a).toLowerCase();
  const clean = (s) => String(s || '').replace(/^"+|"+$/g, '').trim().toLowerCase();

  if (ext === '.lnk') {
    try {
      const { shell } = require('electron');
      const x = shell.readShortcutLink(a);
      const y = shell.readShortcutLink(b);
      // target 为空的是 UWP 快捷方式（只有包 AUMID），这种不靠字节就分不清是哪个应用，
      // 保守起见一律当作"不同"，宁可多留一份副本，也不能把两个商店应用认成一个。
      if (!x.target || !y.target) return false;
      return clean(x.target) === clean(y.target)
        && clean(x.args) === clean(y.args)
        && clean(x.cwd) === clean(y.cwd);
    } catch (e) { return false; }
  }

  if (ext === '.url') {
    const urlOf = (p) => {
      try {
        const m = /^\s*URL\s*=\s*(.+)$/im.exec(fs.readFileSync(p, 'utf8'));
        return m ? m[1].trim().toLowerCase() : '';
      } catch (e) { return ''; }
    };
    const ua = urlOf(a);
    return !!ua && ua === urlOf(b);
  }

  return false;
}

function adopt(srcPath) {
  if (!isShortcut(srcPath)) return srcPath;
  if (!adoptDir) return srcPath;          // 没有可写目录：退化为直接引用原路径
  if (isAdopted(srcPath)) return srcPath;
  if (!fs.existsSync(srcPath)) return srcPath;

  const ext = path.extname(srcPath).toLowerCase();
  // 用源路径算稳定文件名：同一个桌面快捷方式反复拖，只会留一份副本
  const hash = crypto.createHash('sha1')
    .update(path.normalize(srcPath).toLowerCase())
    .digest('hex')
    .slice(0, 12);
  const dest0 = path.join(adoptDir, hash + ext);

  try {
    const buf = fs.readFileSync(srcPath);

    // 先看有没有现成的：内容一模一样就复用。
    // 不能直接 copyFile 覆盖 —— 同一个路径后来指向了别的软件（比如删了 Chrome.lnk
    // 又新建同名指向 Firefox），覆盖会让分区里那条悄悄变成另一个程序。
    for (let i = 0; i < 100; i++) {
      const dest = i === 0 ? dest0 : path.join(adoptDir, `${hash}-${i}${ext}`);
      if (fs.existsSync(dest)) {
        if (sameContent(dest, srcPath)) return dest;
        continue;
      }
      // 原子落盘：写一半被强杀会留下一个"看起来存在、内容残缺"的副本
      const tmp = `${dest}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, buf);
      try {
        fs.renameSync(tmp, dest);
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
        throw e;
      }
      return dest;
    }
    return srcPath;
  } catch (e) {
    console.error('[adopt] 复制失败，退化为原路径', e.message);
    return srcPath;
  }
}

/**
 * 清理没人引用的副本。
 * ⚠️ 目前**没有**在删分区/删条目后自动调用，也不建议加：
 * 那些副本往往就是用户那份快捷方式的最后一份，为了省几百字节把它删掉，
 * 换来的是一次无法恢复的丢失。宁可留着。
 */
function gc(keepPaths, minAgeDays = 30) {
  if (!adoptDir || !fs.existsSync(adoptDir)) return 0;
  const keep = new Set((keepPaths || []).map((p) => path.normalize(p).toLowerCase()));
  const cutoff = Date.now() - minAgeDays * 86400000;
  let n = 0;
  for (const f of fs.readdirSync(adoptDir)) {
    const full = path.join(adoptDir, f);
    if (keep.has(path.normalize(full).toLowerCase())) continue;
    try {
      if (fs.statSync(full).mtimeMs > cutoff) continue;
      fs.unlinkSync(full);
      n++;
    } catch (e) { /* 占用中或读不到就跳过 */ }
  }
  return n;
}

/** 源文件是否在桌面上（用来判断"要不要顺手清理桌面"） */
function isOnDesktop(p) {
  if (!p) return false;
  const dirs = [];
  try {
    // 用户桌面 + 公共桌面（部分安装程序把图标放公共桌面）
    dirs.push(path.normalize(require('electron').app.getPath('desktop')).toLowerCase());
    dirs.push(path.normalize(process.env.PUBLIC || 'C:\\Users\\Public').toLowerCase() + '\\desktop');
  } catch (e) { /* 拿不到就只按目录名判断 */ }
  const t = path.normalize(p).toLowerCase();
  return dirs.some((d) => t.startsWith(d + path.sep));
}

/**
 * 把收养的副本"还"回桌面。
 * 用原名还原（app.orig 的 basename）；桌面上已有同名且内容不同的，加 (2) 另存，绝不覆盖。
 */
function restoreToDesktop(app) {
  const src = app && app.path;
  if (!src) return { ok: false, msg: '没有路径' };
  if (!isShortcut(src)) return { ok: false, msg: '这是程序本体，不涉及桌面快捷方式' };
  if (!fs.existsSync(src)) return { ok: false, msg: '快捷方式副本已不在' };

  let desktop = '';
  try { desktop = require('electron').app.getPath('desktop'); }
  catch (e) { return { ok: false, msg: '拿不到桌面路径' }; }

  const ext = path.extname(src).toLowerCase();
  let name = path.basename(app.orig || '');
  if (!name) name = String(app.name || 'shortcut');
  if (!/\.(lnk|url)$/i.test(name)) name += ext;

  let dest = path.join(desktop, name);

  if (fs.existsSync(dest)) {
    // 内容一样：已经放回去了，不重复写
    try {
      if (fs.readFileSync(dest).equals(fs.readFileSync(src))) {
        return { ok: true, dest, name, existed: true };
      }
    } catch (e) { /* 读不了就按"不同"处理 */ }

    const stem = path.basename(name, ext);
    for (let i = 2; i < 100; i++) {
      const cand = path.join(desktop, `${stem} (${i})${ext}`);
      if (!fs.existsSync(cand)) { dest = cand; name = `${stem} (${i})${ext}`; break; }
    }
  }

  try {
    fs.copyFileSync(src, dest);
    return { ok: true, dest, name };
  } catch (e) {
    return { ok: false, msg: '复制到桌面失败：' + e.message };
  }
}

module.exports = { init, getAdoptDir, adopt, isShortcut, isAdopted, isOnDesktop, restoreToDesktop };
