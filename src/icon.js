// 图标：图片→ICO 转换、程序图标提取、分区图标缓存
const { app, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { encodePNG } = require('./png');
const peicon = require('./peicon');
const { execFile } = require('child_process');

let iconsDir = '';

function init(userDataDir) {
  const want = path.join(userDataDir, 'icons');
  try {
    fs.mkdirSync(want, { recursive: true });
    iconsDir = want;
  } catch (e) {
    // 权限被拒 / 磁盘满 / 路径被同名文件占着 —— 不能因为这行 throw 把主进程带崩，
    // 让用户看到"程序打不开"却不知道为什么。降级到临时目录，功能照用。
    console.error('[icon.init] 图标目录不可用，降级到临时目录:', e.message);
    const fallback = path.join(require('os').tmpdir(), 'desktop-launcher-icons');
    try {
      fs.mkdirSync(fallback, { recursive: true });
      iconsDir = fallback;
    } catch (e2) {
      console.error('[icon.init] 临时目录也建不出来，图标功能将不可用:', e2.message);
      iconsDir = '';
    }
  }
}
function getIconsDir() { return iconsDir; }

/** 原子写：图标文件写一半被强杀会留个坏 .ico，分区图标和桌面 lnk 图标一起变白块 */
function writeFileAtomic(file, buf) {
  if (!iconsDir) throw new Error('图标目录不可用');
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, buf);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
    throw e;
  }
}

/* ---------------- ICO 容器 ---------------- */
// Windows Vista+ 的 ICO 允许条目直接内嵌 PNG，所以只需拼 6 字节头 + 16 字节目录项
function buildIcoFromPng(pngBuffer, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(1, 4); // count

  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size; // 0 表示 256
  entry[1] = size >= 256 ? 0 : size;
  entry[2] = 0;  // palette
  entry[3] = 0;  // reserved
  entry.writeUInt16LE(1, 4);        // color planes
  entry.writeUInt16LE(32, 6);       // bits per pixel
  entry.writeUInt32LE(pngBuffer.length, 8);
  entry.writeUInt32LE(22, 12);      // offset = 6 + 16

  return Buffer.concat([header, entry, pngBuffer]);
}

/** 把 png/jpg/ico 转成 256×256 的 .ico 文件，返回绝对路径 */
function imageToIco(srcPath, baseName) {
  const img = nativeImage.createFromPath(srcPath);
  if (img.isEmpty()) throw new Error(notImageMsg(srcPath));

  const target = img.resize({ width: 256, height: 256, quality: 'best' });
  const png = target.toPNG();
  const ico = buildIcoFromPng(png, 256);

  const out = path.join(iconsDir, `${baseName}.ico`);
  writeFileAtomic(out, ico);
  return out;
}

/** 图片读不出来时给句人话：webp 是否可用取决于系统解码器，别让用户对着"无效图片"发懵 */
function notImageMsg(srcPath) {
  return /\.webp$/i.test(String(srcPath))
    ? '系统解不开 webp，请用画图/截图另存为 png 再选'
    : '这个文件不是有效图片';
}

/* ---------------- 默认分区图标（纯色圆角方块） ---------------- */
function roundRectRGBA(size, radius, rgb) {
  const buf = Buffer.alloc(size * size * 4);
  const r = radius;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 圆角矩形：四个角做圆边判断
      const cx = Math.min(Math.max(x, r), size - r);
      const cy = Math.min(Math.max(y, r), size - r);
      const dx = x - cx;
      const dy = y - cy;
      const inside = dx * dx + dy * dy <= r * r;
      const i = (y * size + x) * 4;
      if (!inside) { buf[i + 3] = 0; continue; }
      // 上浅下深的轻微渐变，避免死板
      const t = y / size;
      buf[i] = Math.round(rgb[0] * (1 - t * 0.22));
      buf[i + 1] = Math.round(rgb[1] * (1 - t * 0.22));
      buf[i + 2] = Math.round(rgb[2] * (1 - t * 0.22));
      buf[i + 3] = 255;
    }
  }
  return buf;
}

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

