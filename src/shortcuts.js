// .lnk 的创建 / 读取 / 更新 / 重命名 / 删除，全部基于 Electron 的 shell API
const { app, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_ID = 'com.zerodesk.app';

/* ---------------- 启动参数 ---------------- */
// 开发态：electron.exe 需要先拿到 app 目录，再跟 --group
//   "C:\...\electron.exe" "D:\...\desktop-launcher" --group=g123
// 打包后：
//   "C:\...\Zero Desk.exe" --group=g123
function argsForGroup(groupId) {
  const g = `--group=${groupId}`;
  return app.isPackaged ? g : `"${app.getAppPath()}" ${g}`;
}

function cwdForLaunch() {
  return app.isPackaged ? path.dirname(process.execPath) : app.getAppPath();
}

/**
 * 主入口（桌面上唯一那个图标）的启动参数：**不带 --group**。
 * 不带参数 = "把全部分区都打开给我看"，这正是单主入口模式要的语义。
 *
 * 开发态必须把 app 目录塞进参数，否则 electron.exe 起来的是它自己的欢迎页。
 */
function argsForMain() {
  return app.isPackaged ? '' : `"${app.getAppPath()}"`;
}

/* ---------------- 名称处理 ---------------- */
function sanitizeName(name) {
  return String(name)
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/[. ]+$/, '')
    .trim() || '未命名分区';
}

function lnkPathFor(desktopDir, groupName) {
  return path.join(desktopDir, `${sanitizeName(groupName)}.lnk`);
}

/* ---------------- 读写 ---------------- */
function read(lnkPath) {
  try { return shell.readShortcutLink(lnkPath); } catch (e) { return null; }
}

/** 正则转义：分区 id 正常是 'g' + 字母数字，但别指望它永远安全 */
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 匹配 args 里的 --group=<id>，带边界（'--group=g1' 不能吃掉 '--group=g10'） */
function groupArgRe(groupId) {
  return new RegExp(`--group=${escapeRe(groupId)}(\\s|$)`);
}

/**
 * 判断这个 .lnk 是不是**这个分区**的。
 *
 * 曾经这里先比 target、命中就直接 return true —— 那是错的：本程序建的所有 .lnk
 * 的 target 都是同一个 exe，于是 A 分区的 lnk 在问"你是 B 分区的吗"时也会答"是"。
 * 后果不是误判这么轻：rename 里 `if (存在 && !isOurs(新名, 我的id)) 抛错` 这道闸门会被
 * 直接绕过，接着 unlinkSync(新名) 就把另一个分区的桌面入口永久删了。
 *
 * 现在的规则：**传了 groupId 就只认 args 指纹**；没传 groupId（只想知道"是不是我们程序
 * 建的"）才退回比 target。args 跨打包方式稳定，target 会随 electron.exe → app.exe 变。
 */
function isOurs(lnkPath, groupId) {
  const s = read(lnkPath);
  if (!s) return false;
  if (groupId) return groupArgRe(groupId).test(s.args || '');
  return !!s.target
    && path.normalize(s.target).toLowerCase() === path.normalize(process.execPath).toLowerCase();
}

/**
 * 扫桌面，把这个分区的**所有**入口都找出来。
 *
 * 为什么需要"所有"而不是"第一个"：桌面上的入口是用户可以随便改名的普通文件，
 * 一旦配置里记的 `lnkPath` 和真实文件名对不上，光靠一条路径就会判断失误 ——
 * 表现为"改个名又长出一个新图标，旧的那个删了还回来"。
 * 唯一可靠的锚点是 `--group=` 指纹，所以这里把整个桌面扫一遍。
 */
function findAllByGroup(desktopDir, groupId) {
  const re = groupArgRe(groupId);
  let names = [];
  try { names = fs.readdirSync(desktopDir); } catch (e) { return []; }
  const out = [];
  for (const f of names) {
    if (!/\.lnk$/i.test(f)) continue;
    const full = path.join(desktopDir, f);
    const s = read(full);
    if (s && re.test(s.args || '')) out.push(full);
  }
  return out;
}

