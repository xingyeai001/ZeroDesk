# Zero Desk

**0 图标桌面。** 桌面上只留一个入口，双击打开全部分区；顶部标签栏切换「工作 / AI / 游戏」，网格里双击启动软件。

把桌面上的 exe / 快捷方式拖进网格，原件自动移走、副本存进收纳盒，桌面就干净了。

Windows 11 · Electron

---

## 它想解决什么

桌面图标越堆越多，找东西靠肉眼扫；分类文件夹又会破坏「桌面即入口」的手感。

Zero Desk 把「分区」搬到窗口里：桌面只剩一个图标，分区是顶部标签，软件是网格里的格子。收编时原件不是复制而是移走（副本存在配置目录，随时可还原），所以桌面是真的干净，不是被挡住了。

## 功能

- **单一主入口**：桌面只有一个快捷方式。设置里可切回「每分区一个图标」的老模式。
- **收编桌面图标**：拖进窗口即可，原件移走、副本留存，右键可放回桌面。
- **单击选中 / 双击启动**：跟着 Windows 的习惯走。
- **分区管理**：新建、改名、换图标；删除时可选「把本区应用放回桌面」。
- **失效检测**：软件被卸载或路径变了，启动时弹提示卡问你要不要从收纳盒移除。
- **界面材质**：亚克力 / 云母（需 Win11 22H2+），不满足条件时诚实回退纯色，不做假 CSS 模拟。
- **无网络**：零请求、零遥测。所有数据在本机 `%APPDATA%\desktop-launcher\`。

## 跑起来

需要 Node 18+。

```bash
npm install
npm start
```

首次运行会在配置目录建 `config.json` 和图标缓存，并在桌面生成 `Zero Desk.lnk`。

> 如果你在终端启动时发现「没反应、窗口不出现」，检查环境里有没有 `ELECTRON_RUN_AS_NODE=1`——它会让 electron 变成纯 Node 进程。清掉即可。

## 打包

```bash
npm run dist:dir     # 绿色版 → dist/win-unpacked/
npm run dist:setup   # 安装包 → dist/ZeroDesk-Setup-<version>.exe
```

图标取自 `build/icon.ico`（9 档 PNG-in-ICO）。

## 目录

```
main.js              主进程：窗口、托盘、IPC、入口模式、迁移与自愈
preload.js           预加载桥（contextIsolation）
renderer/
  index.html  app.js  style.css
src/
  store.js           配置读写
  shortcuts.js       .lnk 读写（Electron shell.writeShortcutLink）
  icon.js            图标提取：PE 资源 / UWP / ICO 封装 / 回收
  peicon.js          PE 资源段解析
  png.js             纯 JS PNG 编码（不依赖原生模块）
  adopt.js           收编与还原
  launch.js          启动与失效识别
assets/              应用图标、托盘图标（4 档按 DPI）
build/               打包图标与图标工具
```

## 几个不显然的实现决定

**`.lnk` 只能用 Electron 原生 API 写。** 手写 ShellLink 二进制（IDList / LinkInfo）Windows 不认，桌面上会显示成通用白纸图标。踩过。

**图标文件名带内容指纹。** `launcher-<md5前8>.ico`、`group-<id>-<时间戳>.ico`。Windows 图标缓存按路径索引，固定文件名覆盖内容的话，桌面永远显示旧图——「换了图标里外不一致」就是这么来的。

**主入口删了不自动复活。** 配置里记着 `mainLnk`，文件消失即视为用户主动删除，只在设置里给「重建桌面主入口」出口。偷偷长回来比消失更让人恼火。

**单入口模式下不写任何分区 `.lnk`。** 新建分区、改名、换图标、启动自愈全部跳过——分区只活在标签栏里。

## License

[MIT](LICENSE)
