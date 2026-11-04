// 从 PE 文件（exe / dll）里把内嵌的图标资源抽出来，拼成一个标准 .ico
//
// 为什么需要它：Electron 的 app.getFileIcon() 对一部分程序只会返回
// **系统通用图标**（那张白纸/蓝窗口），尤其是：
//   - 打包成单文件、图标放在资源段里而非 .rsrc 常见布局的 Electron 应用
//   - 同一个 exe 里有多个图标组、系统按 shell 关联挑错了
// 实测 Kimi / 千问 这类程序，getFileIcon 返回的 dataURL 长度完全一样 —— 就是同一张通用图。
//
// 所以这里自己读：MZ → PE → 资源节 → RT_GROUP_ICON(14) 拿图标组清单 →
// 逐个从 RT_ICON(3) 取数据 → 按 ICO 格式拼回去。
// 全程只读、不执行、不依赖任何原生模块。

const fs = require('fs');

const RT_ICON = 3;
const RT_GROUP_ICON = 14;

function u16(b, o) { return b.readUInt16LE(o); }
function u32(b, o) { return b.readUInt32LE(o); }

/** 读 fd 的指定区间；失败返回 null */
function readAt(fd, off, len) {
  if (off < 0 || len <= 0) return null;
  const b = Buffer.allocUnsafe(len);
  let got = 0;
  try {
    while (got < len) {
      const n = fs.readSync(fd, b, got, len - got, off + got);
      if (!n) break;
      got += n;
    }
  } catch (e) { return null; }
  return got === len ? b : b.slice(0, got);
}

/**
 * 抽取 .ico 内容，返回 Buffer（可直接写 .ico 文件）；抽不到返回 null。
 * @param {string} file exe / dll 路径
 * @param {number} maxSize 优先挑不超过它的最大尺寸（默认 256）
 */