function hashHue(text) {
  let h = 0;
  for (const ch of String(text)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

/** 给渲染层用的同一个取色函数：主进程和界面算出来的颜色必须一致，否则分区图标是紫色、字母占位是青色 */
function hueOf(text) { return hashHue(text); }

/** 按分区名生成一个稳定的彩色圆角方块图标 */
function makeDefaultGroupIco(name, seedName) {
  const hue = hashHue(seedName || name);
  const rgb = hslToRgb(hue, 0.52, 0.55);
  const rgba = roundRectRGBA(256, 62, rgb);
  const png = encodePNG(256, 256, rgba);
  const ico = buildIcoFromPng(png, 256);
  const file = path.join(iconsDir, `group-${crypto.createHash('md5').update(String(seedName || name)).digest('hex').slice(0, 10)}.ico`);
  writeFileAtomic(file, ico);
  return file;
}

/* ---------------- 程序图标 ---------------- */
function expandEnv(p) {
  return String(p || '').replace(/%([^%]+)%/g, (m, k) => process.env[k] || m);
}

/** 读 .lnk 的解析结果（Electron 自带 C++ 实现，不碰被禁的 COM） */
function lnkInfo(p) {
  try { return shell.readShortcutLink(p); } catch (e) { return null; }
}

/** IconLocation 形如 "C:\a.ico,0" 或 "%SystemRoot%\x.exe,3" */
function splitIconLocation(loc) {
  if (!loc) return null;
  const m = /^(.*?)\s*,\s*-?\d+$/.exec(loc.trim());
  const raw = (m ? m[1] : loc).replace(/^"|"$/g, '').trim();
  const f = expandEnv(raw);
  try { return f && fs.existsSync(f) ? f : null; } catch (e) { return null; }
}

// 兜底：只有 readShortcutLink 抛异常时才走二进制扫描
function extractExeFromLnk(p) {
  let buf;
  try { buf = fs.readFileSync(p); } catch (e) { return null; }
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x0000004c) return null;

  const re = /[A-Za-z]:\\[^\x00-\x1f"<>|*?]{1,259}?\.(?:exe|bat|cmd|msi|ps1|jar)/gi;
  const hits = [];
  const scan = (text) => { let m; while ((m = re.exec(text)) !== null) hits.push(m[0]); re.lastIndex = 0; };
  scan(buf.toString('latin1'));
  scan(buf.toString('utf16le'));
  scan(buf.slice(1).toString('utf16le'));

  for (const h of hits) {
    try { if (fs.existsSync(h)) return h; } catch (e) { /* ignore */ }
  }
  return null;
}

/** 拿到 .lnk 真正指向的可执行文件：优先正规解析，失败才扫二进制 */
function lnkTarget(p) {
  const info = lnkInfo(p);
  if (info && info.target) {
    const t = expandEnv(info.target);
    if (/^shell:/i.test(t)) return null;             // UWP：没有传统 exe
    try { if (fs.existsSync(t)) return t; } catch (e) { /* 落到扫描 */ }
  }
  return extractExeFromLnk(p);
}

/** 把 png/jpg/ico 转成 256×256 的 .png 文件（给单个软件换图标用），返回绝对路径 */
function imageToPngFile(srcPath, baseName) {
  const img = nativeImage.createFromPath(srcPath);
  if (img.isEmpty()) throw new Error(notImageMsg(srcPath));

  const target = img.resize({ width: 256, height: 256, quality: 'best' });
  const out = path.join(iconsDir, `${baseName}.png`);
  writeFileAtomic(out, target.toPNG());
  return out;
}

/* ---------------- 产品图标（Zero Desk） ----------------
 * 图形是设计稿导出的静态资源，放在包内 assets/ 下：
 *   icon.ico   9 档 PNG-in-ICO（16/20/24/32/40/48/64/128/256），给快捷方式与 exe 用
 *   icon.png   512×512，给需要大图的地方用
 *   tray-*.png 16/20/24/32 四档，给托盘用
 * 这样图标换了只换文件，不用改代码、不用重新画。
 */
function assetsDir() {
  return path.join(app.getAppPath(), 'assets');
}

/**
 * 托盘图标：按 DPI 把各档原图都挂上去，让系统挑最合适的一张。
 * 只给一张 32px 让系统缩放的话，16px 档会糊成一团（圆环本身就很细）。
 */
function makeTrayImage() {
  const img = nativeImage.createEmpty();
  const sizes = [16, 20, 24, 32];
  let added = 0;
  for (const size of sizes) {
    let buf;
    try { buf = fs.readFileSync(path.join(assetsDir(), `tray-${size}.png`)); }
    catch (e) { continue; }
    img.addRepresentation({ scaleFactor: size / 16, buffer: buf });
    added++;
  }
  if (!added) console.error('[icon] 托盘图标缺失（assets/tray-*.png）');
  return img;
}

/**
 * 主入口快捷方式的图标 = 产品图标 .ico。
 *
 * 文件名带**内容指纹**：Windows 图标缓存按「路径」缓存，同名覆盖内容的话，
 * 桌面会一直显示旧图（分区图标那次的教训）。指纹不变就复用同一个文件，
 * 不会每次启动攒垃圾；图形一换文件名自动变，缓存自然失效。
 * 也刻意不叫 group-/app-，gcIcons 只回收那两个前缀，不会误删它。
 */
function makeLauncherIco() {
  const src = path.join(assetsDir(), 'icon.ico');
  let buf;
  try { buf = fs.readFileSync(src); }
  catch (e) {
    // 打包时漏了 assets 就是这里报错：没有图标总比程序起不来强，返回空串走系统默认图
    console.error('[icon] 主入口图标缺失（assets/icon.ico）:', e.message);
    return '';
  }
  const tag = crypto.createHash('md5').update(buf).digest('hex').slice(0, 8);
  const file = path.join(iconsDir, `launcher-${tag}.ico`);
  if (!fs.existsSync(file)) writeFileAtomic(file, buf);

  // 旧版留在 icons/ 里的 launcher*.ico 已经没人引用了，顺手收掉（不匹配 gcIcons 的规则）。
  try {
    for (const f of fs.readdirSync(iconsDir)) {
      if (!/^launcher(-[0-9a-f]{8})?\.ico$/i.test(f)) continue;
      if (path.basename(file) === f) continue;
      try { fs.unlinkSync(path.join(iconsDir, f)); } catch (e) { /* 占用中就先留着 */ }
    }
  } catch (e) { /* ignore */ }
  return file;
}

/**
 * 自己从 exe/dll 的资源段里抠图标，返回 64×64 dataURL；抠不到返回 null。
 *
 * 非要有这一条的原因：app.getFileIcon() 对相当一部分程序只给**系统通用图标**。
 * 实测 Kimi / 千问办公 / Watt Toolkit 拿到的 dataURL 长度一模一样（3726），
 * 也就是同一张白纸 —— 用户看到的就是"除了 Epic 全是字母/白纸"。
 */
function iconFromPe(exePath) {
  if (!iconsDir) return null;
  const buf = peicon.extractIcoBuffer(exePath, 256);
  if (!buf) return null;

  const out = path.join(iconsDir,
    'pe-' + crypto.createHash('md5').update(String(exePath).toLowerCase()).digest('hex').slice(0, 12) + '.ico');
  try {
    // 程序升级后图标会变，靠文件大小判断要不要重写（够用且便宜）
    let stale = true;
    try { if (fs.existsSync(out) && fs.statSync(out).size === buf.length) stale = false; } catch (e) { /* 重写 */ }
    if (stale) writeFileAtomic(out, buf);
  } catch (e) {
    // 落盘失败就退化成"内存里直接用"：nativeImage 只认路径，读不到就只能放弃
    return null;
  }

  const img = nativeImage.createFromPath(out);
  if (img.isEmpty()) return null;
  return img.resize({ width: 64, height: 64, quality: 'best' }).toDataURL();
}

/**
 * UWP / MSIX 应用（ChatGPT、Watt Toolkit 这类商店应用）的快捷方式里
 * **根本没有 exe 路径**，只有一串 Application User Model ID，形如
 *   4651ED44255E.47979655102CE_k6txddmbb6c52!App
 * 所以 readShortcutLink 返回的 target 是空字符串，lnkTarget 也找不出东西，
 * 最后只能落到一张通用的白色快捷方式图标 —— 用户看到的就是"这个是白纸"。
 *
 * 这类应用的图标实在包目录里：C:\Program Files\WindowsApps\<包全名>\images\Square44x44Logo*.png
 * 这里按"AUMID 里的 名称_PublisherId"去匹配包目录，再从里面挑最大的一张 logo。
 */
// 包目录可能在别的盘（Windows 允许把商店应用装到其它卷），所以按系统环境变量取
const WINDOWS_APPS = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'WindowsApps');

/** 从 .lnk 二进制里挖 AUMID 的 "名称_PublisherId" 部分；不是 UWP 就返回 null */
function aumidOf(lnkPath) {
  let buf;
  try { buf = fs.readFileSync(lnkPath); } catch (e) { return null; }
  if (buf.length < 0x4c || buf.readUInt32LE(0) !== 0x0000004c) return null;
  const txt = buf.toString('utf16le') + '\n' + buf.toString('latin1');
  // PublisherId 固定 13 位小写 base32；前面是包名（含点、大写、数字）
  const m = /([A-Za-z0-9][A-Za-z0-9._-]*_[a-z0-9]{13})!/.exec(txt);
  return m ? m[1] : null;
}

/** pfn（包族名）→ 包目录，进程内缓存，避免每次刷新图标都再问一次系统 */
const pkgDirCache = new Map();

/**
 * 列 WindowsApps 根目录这条快路在默认系统上**一定失败**：
 * 该目录 ACL 只给了 Users「遍历到已知子目录」的权限，没给「列出内容」的权限，
 * 非管理员 readdirSync 直接 EPERM（实测：本机 + 非提权）。
 *
 * 但只要**知道确切目录名**，里面的文件（含 images\*.png）是读得到的。
 * 所以退一步用 Shell 问系统要 InstallLocation —— 这条路不需要管理员，
 * 实测 150ms 左右，结果缓存起来，一个 UWP 应用一辈子只问一次。
 */
function pkgDirViaShell(pfn) {
  const i = pfn.lastIndexOf('_');
  if (i <= 0) return Promise.resolve(null);
  const name = pfn.slice(0, i).replace(/'/g, '');
  const script = `(Get-AppxPackage -Name '${name}' | Select-Object -First 1).InstallLocation`;
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      { timeout: 4000, windowsHide: true, encoding: 'utf8', maxBuffer: 1 << 20 },
      (err, stdout) => {
        if (err) return resolve(null);
        const p = String(stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
        if (!p) return resolve(null);
        try { resolve(fs.existsSync(p) ? p : null); } catch (e) { resolve(null); }
      }
    );
  });
}

