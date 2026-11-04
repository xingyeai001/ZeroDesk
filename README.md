# Zero Desk 源码（v0.2.0）

Windows 桌面收纳工具。桌面上只有一个主入口，双击打开，顶部标签栏切换分区，网格里双击启动软件。

## 目录结构

```
main.js              主进程：窗口、托盘、IPC、入口模式、迁移与自愈
preload.js           预加载桥（contextIsolation 下的安全 API）
renderer/
  index.html         界面骨架
  app.js             渲染逻辑：渲染分区/网格/弹窗/提示卡
  style.css          样式（含 acrylic/mica 材质适配、文字描边）
src/
  store.js           配置读写（%APPDATA%\desktop-launcher\config.json）
  shortcuts.js       .lnk 读写（Electron shell.writeShortcutLink）
  icon.js            图标提取：PE 资源、UWP AppxManifest、ICO 封装、GC
  peicon.js          PE 资源段解析
  png.js             纯 JS PNG 编码
  adopt.js           收编桌面图标（移动原件、复制副本、可还原）
  launch.js          启动软件（含"找不到"识别）
assets/
  icon.ico           应用图标 9 档 PNG-in-ICO
  icon.png           512×512
  tray-16/20/24/32.png  托盘四档（按 DPI 挂多 representation）
build/
  extract-tray.js    从 icon.ico 抽托盘 PNG（换图标时用）
  mkicon.js          ICO 生成/校验工具
  rename.js          批量文案替换（历史工具）
start.cmd / start.vbs 开发态启动脚本
```

## 本地跑起来

需要 Node 18+ 与 Electron（`package.json` 里已声明 devDependency）。

```bash
npm install
npx electron .
```

首次运行会在 `%APPDATA%\desktop-launcher\` 建配置和图标缓存，并在桌面生成 `Zero Desk.lnk`。

## 打包

```bash
npx electron-builder --win dir --x64    # 绿色版 → dist/win-unpacked/
npx electron-builder --win nsis --x64   # 安装包 → dist/*.exe
```

图标来自 `build/icon.ico`（由 `electron-builder` 的 `build.icon` 指定）。

## 几个不显然的设计

- **入口模式**：`config.json` 里的 `entryMode` 为 `single`（单一主入口）或 `multi`（每分区一个图标）。单入口下，新建/改名/换图标/启动自愈都不会往桌面写分区 `.lnk`。
- **图标文件名带内容指纹**：`launcher-<md5前8位>.ico`、`group-<id>-<时间戳>.ico`、`app-<md5>-<时间戳>.ico`。Windows 图标缓存按路径索引，固定文件名会让"换了图标但桌面还是旧的"。
- **主入口被删不复活**：记录在 `mainLnk` 里，文件消失即视为用户主动删除，只在设置里提供「重建桌面主入口」出口。
- **材质**：`win.setBackgroundMaterial('acrylic'|'mica')` 需要 Win11 22H2+；不满足时诚实回退 `solid` 并把原因返回渲染层，不做假 CSS 模拟。
- **`.lnk` 只能用 Electron 原生 API 写**：手写 ShellLink 二进制 Windows 不认（IDList/LinkInfo 校验不过），会显示成通用白纸图标。

## 隐私

零网络请求、零遥测、无剪贴板/注册表/浏览器数据访问。所有数据都在本机 `%APPDATA%\desktop-launcher\` 下。