function extractIcoBuffer(file, maxSize = 256) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size < 0x40) return null;

    const head = readAt(fd, 0, Math.min(0x2000, size));
    if (!head || head.length < 0x40) return null;
    if (head.toString('latin1', 0, 2) !== 'MZ') return null;

    const peOff = u32(head, 0x3c);
    if (peOff + 24 > head.length) return null;
    if (head.toString('latin1', peOff, peOff + 4) !== 'PE\0\0') return null;

    const coff = peOff + 4;
    const numSections = u16(head, coff + 2);
    const optSize = u16(head, coff + 16);
    const opt = coff + 20;
    if (opt + optSize > head.length) return null;

    const magic = u16(head, opt);
    // PE32: OptionalHeader 标准字段 96 字节；PE32+: 112 字节
    const ddOff = opt + (magic === 0x20b ? 112 : 96);
    if (ddOff + 16 > head.length) return null;

    // 数据目录第 3 项（下标 2）就是资源表
    const resRva = u32(head, ddOff + 16);
    const resSize = u32(head, ddOff + 20);
    if (!resRva || !resSize || resSize > 64 * 1024 * 1024) return null;

    // 节表：把 RVA 换算成文件偏移
    const secOff = opt + optSize;
    if (secOff + numSections * 40 > head.length) return null;
    const sections = [];
    for (let i = 0; i < numSections; i++) {
      const s = secOff + i * 40;
      sections.push({
        va: u32(head, s + 12),
        vsize: u32(head, s + 8),
        rawSize: u32(head, s + 16),
        rawPtr: u32(head, s + 20)
      });
    }
    const rvaToOff = (rva) => {
      for (const s of sections) {
        const span = Math.max(s.vsize, s.rawSize);
        if (rva >= s.va && rva < s.va + span) return s.rawPtr + (rva - s.va);
      }
      return -1;
    };

    const resBase = rvaToOff(resRva);
    if (resBase < 0) return null;

    // 资源节可能拉得很长，但真正有用的只有目录 + 图标数据，读到节末即可
    const resLen = Math.min(resSize, size - resBase);
    if (resLen <= 0) return null;
    const res = readAt(fd, resBase, resLen);
    if (!res || res.length < 16) return null;

    const dirOf = (rel) => {
      if (rel < 0 || rel + 16 > res.length) return null;
      const named = u16(res, rel + 12);
      const ids = u16(res, rel + 14);
      const out = [];
      for (let i = 0; i < named + ids; i++) {
        const e = rel + 16 + i * 8;
        if (e + 8 > res.length) break;
        out.push({
          name: u32(res, e),
          child: u32(res, e + 4) & 0x7fffffff   // 高位 1 表示"子目录"
        });
      }
      return out;
    };

    const root = dirOf(0);
    if (!root) return null;

    const typeEntry = (id) => root.find((t) => !(t.name & 0x80000000) && t.name === id);
    const grpType = typeEntry(RT_GROUP_ICON);
    const icoType = typeEntry(RT_ICON);
    if (!grpType || !icoType) return null;

    // RT_ICON：id -> {rel, size}
    const iconData = new Map();
    const icoDir = dirOf(grpType === icoType ? 0 : icoType.child);
    if (!icoDir) return null;
    for (const e of icoDir) {
      if (e.name & 0x80000000) continue;          // 命名资源，极少见，跳过
      const langDir = dirOf(e.child);
      if (!langDir || !langDir.length) continue;
      const dataRel = langDir[0].child;           // 再下一层就是 IMAGE_RESOURCE_DATA_ENTRY
      if (dataRel + 16 > res.length) continue;
      const rva = u32(res, dataRel);
      const len = u32(res, dataRel + 4);
      const off = rvaToOff(rva);
      if (off < 0 || !len) continue;
      iconData.set(e.name, { off, size: len });
    }
    if (!iconData.size) return null;

    // RT_GROUP_ICON：可能有多个组，挑条目最多的那个
    const grpDir = dirOf(grpType.child);
    if (!grpDir) return null;

    let best = null;
    for (const g of grpDir) {
      const langDir = dirOf(g.child);
      if (!langDir || !langDir.length) continue;
      const dataRel = langDir[0].child;
      if (dataRel + 16 > res.length) continue;
      const rva = u32(res, dataRel);
      const len = u32(res, dataRel + 4);
      const off = rvaToOff(rva);
      if (off < 0 || len < 6) continue;
      const grp = readAt(fd, off, len);
      if (!grp) continue;
      const count = u16(grp, 4);
      const entries = [];
      for (let i = 0; i < count; i++) {
        const p = 6 + i * 14;
        if (p + 14 > grp.length) break;
        entries.push({
          w: grp[p] === 0 ? 256 : grp[p],
          h: grp[p + 1] === 0 ? 256 : grp[p + 1],
          colorCount: grp[p + 2],
          planes: u16(grp, p + 4),
          bitCount: u16(grp, p + 6),
          bytes: u32(grp, p + 8),
          id: u16(grp, p + 12)
        });
      }
      const usable = entries.filter((e) => iconData.has(e.id));
      if (!usable.length) continue;
      if (!best || usable.length > best.length) best = usable;
      if (best.length >= 3) { best = usable; break; }   // 够用就不继续找了
    }
    if (!best || !best.length) return null;

    // 挑尺寸：不超过 maxSize 的最大一张
    const sorted = best.slice().sort((a, b) => {
      const sa = Math.max(a.w, a.h), sb = Math.max(b.w, b.h);
      return sa - sb;
    });
    let pick = sorted.filter((e) => Math.max(e.w, e.h) <= maxSize);
    const chosen = (pick.length ? pick : sorted);
    // 单张 ICO：只要最大那张就够（后面还要缩到 64）
    const one = chosen[chosen.length - 1];
    const d = iconData.get(one.id);

    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);        // type = icon
    header.writeUInt16LE(1, 4);        // count = 1

    const entry = Buffer.alloc(16);
    entry[0] = one.w >= 256 ? 0 : one.w;
    entry[1] = one.h >= 256 ? 0 : one.h;
    entry[2] = one.colorCount || 0;
    entry[3] = 0;
    entry.writeUInt16LE(one.planes || 1, 4);
    entry.writeUInt16LE(one.bitCount || 32, 6);
    entry.writeUInt32LE(d.size, 8);
    entry.writeUInt32LE(22, 12);

    const data = readAt(fd, d.off, d.size);
    if (!data || !data.length) return null;
    entry.writeUInt32LE(data.length, 8);
    return Buffer.concat([header, entry, data]);
  } catch (e) {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) { /* ignore */ } }
  }
}

/** exe 里到底有没有图标资源（诊断用） */
function hasIconResource(file) {
  return !!extractIcoBuffer(file);
}

module.exports = { extractIcoBuffer, hasIconResource };