async function resolvePackageDir(pfn) {
  if (pkgDirCache.has(pfn)) {
    const hit = pkgDirCache.get(pfn);
    // 应用更新后旧目录会消失，命中也要验一下，失效就重新解析
    try { if (hit && fs.existsSync(hit)) return hit; } catch (e) { /* 继续重查 */ }
    pkgDirCache.delete(pfn);
  }

  const i = pfn.lastIndexOf('_');
  if (i <= 0) return null;
  const name = pfn.slice(0, i);
  const pub = pfn.slice(i + 1);

  let picked = null;
  try {
    const dirs = fs.readdirSync(WINDOWS_APPS);
    const cands = dirs.filter((d) => d.startsWith(name + '_') && d.endsWith('__' + pub));
    if (cands.length) {
      cands.sort();                              // 包全名里带版本号，字典序最后的就是最新
      picked = path.join(WINDOWS_APPS, cands[cands.length - 1]);
    }
  } catch (e) { /* 预期内的 EPERM，走下面的 Shell 查询 */ }

  if (!picked) picked = await pkgDirViaShell(pfn);
  if (!picked) return null;

  pkgDirCache.set(pfn, picked);
  return picked;
}

/** 从清单里读它自己声明的方块图名字（不同应用可能叫 Assets\logo.png，不能写死） */
function logoBaseFromManifest(dir) {
  try {
    const t = fs.readFileSync(path.join(dir, 'AppxManifest.xml'), 'utf8');
    const m = /Square44x44Logo\s*=\s*"([^"]+)"/i.exec(t);
    if (!m) return '';
    return m[1].replace(/\//g, '\\');
  } catch (e) { return ''; }
}

