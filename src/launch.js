// 启动一个条目。为什么不能用 shell.openPath 一把梭：
//
//   shell.openPath 走的是 ShellExecuteEx，它对**普通 exe / 普通 .lnk** 没问题，
//   但有两类会直接返回 "Failed to open path"：
//     1) .url（Steam 游戏快捷方式，内容是 steam://rungameid/xxx）—— 它不是文件关联，
//        本质是"一个装着 URL 的文本文件"，必须把里面的 URL 取出来走 openExternal；
//     2) UWP/MSIX 的 .lnk —— target/args/icon 全是空，只有内部 IDList 指向 AppsFolder，
//        ShellExecuteEx 认不出，得用 shell:AppsFolder\<包全名>!<AppId> 去唤。
//
// 实测（本机）：openPath 对这两类都返回 "Failed to open path"，对普通 exe 返回空串（成功）。
// 所以这里按类型分流，并且每一级失败都往下兜底，最后一级用 cmd start 模拟双击。

const path = require('path');
const fs = require('fs');
const { shell } = require('electron');
const { spawn } = require('child_process');

/** .url 文件里取 URL= 那一行（可能是 UTF-8 也可能是 UTF-16） */
function urlOfFile(p) {
  let t = '';
  try { t = fs.readFileSync(p, 'utf8'); } catch (e) { return ''; }
  let m = /^\s*URL\s*=\s*(.+)$/im.exec(t);
  if (!m) {
    try { t = fs.readFileSync(p, 'utf16le'); } catch (e) { /* 忽略 */ }
    m = /^\s*URL\s*=\s*(.+)$/im.exec(t);
  }
  return m ? m[1].trim() : '';
}

/**
 * 从 UWP 的 .lnk 里抠出 "包全名!AppId"。
 * .lnk 里 AUMID 以 UTF-16 存在（IDList 段），包全名形如
 *   4651ED44255E.47979655102CE_k6txddmbb6c52
 * 即「名字_13位小写base32发布者ID」，后面跟 "!AppId"。
 */
function aumidOfLnk(lnkPath) {
  let buf;
  try { buf = fs.readFileSync(lnkPath); } catch (e) { return ''; }
  const txt = buf.toString('utf16le') + '\n' + buf.toString('latin1');
  const m = /([A-Za-z0-9][A-Za-z0-9._-]*_[a-z0-9]{13})!([A-Za-z0-9._-]+)/.exec(txt);
  if (m) return m[1] + '!' + m[2];
  // 有的只写了包全名，AppId 默认 App
  const m2 = /([A-Za-z0-9][A-Za-z0-9._-]*_[a-z0-9]{13})/.exec(txt);
  return m2 ? m2[1] + '!App' : '';
}

/** 最后兜底：cmd start，等价于在资源管理器里双击 */
function startByShell(p) {
  return new Promise((resolve) => {
    try {
      const child = spawn('cmd.exe', ['/c', 'start', '', p], {
        windowsHide: true,
        detached: true,
        stdio: 'ignore'
      });
      child.on('error', (e) => resolve({ ok: false, msg: 'cmd start 失败：' + e.message }));
      child.unref();
      // start 自己不等程序退出，spawn 成功即视为"已交给系统"
      setTimeout(() => resolve({ ok: true, method: 'cmd-start' }), 120);
    } catch (e) {
      resolve({ ok: false, msg: 'cmd start 异常：' + e.message });
    }
  });
}

async function tryOpenPath(p) {
  try {
    const err = await shell.openPath(p);
    return err ? { ok: false, msg: err } : { ok: true, method: 'openPath' };
  } catch (e) {
    return { ok: false, msg: e.message };
  }
}

