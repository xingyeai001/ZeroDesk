const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),

  // 分区
  createGroup: (name, iconSrc) => ipcRenderer.invoke('group:create', { name, iconSrc }),
  renameGroup: (id, name) => ipcRenderer.invoke('group:rename', { id, name }),
  setGroupIcon: (id) => ipcRenderer.invoke('group:icon', id),
  deleteGroup: (id, removeLnk, appsBack) => ipcRenderer.invoke('group:delete', { id, removeLnk, appsBack }),
  pickImage: () => ipcRenderer.invoke('dialog:pickImage'),
  revealLnk: (lnk) => ipcRenderer.invoke('group:revealLnk', lnk),
  restoreLnk: (id) => ipcRenderer.invoke('group:restoreLnk', id),
  // 主入口（桌面唯一图标）
  restoreMainLnk: () => ipcRenderer.invoke('main:restoreLnk'),
  onEntryMigrated: (cb) => ipcRenderer.on('entry:migrated', (e, r) => cb(r)),

  // 软件
  addApps: (groupId) => ipcRenderer.invoke('apps:add', groupId),
  addPaths: (groupId, paths, at) => ipcRenderer.invoke('apps:addPaths', { groupId, paths, at }),
  removeApp: (groupId, p, silent) => ipcRenderer.invoke('apps:remove', { groupId, path: p, silent }),
  appToDesktop: (groupId, p) => ipcRenderer.invoke('apps:toDesktop', { groupId, path: p }),
  groupToDesktop: (groupId) => ipcRenderer.invoke('group:toDesktop', groupId),
  reorder: (groupId, from, to) => ipcRenderer.invoke('apps:reorder', { groupId, from, to }),
  // 拖出窗口：走系统原生文件拖拽，文件跟着鼠标、松手落在哪就在哪
  nativeDrag: (groupId, p) => ipcRenderer.send('apps:nativeDrag', { groupId, path: p }),
  onDragEnd: (cb) => ipcRenderer.on('apps:dragEnd', (e, r) => cb(r)),
  setAppIcon: (groupId, p) => ipcRenderer.invoke('apps:icon', { groupId, path: p }),
  refreshIcons: () => ipcRenderer.invoke('icons:refresh'),
  cleanDesktopDupes: () => ipcRenderer.invoke('apps:cleanDesktopDupes'),
  launch: (p) => ipcRenderer.invoke('apps:launch', p),
  reveal: (p) => ipcRenderer.invoke('apps:reveal', p),

  // 设置 / 窗口
  saveSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  switchGroup: (id) => ipcRenderer.invoke('group:switch', id),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
  close: () => ipcRenderer.invoke('window:close'),

  // 窗口最大化状态变化（双击标题栏 / 系统贴靠也会触发），用于切按钮图标
  onMaximizeChange: (cb) => ipcRenderer.on('window:maximized', (e, v) => cb(v)),

  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch (e) { return ''; }
  },
  // 沙箱模式下 webUtils 是否可用（拖入功能依赖它；不可用时要让界面知道）
  canGetDroppedPath: !!webUtils,

  onSwitchGroup: (cb) => ipcRenderer.on('group:switch', (e, id) => cb(id)),
  onIconsUpdated: (cb) => ipcRenderer.on('icons:updated', () => cb())
});