/**
 * 在包目录里挑一张最合适的方块图标。
 * 打分逻辑（而不是写死一串文件名）：targetsize 权重最高，其次 scale，
 * 同分辨率下优先 unplated（不带底板、带透明通道，贴在深色格子上才好看）。
 */
function findLogoPng(dir) {
  const base = logoBaseFromManifest(dir);
  const baseDirRel = base ? path.dirname(base) : '';
  const baseName = base ? path.basename(base, path.extname(base)) : '';

  const scanDirs = [];
  if (baseDirRel) scanDirs.push(baseDirRel);
  for (const d of ['images', 'Assets', '']) if (!scanDirs.includes(d)) scanDirs.push(d);

  const score = (f) => {
    let s = 0;
    const t = /targetsize-(\d+)/i.exec(f);
    if (t) s += Number(t[1]) * 10;
    const sc = /scale-(\d+)/i.exec(f);
    if (sc) s += Number(sc[1]);
    if (/lightunplated/i.test(f)) s += 60;
    else if (/unplated/i.test(f)) s += 50;
    if (/\.targetsize-/i.test(f) && !/scale-/i.test(f)) s += 5;
    return s;
  };

  // 1) 优先：和清单声明的 base 同名前缀的变体
  if (baseName) {
    let best = null;
    let bestScore = -1;
    for (const sub of scanDirs) {
      const d = path.join(dir, sub);
      let list;
      try { list = fs.readdirSync(d); } catch (e) { continue; }
      for (const f of list) {
        if (!/\.png$/i.test(f)) continue;
        if (!f.toLowerCase().startsWith(baseName.toLowerCase())) continue;
        const s = score(f);
        if (s > bestScore) { bestScore = s; best = path.join(d, f); }
      }
      if (best) break;
    }
    if (best) return best;
  }

  // 2) 兜底：任何带 logo 字样的 png（排除徽标/启动图这类明显不是主体图标的）
  let best = null;
  let bestScore = -1;
  for (const sub of scanDirs) {
    const d = path.join(dir, sub);
    let list;
    try { list = fs.readdirSync(d); } catch (e) { continue; }
    for (const f of list) {
      if (!/\.png$/i.test(f)) continue;
      if (!/logo/i.test(f)) continue;
      if (/badge|splash|store|wide|smalltile|large/i.test(f)) continue;
      const s = score(f);
      if (s > bestScore) { bestScore = s; best = path.join(d, f); }
    }
  }
  return best;
}