/**
 * 创建或覆盖分区快捷方式
 * @returns {{path:string, info:object}}
 */
function write(lnkPath, { groupId, groupName, iconPath }) {
  const opts = {
    target: process.execPath,
    args: argsForGroup(groupId),
    cwd: cwdForLaunch(),
    description: `Zero Desk · ${groupName}`,
    icon: iconPath || '',
    iconIndex: 0,
    appUserModelId: APP_ID
  };

  // 目标位置的同名快捷方式如果不是我们建的，别覆盖别人的
  const exists = fs.existsSync(lnkPath);
  if (exists && !isOurs(lnkPath, groupId)) {
    throw new Error(`桌面上已有同名快捷方式「${path.basename(lnkPath, '.lnk')}」，请换个分区名`);
  }

  fs.mkdirSync(path.dirname(lnkPath), { recursive: true });

  // 注意：'replace' 在文件不存在时会返回 false，所以新建必须用 'create'
  const op = exists ? 'update' : 'create';
  const ok = shell.writeShortcutLink(lnkPath, op, opts);
  if (!ok) throw new Error(`写入快捷方式失败（${op}）：` + lnkPath);

  return { path: lnkPath, info: read(lnkPath) };
}

/**
 * 更新已有快捷方式。
 * 早期版本这里"保留 target 与 args 只改图标/描述"，结果打包后会把过期的
 * electron.exe target 一路传播到新文件上。现在一律按当前进程重算 target/args。
 */
function update(lnkPath, { groupId, groupName, iconPath }) {
  if (!fs.existsSync(lnkPath)) throw new Error('快捷方式不存在：' + lnkPath);
  return write(lnkPath, { groupId, groupName, iconPath });
}

/**
 * 重命名：**不走 fs.renameSync**。
 *
 * 这是桌面的坑，不是文件系统的坑。fs.renameSync 只产生文件系统层的变更，
 * 资源管理器的桌面项在后台（窗口没激活）时经常漏处理"旧项该移除"这一条，
 * 屏幕上就留着一个旧名字的图标 —— 图标还在、双击提示找不到文件。用户看到的
 * 就是"改名后又多出来一个，原来那个还赖在桌面上"。
 *
 * 所以改成 Shell 层两步：
 *   1. 写新文件（shell.writeShortcutLink）
 *   2. 旧文件用 shell.trashItem 送回收站（IFileOperation）
 * 两步都会触发 SHChangeNotify，Explorer 必然重排该项，旧图标当场消失。
 *
 * 代价：桌面图标的位置可能被重排（新文件排在空位），换来"改名不留残影"。
 */
async function rename(oldPath, newPath, groupName, groupId, iconPath) {
  const samePath = path.normalize(oldPath).toLowerCase() === path.normalize(newPath).toLowerCase();

  // 只改大小写（"work.lnk" → "Work.lnk"）：Windows 上目标路径其实是同一个，
  // Shell 层改不了 casing，得借一次中转名让文件系统真的换大小写。
  if (samePath) {
    if (path.basename(oldPath) === path.basename(newPath)) {
      return update(newPath, { groupId, groupName, iconPath });
    }
    const tmp = `${oldPath}.case-${Date.now()}`;
    fs.renameSync(oldPath, tmp);
    try {
      fs.renameSync(tmp, newPath);
    } catch (e) {
      try { fs.renameSync(tmp, oldPath); } catch (e2) { /* 尽力恢复 */ }
      throw e;
    }
    return update(newPath, { groupId, groupName, iconPath });
  }

  // 1) 先写新文件。write 内部会拦"桌面上已有一个同名的、但不是我们建的快捷方式"
  write(newPath, { groupId, groupName, iconPath });

  // 2) 立刻回读校验：新文件确实是本分区的、args 对得上，才敢动旧文件
  const info = read(newPath);
  if (!info || !groupArgRe(groupId).test(info.args || '')) {
    try { await shell.trashItem(newPath); } catch (e) { /* 尽力撤销 */ }
    throw new Error('改名失败：新快捷方式写入异常，已撤销');
  }

  // 3) 旧文件走 Shell 删除（可撤销），桌面上那一项会立刻消失
  let warn = '';
  try {
    await shell.trashItem(oldPath);
  } catch (e) {
    // 回收站失败（被占用/策略限制）：退回直接删。内容已经完整写进新文件了，
    // 这里删掉的只是同一个分区的一个旧快捷方式副本，不是用户的文件。
    try { fs.unlinkSync(oldPath); } catch (e2) { warn = `旧快捷方式没能删除：${e2.message}`; }
  }
  return { path: newPath, info, warn };
}

