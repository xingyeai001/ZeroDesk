// 配置持久化：分区、软件、窗口位置、主题
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

let file = '';
let data = null;
let brokenBackup = '';   // 本次启动是否从坏配置里救过残骸（供上层提示用户）

const DEFAULTS = () => ({
  version: 2,
  inited: false,        // 是否已做过首次初始化（避免删光分区后又自动补一个）
  groups: [],           // [{ id, name, iconPath(.ico), lnkPath, apps:[{name, path, iconFile}], createdAt }]
  win: { width: 780, height: 540, x: null, y: null },
  theme: 'system',      // system | light | dark
  material: 'solid',    // solid | acrylic | mica
  closeToTray: false,   // 点 X 是收进托盘还是退出（默认退出：Electron 常驻约 88MB，不值当）
  // 加入软件后桌面原件怎么办：true=直接收走（默认） false=留在桌面 null=每次问
  // 默认收走，是因为"拖进去"在用户心里就等于"挪进去"：
  // 拖完还要自己回桌面删一遍图标，是这套流程最招人烦的地方。
  // 收走是进回收站，随时能还原；想留在桌面也能在设置里改。
  cleanDesktopOnAdd: true,
  iconSize: 'm',        // 网格图标尺寸：s=紧凑 m=标准 l=大（一屏能塞多少就靠它）
  // 桌面入口模式：
  //   single = 桌面只有一个主入口（双击打开全部分区，分区在顶部标签栏里切换）→ 默认
  //   multi  = 每个分区一个桌面图标（老行为）
  entryMode: 'single',
  mainLnk: '',          // 主入口 .lnk 的绝对路径（缓存，真身以桌面扫描为准）
  mainLnkError: '',     // 主入口出问题时的原因，界面据此提示"要不要重建"
  // 老配置升级到单入口时，把桌面那堆分区图标收进回收站这件事只做一次
  entryMigrated: false
});

function init() {
  file = path.join(app.getPath('userData'), 'config.json');
  brokenBackup = '';
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    // 读不出来（文件不存在 / 写坏了）。如果文件存在但解析失败，
    // 先把残骸留一份，别让后面的 save() 把用户的原始数据直接抹掉。
    if (file && fs.existsSync(file)) {
      brokenBackup = file + '.broken-' + Date.now();
      try { fs.copyFileSync(file, brokenBackup); } catch (e2) { brokenBackup = ''; }
      console.error('配置文件解析失败，已备份残骸：', e.message);
    }
    data = null;
  }
  if (!data || typeof data !== 'object') data = DEFAULTS();
  // 补齐缺字段，避免旧配置让新代码崩
  const d = DEFAULTS();
  data = Object.assign({}, d, data);
  data.win = Object.assign({}, d.win, data.win || {});
  if (!Array.isArray(data.groups)) data.groups = [];
  data.groups.forEach((g) => { if (!Array.isArray(g.apps)) g.apps = []; });
  // 正常启动时落盘补齐字段；读坏过就**先不写**，等用户真正操作再覆盖，
  // 免得刚备份完就把残骸原地抹掉、让人以为数据凭空消失了。
  if (!brokenBackup) save();
  return data;
}

function getBrokenBackup() { return brokenBackup; }

// 原子写入：先写临时文件再 rename。
// 直接 writeFileSync 在进程被强杀时可能只写了一半，导致下次启动读出坏 JSON 而丢数据。
function save() {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    console.error('保存配置失败', e);
  }
}

function get() { return data; }

function findGroup(id) {
  return data.groups.find((g) => g.id === id) || null;
}

function newId() {
  return 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

module.exports = { init, save, get, findGroup, newId, DEFAULTS, getBrokenBackup };