/** UWP 包图标 → 64×64 dataURL */
async function uwpIconDataURL(lnkPath) {
  const pfn = aumidOf(lnkPath);
  if (!pfn) return null;
  const dir = await resolvePackageDir(pfn);
  if (!dir) return null;
  const png = findLogoPng(dir);
  if (!png) return null;
  try {
    const img = nativeImage.createFromPath(png);
    if (img.isEmpty()) return null;
    return img.resize({ width: 64, height: 64, quality: 'best' }).toDataURL();
  } catch (e) { return null; }
}

/** 取程序图标，返回 64×64 的 dataURL；取不到返回 null（界面用占位） */
/** .url（网页 / Steam 游戏快捷方式）里常带 IconFile，getFileIcon 不认，得自己读 */
function iconFileFromUrl(p) {
  let txt = '';
  try {
    const buf = fs.readFileSync(p);
    // .url 可能是 UTF-8 / UTF-16LE（有无 BOM、首字节对齐不同）/ ANSI(GBK)。
    // 中文路径只有按 GBK 解才对得上，所以最后两步专门给中文准备。
    const tries = [
      () => buf.toString('utf8'),
      () => buf.toString('utf16le'),
      () => buf.slice(1).toString('utf16le'),   // 没 BOM 时对齐可能差一个字节
      () => buf.toString('latin1'),
      () => new TextDecoder('gbk').decode(buf)  // Electron 主进程带 full-ICU
    ];
    for (const t of tries) {
      try {
        const s = t();
        if (/IconFile/i.test(s)) { txt = s; break; }
      } catch (e) { /* 某个解码器不可用就试下一个 */ }
    }
  } catch (e) { return null; }

  const m = txt.match(/^\s*IconFile\s*=\s*(.+?)\s*$/im);
  if (!m) return null;
  const f = expandEnv(m[1].trim().replace(/^"|"$/g, ''));
  try { return f && fs.existsSync(f) ? f : null; } catch (e) { return null; }
}