/* ---------------- 主入口（桌面唯一图标） ---------------- */

/** 这个 .lnk 是不是"主入口"：target 指向本程序，且**没有** --group */
function isMain(lnkPath) {
  const s = read(lnkPath);
  if (!s || !s.target) return false;
  if (/--group=/.test(s.args || '')) return false;
  return path.normalize(expandEnv(s.target)).toLowerCase()
    === path.normalize(process.execPath).toLowerCase();
}

function expandEnv(p) {
  return String(p || '').replace(/%([^%]+)%/g, (m, k) => process.env[k] || m);
}

/**
 * 写主入口。跟 write() 的区别：
 *   - 参数里没有 --group（= 打开就是全部分区）
 *   - 同名文件只要不是"指向本程序且无参"的，就不覆盖，改用一个不冲突的名字
 *   - force=true 时不换名，直接就地覆盖。只给「已经确认是主入口、只是 target 过期」
 *     的修复用：exe 改名后 isMain 必然为 false（target 对不上），
 *     不 force 的话就会写出「Zero Desk-2.lnk」这种第二个图标。
 * 返回最终落到哪个路径。
 */
function writeMain(lnkPath, { iconPath, description, force = false } = {}) {
  const opts = {
    target: process.execPath,
    args: argsForMain(),
    cwd: cwdForLaunch(),
    description: description || 'Zero Desk · 全部软件',
    icon: iconPath || '',
    iconIndex: 0,
    appUserModelId: APP_ID
  };

  let out = lnkPath;
  if (!force && fs.existsSync(out) && !isMain(out)) {
    // 桌面上已经有一个同名、但不是我们建的东西：不抢，换个名字
    const dir = path.dirname(lnkPath);
    const base = path.basename(lnkPath, '.lnk');
    for (let i = 2; i < 100; i++) {
      const alt = path.join(dir, `${base}-${i}.lnk`);
      if (!fs.existsSync(alt) || isMain(alt)) { out = alt; break; }
    }
  }

  fs.mkdirSync(path.dirname(out), { recursive: true });
  const op = fs.existsSync(out) ? 'update' : 'create';
  const ok = shell.writeShortcutLink(out, op, opts);
  if (!ok) throw new Error(`写入主入口快捷方式失败（${op}）：` + out);
  return { path: out, info: read(out) };
}

/** 删除（默认进回收站，可撤销） */
async function remove(lnkPath, { permanent = false } = {}) {
  if (!fs.existsSync(lnkPath)) return false;
  if (permanent) { fs.unlinkSync(lnkPath); return true; }
  await shell.trashItem(lnkPath);
  return true;
}

function exists(lnkPath) {
  return !!lnkPath && fs.existsSync(lnkPath);
}

module.exports = {
  sanitizeName, lnkPathFor, argsForGroup, argsForMain,
  read, write, update, rename, remove, exists, isOurs, groupArgRe, escapeRe,
  findAllByGroup, isMain, writeMain
};