/** 借 explorer 唤醒 UWP：explorer.exe "shell:AppsFolder\<AUMID>" */
function tryExplorerAppsFolder(aumid) {
  return new Promise((resolve) => {
    try {
      const child = spawn('explorer.exe', ['shell:AppsFolder\\' + aumid], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.on('error', (e) => resolve({ ok: false, msg: e.message }));
      child.unref();
      setTimeout(() => resolve({ ok: true, method: 'explorer' }), 120);
    } catch (e) {
      resolve({ ok: false, msg: e.message });
    }
  });
}

async function tryOpenExternal(u) {
  try {
    await shell.openExternal(u);
    return { ok: true, method: 'openExternal' };
  } catch (e) {
    return { ok: false, msg: e.message };
  }
}

/**
 * 启动一个已登记的条目。
 * @returns {{ok:boolean, method?:string, msg?:string}}
 */
async function open(p) {
  if (!p) return { ok: false, msg: '路径为空' };
  // missing 标记 = "这不是启动失败，是这个软件已经不在了"。
  // 上层据此弹"要不要从收纳盒移除"，而不是甩一句冷冰冰的报错。
  if (!fs.existsSync(p)) {
    return { ok: false, missing: true, msg: '程序不见了：' + path.basename(p) };
  }

  const ext = path.extname(p).toLowerCase();
  const tried = [];

  // ---------- 1) .url：取出 URL 走协议 ----------
  if (ext === '.url') {
    const u = urlOfFile(p);
    if (u) {
      const r = await tryOpenExternal(u);
      if (r.ok) return { ok: true, method: 'url→' + r.method, url: u };
      tried.push('openExternal(' + u + '): ' + r.msg);
    } else {
      tried.push('读不到 URL 字段');
    }
    const r2 = await tryOpenPath(p);
    if (r2.ok) return { ok: true, method: 'url→openPath' };
    tried.push('openPath: ' + r2.msg);
    const r3 = await startByShell(p);
    if (r3.ok) return { ok: true, method: 'url→cmd-start' };
    tried.push('cmd-start: ' + r3.msg);
    return { ok: false, msg: '这个网页快捷方式打不开。' + (u ? 'URL：' + u : '') + ' ｜ ' + tried.join(' ｜ ') };
  }

  // ---------- 2) .lnk ----------
  if (ext === '.lnk') {
    let info = null;
    try { info = shell.readShortcutLink(p); } catch (e) { tried.push('读 .lnk 失败: ' + e.message); }
    const target = info ? (info.target || '') : '';
    const args = info ? (info.args || '') : '';

    // 2a) UWP：target 为空，靠 AUMID
    if (info && !target) {
      const aumid = aumidOfLnk(p);
      if (aumid) {
        const r = await tryOpenExternal('shell:AppsFolder\\' + aumid);
        if (r.ok) return { ok: true, method: 'uwp→openExternal', aumid };
        tried.push('openExternal(shell:AppsFolder): ' + r.msg);
        // 有些环境 openExternal 不放行 shell: 协议，直接叫 explorer 去唤醒
        const r2 = await tryExplorerAppsFolder(aumid);
        if (r2.ok) return { ok: true, method: 'uwp→explorer', aumid };
        tried.push('explorer(shell:AppsFolder): ' + r2.msg);
      } else {
        tried.push('抠不出 AUMID');
      }
      const r3 = await tryOpenPath(p);
      if (r3.ok) return { ok: true, method: 'uwp→openPath' };
      tried.push('openPath: ' + r3.msg);
      const r4 = await startByShell(p);
      if (r4.ok) return { ok: true, method: 'uwp→cmd-start' };
      tried.push('cmd-start: ' + r4.msg);
      return { ok: false, msg: '商店应用打不开' + (aumid ? '（' + aumid + '）' : '') + '：' + tried.join(' ｜ ') };
    }

    // 2b) target 本身就是协议（steam:// epic:// 之类）
    if (target && /^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
      const r = await tryOpenExternal(target + (args ? ' ' + args : ''));
      if (r.ok) return { ok: true, method: 'lnk→协议', url: target };
      tried.push('openExternal(协议): ' + r.msg);
    }

    // 2c) 普通 .lnk：目标不存在就别硬启动（否则系统会弹一个莫名其妙的错误框）
    if (target && !/^[a-z][a-z0-9+.-]*:\/\//i.test(target) && !fs.existsSync(target)) {
      return { ok: false, missing: true, target, msg: '目标程序不在了：' + target };
    }

    const r1 = await tryOpenPath(p);
    if (r1.ok) return { ok: true, method: 'lnk→openPath' };
    tried.push('openPath(lnk): ' + r1.msg);

    // 2d) 直接启动 target（会丢参数，所以排在 .lnk 之后）
    if (target) {
      const r2 = await tryOpenPath(target);
      if (r2.ok) return { ok: true, method: 'lnk→openPath(target)', warn: args ? '启动参数可能丢失' : '' };
      tried.push('openPath(target): ' + r2.msg);
    }

    const r3 = await startByShell(p);
    if (r3.ok) return { ok: true, method: 'lnk→cmd-start' };
    tried.push('cmd-start: ' + r3.msg);
    return { ok: false, msg: '打不开：' + path.basename(p) + ' ｜ ' + tried.join(' ｜ ') };
  }

  // ---------- 3) exe / 其他 ----------
  const r1 = await tryOpenPath(p);
  if (r1.ok) return { ok: true, method: 'openPath' };
  tried.push('openPath: ' + r1.msg);

  try {
    const child = spawn(p, [], { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', () => { /* 交给下面的兜底 */ });
    child.unref();
    return { ok: true, method: 'spawn' };
  } catch (e) {
    tried.push('spawn: ' + e.message);
  }

  const r3 = await startByShell(p);
  if (r3.ok) return { ok: true, method: 'cmd-start' };
  tried.push('cmd-start: ' + r3.msg);
  return { ok: false, msg: '打不开：' + path.basename(p) + ' ｜ ' + tried.join(' ｜ ') };
}

module.exports = { open, urlOfFile, aumidOfLnk };