async function appIconDataURL(targetPath) {
  if (!fs.existsSync(targetPath)) return null;

  // .url 优先用它自己声明的 IconFile（游戏图标通常在这里）
  if (/\.url$/i.test(targetPath)) {
    const ico = iconFileFromUrl(targetPath);
    if (ico) {
      try {
        const img = nativeImage.createFromPath(ico);
        if (!img.isEmpty()) return img.resize({ width: 64, height: 64, quality: 'best' }).toDataURL();
      } catch (e) { /* 落到下面的 getFileIcon */ }
    }
  }

  // .lnk 优先看它自己声明的 IconLocation（用户/安装器换过图标时，这才是对的）
  const candidates = [];
  if (/\.lnk$/i.test(targetPath)) {
    const info = lnkInfo(targetPath);
    const declared = info ? splitIconLocation(info.icon) : null;
    if (declared) {
      try {
        const img = nativeImage.createFromPath(declared);
        if (!img.isEmpty()) return img.resize({ width: 64, height: 64, quality: 'best' }).toDataURL();
      } catch (e) { /* 继续 */ }
    }

    // UWP/MSIX 识别（两种形态都要拦）：
    //   ① target 为空 —— Windows 自己创建的商店应用快捷方式，只有包 AUMID；
    //   ② target 是 explorer.exe、参数是 shell:AppsFolder\<AUMID> —— 安装器造的
    //      商店快捷方式（实测 ChatGPT/微软商店版）。不拦住的话，下面会把
    //      explorer.exe 当目标去抓图标，永远是错的。
    //   它们声明的 IconLocation 往往写死"带版本号的包路径"，商店应用一更新就失效
    //   （26.1016.6573.0 → 26.1027.3384.0 旧目录即不存在），所以不能依赖声明，
    //   要按 AUMID 现查包目录拿 logo。
    const argsStr = String((info && info.args) || '');
    const uwpLike = (!info || !info.target)
      || (/explorer\.exe$/i.test(String((info && info.target) || '')) && /shell:AppsFolder/i.test(argsStr))
      || /^shell:AppsFolder/i.test(argsStr.trim());
    if (uwpLike) {
      const uwp = await uwpIconDataURL(targetPath);
      if (uwp) return uwp;
      // 确认是 UWP 应用、但包目录实在拿不到（Shell 查询也失败，比如 PowerShell 被组织策略禁用）。
      // 这时候**不要**再往下走 getFileIcon —— 实测它对 UWP 快捷方式只会返回
      // 一张"白纸+箭头"的通用图标，比界面上的字母色块还难看。返回 null 让界面兜底。
      if (aumidOf(targetPath)) return null;
    }

    const exe = lnkTarget(targetPath);
    if (exe) candidates.push(exe);
    candidates.push(targetPath);   // 最后再试快捷方式本身（有时会带图标）
  } else {
    candidates.push(targetPath);
  }

  for (const t of candidates) {
    // exe/dll 先自己解析资源段：getFileIcon 对这些程序经常只给通用白纸图标，
    // 而程序名写在 exe 里，图标也在 exe 里，没必要问系统。
    if (/\.(exe|dll)$/i.test(t)) {
      const own = iconFromPe(t);
      if (own) return own;
    }
    try {
      // size 实测（Electron 45 / Windows 11 / notepad.exe）：
      //   small 16×16、normal 32×32、large **48×48**、extraLarge 32×32、jumbo 32×32
      // 所以 large 是唯一能拿到 48 的档位，extraLarge/jumbo 反而更小 —— 别改成它们。
      // 48 → 64 只是轻度放大；再想清楚只能自己解析 exe 的 PE 图标资源，不值得。
      const img = await app.getFileIcon(t, { size: 'large' });
      if (img.isEmpty()) continue;
      const big = img.resize({ width: 64, height: 64, quality: 'best' });
      return big.toDataURL();
    } catch (e) { /* 换下一个 */ }
  }
  return null;
}

/* ---------------- 清理没人引用的图标文件 ---------------- */
/**
 * icons/ 里全是**衍生数据**：换过图标、删过分区之后源图还在用户手里，删了随时能重建。
 * 这跟 shortcuts/ 的副本完全不同（那些可能是用户唯一一份，坚决不动）。
 * 只删本程序命名的 group-*.ico / app-*.png，别的一概不碰。
 */
function gcIcons(referencedFiles) {
  if (!iconsDir || !fs.existsSync(iconsDir)) return 0;
  const keep = new Set((referencedFiles || [])
    .filter(Boolean)
    .map((p) => path.normalize(p).toLowerCase()));
  let n = 0;
  const peFiles = [];
  for (const f of fs.readdirSync(iconsDir)) {
    const full = path.join(iconsDir, f);
    // pe-*.ico 是"从 exe 里抠出来的图标"，数量跟装过多少程序走。
    // 它不像 group-/app- 那样能直接从配置里查到引用关系（配置里记的是 exe 路径），
    // 所以不逐个判断，只做总量控制：超了就按最久没碰过的删。
    if (/^pe-[0-9a-f]+\.ico$/i.test(f)) {
      try { peFiles.push({ full, t: fs.statSync(full).mtimeMs }); } catch (e) { /* 读不到就跳过 */ }
      continue;
    }
    // 只认本程序起的名字：group-<分区id或md5>.ico / app-<md5>.png
    if (!/^(group|app)-[0-9a-z]+\.(ico|png)$/i.test(f)) continue;
    if (keep.has(path.normalize(full).toLowerCase())) continue;
    try { fs.unlinkSync(full); n++; } catch (e) { /* 占用中就下次再说 */ }
  }

  const PE_KEEP = 300;
  if (peFiles.length > PE_KEEP) {
    peFiles.sort((a, b) => b.t - a.t);              // 新的在前
    for (const p of peFiles.slice(PE_KEEP)) {
      try { fs.unlinkSync(p.full); n++; } catch (e) { /* ignore */ }
    }
  }
  return n;
}

module.exports = {
  init, getIconsDir,
  buildIcoFromPng, imageToIco, imageToPngFile, makeDefaultGroupIco, makeTrayImage, makeLauncherIco,
  extractExeFromLnk, lnkTarget, lnkInfo, appIconDataURL, iconFileFromUrl,
  uwpIconDataURL, aumidOf, iconFromPe,
  expandEnv, hueOf, gcIcons
};
