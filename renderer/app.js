/* Zero Desk —— 渲染进程 v2 */
const $ = (s) => document.querySelector(s);

let S = { groups: [], currentGroupId: null, settings: { theme: 'system', material: 'solid', closeToTray: false, entryMode: 'single' } };
let dragFrom = -1;        // 正在拖的软件序号（松手后用来排序）
let nativeDragActive = false;  // 原生拖拽进行中：期间要把"拖入文件"的逻辑全部让开
let modalOpen = false;

/* ---------------- 启动 ---------------- */
(async function init() {
  // 监听要先挂上：首次 state:get 往返的这段时间里，主进程完全可能因为用户又点了一个
  // 桌面 .lnk 而发出 group:switch —— 那时还没挂监听，消息会被 Electron 直接丢掉。
  window.api.onSwitchGroup((id) => {
    if (S.groups.some((g) => g.id === id)) {
      S.currentGroupId = id;
      render();
    } else {
      // 分区列表还没加载完，等下一次 refresh 按 pendingGroupId 对齐
      refresh().catch(() => {});
    }
  });

  window.api.onIconsUpdated(async () => { await refresh(); });

  // 升级到单主入口时主进程把桌面那堆分区图标收进回收站了 —— 图标突然消失必须当面说明，
  // 否则用户只会觉得"我的图标被这软件搞没了"。
  if (window.api.onEntryMigrated) {
    window.api.onEntryMigrated((r) => {
      if (!r || !r.moved) return;
      notice({
        title: '桌面已变成「0 图标」',
        desc: `已把 ${r.moved} 个分区快捷方式移进回收站（可随时还原），桌面上只保留一个主入口。`,
        timeout: 12000,
        actions: [{ label: '知道了', kind: 'primary', act: () => {} }]
      });
    });
  }

  // 原生拖拽结束：落在窗口内 = 排序；落在桌面 = 移出分区；落在别的程序 = 只复制，条目保留
  window.api.onDragEnd((r) => {
    const from = dragFrom;
    nativeDragActive = false;
    dragFrom = -1;
    document.body.classList.remove('dragging');
    if (!r) return;
    if (!r.ok) { toast(r.msg || '拖拽失败'); return; }

    if (r.inside) {
      const g = group();
      const hit = document.elementFromPoint(r.x, r.y);
      const item = hit && hit.closest ? hit.closest('.app-item') : null;
      const to = item ? Number(item.dataset.idx) : -1;
      if (!g || from < 0 || !Number.isFinite(to) || to < 0 || to === from) return;
      window.api.reorder(g.id, from, to).then((res) => {
        if (res && res.ok) applyState(res.state);
      });
      return;
    }

    if (r.state) applyState(r.state);
    if (r.canceled) return;
    // 落在别的程序/文件夹里：文件被复制出去了，但条目留在分区（右键「从分区移除」才真移出）
    if (r.kept) { toast(`已复制出去，分区里仍保留：${r.name}`); return; }
    toast(`已移出：${r.name}`);
  });

  await refresh();

  $('#btnMin').onclick = () => window.api.minimize();
  $('#btnMax').onclick = () => window.api.toggleMaximize();
  $('#btnClose').onclick = () => window.api.close();
  window.api.onMaximizeChange((v) => {
    const b = $('#btnMax');
    b.textContent = v ? '❐' : '▢';
    b.title = v ? '还原' : '最大化';
  });
  $('#btnAdd').onclick = addViaDialog;
  $('#btnNewGroup').onclick = newGroup;
  $('#btnNewGroup2').onclick = newGroup;
  $('#btnGroupIcon').onclick = () => withGroup(changeGroupIcon);
  $('#gName').ondblclick = () => withGroup(renameGroup);
  $('#btnSettings').onclick = (e) => { e.stopPropagation(); toggleSettings(); };
  $('#settings').onclick = (e) => e.stopPropagation();
  document.addEventListener('click', () => { $('#settings').classList.add('hidden'); });

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (S.settings.theme === 'system') applyTheme();
  });

  wireSettings();
})();

async function refresh() {
  try {
    const st = await window.api.getState();
    S.groups = st.groups;
    S.settings = st.settings;
    if (!S.groups.some((g) => g.id === S.currentGroupId)) {
      S.currentGroupId = st.currentGroupId || (S.groups[0] ? S.groups[0].id : null);
    }
    applyTheme();
    render();
  } catch (e) {
    // 主进程 handler 抛错时 refresh 会 reject。不接住的话整个初始化 IIFE 挂掉，
    // 之后界面再也不响应任何状态变化 —— 用户看到的就是一个空窗口。
    console.error('[refresh]', e);
    const s = $('#statusText');
    if (s) {
      s.textContent = '状态加载失败：' + (e && e.message ? e.message : e) + '（点这里重试）';
      s.onclick = () => { s.onclick = null; refresh(); };
    }
  }
}

function applyState(st) {
  if (!st) return;
  S.groups = st.groups;
  S.settings = st.settings;
  S.currentGroupId = st.currentGroupId;
  applyTheme();
  render();
}

function group() {
  return S.groups.find((g) => g.id === S.currentGroupId) || S.groups[0] || null;
}

/** 单主入口模式：桌面只有一个图标，分区不单独占桌面 */
function isSingle() {
  return (S.settings.entryMode || 'single') === 'single';
}

function withGroup(fn) {
  const g = group();
  if (g) fn(g);
}

function letterHue(name) {
  // 老版本这里自己算了一遍色相（种子还和主进程差一个数），结果分区图标是紫的、
  // 字母占位是青的。现在色相统一由主进程算好随数据下发，这里只做兜底。
  let h = 0;
  for (const ch of String(name || '?')) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

/* ---------------- 主题 ---------------- */
function applyTheme() {
  const t = S.settings.theme || 'system';
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.body.classList.toggle('mat', (S.settings.material || 'solid') !== 'solid');
  document.body.dataset.iconsize = S.settings.iconSize || 'm';
}

/* ---------------- 渲染 ---------------- */
function render() {
  renderTabs();
  renderGroup();
}

function renderTabs() {
  const box = $('#tabs');
  box.innerHTML = '';
  S.groups.forEach((g) => {
    const b = document.createElement('button');
    b.className = 'tab' + (g.id === S.currentGroupId ? ' on' : '');
    b.title = g.name;
    if (g.iconData) {
      const im = new Image();
      im.src = g.iconData;
      b.appendChild(im);
    }
    const t = document.createElement('span');
    t.textContent = g.name;
    b.appendChild(t);
    b.onclick = () => { S.currentGroupId = g.id; window.api.switchGroup(g.id); render(); };
    b.oncontextmenu = (e) => {
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [
        { label: '重命名分区', act: () => renameGroup(g) },
        { label: '更换分区图标', act: () => changeGroupIcon(g) },
        // 入口没了就给"重建"，还在就给"在桌面显示"。
        // 删掉之后不会自动长回来（自愈只在从未建成时补建），所以这里必须有一个恢复出口。
        // 单主入口模式下桌面本来就没有分区图标，这两项整个不适用。
        {
          label: g.lnkExists ? '在桌面显示快捷方式' : '重新创建桌面快捷方式',
          hidden: isSingle(),
          act: async () => {
            if (g.lnkExists) { window.api.revealLnk(g.lnkPath); return; }
            const r = await window.api.restoreLnk(g.id);
            if (!r.ok) return toast(r.msg || '创建失败');
            applyState(r.state);
            toast('桌面快捷方式已重建');
          }
        },
        {
          label: '把本区快捷方式放回桌面',
          act: async () => {
            const r = await window.api.groupToDesktop(g.id);
            if (!r.ok) return toast(r.msg || '操作失败');
            if (!r.added && !r.existed) {
              return toast(r.skipped ? '本区的快捷方式不是从桌面收来的，不用放回' : '本区没有可放回的快捷方式');
            }
            toast(`已放回 ${r.added} 个${r.existed ? `，${r.existed} 个原本就在桌面` : ''}`);
          }
        },
        { label: '删除分区', danger: true, act: () => removeGroup(g) }
      ]);
    };
    box.appendChild(b);
  });
}

function renderGroup() {
  const g = group();
  const hasGroup = !!g;

  $('#groupHead').classList.toggle('hidden', !hasGroup);
  $('#empty').classList.toggle('hidden', !hasGroup || g.apps.length > 0);
  $('#noGroup').classList.toggle('hidden', hasGroup);

  const grid = $('#grid');
  grid.innerHTML = '';
  // 点空白处取消选中（点到软件项时会被 item 自己的 onclick 先处理，这里只兜底清掉）
  grid.onclick = (e) => {
    if (e.target === grid) document.querySelectorAll('.app-item.selected').forEach((x) => x.classList.remove('selected'));
  };
  if (!hasGroup) {
    $('#statusText').textContent = '还没有分区，点左上角 ＋ 新建一个';
    return;
  }

  $('#gName').textContent = g.name;

  const iconEl = $('#gIcon');
  if (g.iconData) iconEl.src = g.iconData; else iconEl.removeAttribute('src');

  let meta = `${g.apps.length} 个程序`;
  if (isSingle()) {
    // 单主入口下没有"分区自己的桌面图标"，这行不该再提它
    meta += ' · 桌面只保留主入口';
  } else if (g.lnkExists) meta += ` · 桌面快捷方式「${g.name}.lnk」`;
  else if (g.lnkError === '桌面快捷方式已被删除') meta += ' · 桌面快捷方式已被删除（右键分区标签可重建）';
  else if (g.lnkError) meta += ` · 快捷方式异常：${g.lnkError}`;
  else meta += ' · 桌面快捷方式已被删除（右键分区标签可重建）';
  $('#gMeta').textContent = meta;

  g.apps.forEach((a, i) => grid.appendChild(appItem(g, a, i)));

  $('#statusText').textContent = g.apps.length
    ? '左键启动 · 右键更多 · 拖动排序，拖出窗口就放到你松手的位置'
    : '把桌面上的 exe / 快捷方式拖进来，或点右上角「添加软件」';
}

function appItem(g, a, idx) {
  const el = document.createElement('div');
  el.className = 'app-item' + (a.exists ? '' : ' missing');
  el.title = a.exists ? `${a.name}\n${a.path}` : `${a.path}\n（文件已不存在）`;
  el.draggable = true;

  const box = document.createElement('div');
  box.className = 'app-ico';
  if (a.icon) {
    const im = new Image();
    im.src = a.icon;
    box.appendChild(im);
  } else {
    const l = document.createElement('div');
    l.className = 'letter';
    l.style.setProperty('--h', Number.isFinite(a.hue) ? a.hue : letterHue(a.name));
    l.textContent = (a.name || '?').trim().charAt(0).toUpperCase();
    box.appendChild(l);
  }

  const nm = document.createElement('div');
  nm.className = 'app-name';
  nm.textContent = a.exists ? a.name : a.name + '（找不到）';

  el.appendChild(box);
  el.appendChild(nm);

  const openApp = async () => {
    // a.exists 只是打开窗口那一刻的快照，软件可能刚刚被卸载。
    // 所以启动失败之后还要按主进程回的 missing 再判一次，不能只信这个字段。
    if (!a.exists) { missingNotice(g, a); return; }
    const r = await window.api.launch(a.path);
    if (r.ok) return;
    if (r.missing) { missingNotice(g, a); return; }
    toast(r.msg || '启动失败');
  };

  // 单击 = 选中（高亮确认）；双击 = 启动
  el.onclick = () => {
    if (dragFrom >= 0) return;
    const was = el.classList.contains('selected');
    document.querySelectorAll('.app-item.selected').forEach((x) => x.classList.remove('selected'));
    if (!was) el.classList.add('selected');
  };
  el.ondblclick = openApp;

  el.oncontextmenu = (e) => {
    e.preventDefault();
    showMenu(e.clientX, e.clientY, [
      { label: '打开', act: openApp },
      { label: '打开所在文件夹', act: () => window.api.reveal(a.path) },
      {
        label: '更换图标',
        act: async () => {
          const r = await window.api.setAppIcon(g.id, a.path);
          if (r.ok) { applyState(r.state); toast(r.warn ? '图标已更换（' + r.warn + '）' : '图标已更换'); }
          else if (!r.canceled) toast(r.msg || '更换失败');
        }
      },
      {
        label: '放回桌面',
        hidden: !a.canRestore,
        act: async () => {
          const r = await window.api.appToDesktop(g.id, a.path);
          if (r.ok) toast(r.existed ? '桌面上已经有了' : `已放回桌面：${r.name}`);
          else toast(r.msg || '放回失败');
        }
      },
      {
        label: '从分区移除',
        danger: true,
        act: async () => {
          const r = await window.api.removeApp(g.id, a.path);
          if (r.ok) {
            applyState(r.state);
            toast(r.restored ? `已移除，快捷方式已还回桌面` : '已移除');
          } else if (!r.canceled) {
            toast(r.msg || '移除失败');
          }
        }
      }
    ]);
  };

  // 拖拽统一交给系统原生拖拽：文件跟着鼠标走，松手落在哪就在哪。
  // 代价是拖拽期间窗口收不到 mousemove（鼠标被系统接管），所以排序不能实时预览，
  // 改成"松手后按落点算目标位置"。
  el.dataset.idx = String(idx);
  el.ondragstart = (e) => {
    e.preventDefault();          // 掐掉 HTML5 拖拽，否则原生拖拽起不来
    dragFrom = idx;
    nativeDragActive = true;
    window.api.nativeDrag(g.id, a.path);
  };

  return el;
}

/* ---------------- 分区管理 ---------------- */
async function newGroup() {
  const r = await dialog({
    title: '新建分区',
    desc: isSingle()
      ? '建好后会出现在顶部标签栏，桌面不会多出图标。'
      : '建好后会在桌面生成同名快捷方式，双击它就能直接打开这个分区。',
    input: true,
    placeholder: '分区名，比如：工作',
    iconPicker: true,
    okText: '创建'
  });
  if (!r) return;

  const name = (r.value || '').trim();
  if (!name) { toast('分区名不能为空'); return; }

  const res = await window.api.createGroup(name, r.iconSrc || '');
  if (!res.ok) { toast(res.msg || '创建失败'); return; }
  applyState(res.state);
  toast(`已创建「${name}」${isSingle() ? '' : '，桌面多了个快捷方式'}`);
}

async function renameGroup(g) {
  const r = await dialog({
    title: '重命名分区',
    desc: isSingle()
      ? '只改标签栏上的名字，图标和里面的软件不受影响。'
      : '桌面上的快捷方式文件会跟着改名，图标和里面的软件不受影响。',
    input: true,
    value: g.name,
    okText: '保存'
  });
  if (!r) return;

  const name = (r.value || '').trim();
  if (!name || name === g.name) return;

  const res = await window.api.renameGroup(g.id, name);
  if (!res.ok) { toast(res.msg || '重命名失败'); return; }
  applyState(res.state);
  toast('已重命名为「' + name + '」');
}

async function changeGroupIcon(g) {
  const res = await window.api.setGroupIcon(g.id);
  if (res.ok) {
    applyState(res.state);
    toast(isSingle() ? '分区图标已更新' : '分区图标已更新，桌面快捷方式同步变化');
  } else if (!res.canceled) toast(res.msg || '更换失败');
}

async function removeGroup(g) {
  const n = g.apps.length;

  // 这个确认框必须把「应用去哪了」问清楚：删分区有两种完全不同的后果，
  // 一个复选框表达不了，所以给两个并列按钮，用户必须挑一个。
  const r = await dialog({
    title: `删除分区「${g.name}」`,
    desc: n
      ? `本区有 ${n} 个软件。删除分区不会卸载这些软件，但会把它们从这个区里清空。`
      : '这个区里还没有软件，删除后不可恢复。',
    question: n ? '是否将本区内的应用放回桌面？' : '',
    actions: n
      ? [
        {
          label: '直接删除分区',
          value: 'purge',
          kind: 'danger',
          hint: '只从收纳盒移除，不往桌面放任何图标'
        },
        {
          label: '放回桌面并删除分区',
          value: 'restore',
          kind: 'primary',
          hint: '先把应用快捷方式还原到桌面，再删除分区'
        }
      ]
      : [{ label: '删除分区', value: 'purge', kind: 'danger' }],
    // 单主入口模式下分区本来就没有桌面图标，这个复选框无从谈起
    checkbox: isSingle() ? '' : '同时移除桌面上的分区快捷方式（进回收站，可撤销）',
    checked: !isSingle(),
    danger: true
  });
  if (!r) return;

  const res = await window.api.deleteGroup(g.id, r.checked, r.action === 'restore');
  if (!res.ok) { toast(res.msg || '删除失败'); return; }
  applyState(res.state);

  if (r.action === 'restore') {
    toast(res.restored
      ? `分区已删除，${res.restored} 个应用已放回桌面`
      : '分区已删除（没有可放回桌面的快捷方式）');
  } else {
    toast('分区已删除');
  }
}

/* ---------------- 添加软件 ---------------- */
async function addViaDialog() {
  const g = group();
  if (!g) return;
  const r = await window.api.addApps(g.id);
  if (!r.ok) {
    if (!r.canceled) toast(r.msg || '没有添加成功');
    return;
  }
  applyState(r.state);
  toast(r.added ? `已添加 ${r.added} 个` : '这些都已经在分区里了');
}

/* ---------------- 拖入文件 ---------------- */
let dragDepth = 0;

// 原生拖拽期间（拖的是分区里自己的软件），整套"拖入"逻辑必须让开：
// 否则在窗口内松手会把中转文件又收养一遍。drop 一律 preventDefault，
// 不然 Chromium 会顺手去打开那个文件。
const inNativeDrag = () => nativeDragActive || dragFrom >= 0;

window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (inNativeDrag()) return;
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (inNativeDrag()) return;
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  if (inNativeDrag()) return;
  if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); }
});
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  if (inNativeDrag()) return;
  dragDepth = 0;
  document.body.classList.remove('dragging');

  const g = group();
  if (!g) return;

  const paths = [...(e.dataTransfer?.files || [])]
    .map((f) => window.api.pathForFile(f))
    .filter((p) => p && /\.(exe|lnk|url)$/i.test(p));

  if (!paths.length) { toast('只支持 exe / lnk / url'); return; }

  // 落在哪个格子上，就插到那个位置（跟拖动排序一个手感）；落空白处则排到最后
  const hit = document.elementFromPoint(e.clientX, e.clientY);
  const cell = hit && hit.closest ? hit.closest('.app-item') : null;
  const at = cell ? Number(cell.dataset.idx) : -1;

  const r = await window.api.addPaths(g.id, paths, Number.isFinite(at) ? at : -1);
  if (!r.ok) { toast(r.msg || '添加失败'); return; }
  applyState(r.state);
  toast(r.added ? `已添加 ${r.added} 个` : '这些都已经在分区里了');
});

/* ---------------- 弹窗 ---------------- */
function dialog(opts) {
  return new Promise((resolve) => {
    const root = $('#modalRoot');
    const mask = document.createElement('div');
    mask.className = 'modal';

    const box = document.createElement('div');
    box.className = 'mbox';

    const h = document.createElement('div');
    h.className = 'mtitle';
    h.textContent = opts.title || '';
    box.appendChild(h);

    if (opts.desc) {
      const d = document.createElement('div');
      d.className = 'mdesc';
      d.textContent = opts.desc;
      box.appendChild(d);
    }

    // 需要用户明确回答的问题（比 desc 更醒目，单独一行加粗）
    if (opts.question) {
      const q = document.createElement('div');
      q.className = 'mques';
      q.textContent = opts.question;
      box.appendChild(q);
    }

    let inputEl = null;
    let iconSrc = '';
    let chkEl = null;

    if (opts.input) {
      inputEl = document.createElement('input');
      inputEl.className = 'minput';
      inputEl.value = opts.value || '';
      inputEl.placeholder = opts.placeholder || '';
      box.appendChild(inputEl);
    }

    if (opts.iconPicker) {
      const row = document.createElement('div');
      row.className = 'miconrow';

      const thumb = document.createElement('div');
      thumb.className = 'mthumb';
      thumb.textContent = '默认';

      const pick = document.createElement('button');
      pick.className = 'mbtn';
      pick.textContent = '选择图标图片…';
      pick.onclick = async () => {
        const r = await window.api.pickImage();
        if (!r.ok) {
          if (!r.canceled) toast(r.msg || '这张图片读不出来');
          return;
        }
        iconSrc = r.path;
        thumb.innerHTML = '';
        if (r.preview) {
          const im = new Image();
          im.src = r.preview;
          thumb.appendChild(im);
        }
      };

      row.appendChild(thumb);
      row.appendChild(pick);
      box.appendChild(row);
    }

    if (opts.checkbox) {
      const cw = document.createElement('label');
      cw.className = 'mcheck';
      chkEl = document.createElement('input');
      chkEl.type = 'checkbox';
      chkEl.checked = opts.checked !== false;
      const cs = document.createElement('span');
      cs.textContent = opts.checkbox;
      cw.appendChild(chkEl);
      cw.appendChild(cs);
      box.appendChild(cw);
    }

    const btns = document.createElement('div');
    btns.className = 'mbtns';

    const cancel = document.createElement('button');
    cancel.className = 'mbtn';
    cancel.textContent = '取消';
    cancel.onclick = () => close(null);
    btns.appendChild(cancel);

    const payload = (action) => ({
      value: inputEl ? inputEl.value : '',
      iconSrc,
      checked: chkEl ? chkEl.checked : false,
      action: action || ''
    });

    let ok = null;

    // 调用方给了 actions，就把单个「确定」换成一组并列动作。
    // 用在"删分区时应用要不要放回桌面"这种**必须让用户明确选后果**的场景，
    // 一个复选框表达不了两个完全不同的结果。
    if (Array.isArray(opts.actions) && opts.actions.length) {
      for (const act of opts.actions) {
        const b = document.createElement('button');
        const kind = act.kind === 'primary' ? ' primary'
          : act.kind === 'danger' ? ' primary danger' : '';
        b.className = 'mbtn' + kind;
        b.textContent = act.label;
        b.title = act.hint || act.label;
        b.onclick = () => close(payload(act.value));
        btns.appendChild(b);
      }
    } else {
      ok = document.createElement('button');
      ok.className = 'mbtn primary' + (opts.danger ? ' danger' : '');
      ok.textContent = opts.okText || '确定';
      ok.onclick = () => {
        if (opts.input && !(inputEl.value || '').trim()) {
          inputEl.classList.add('err');
          inputEl.focus();
          return;
        }
        close(payload());
      };
      btns.appendChild(ok);
    }

    box.appendChild(btns);

    mask.appendChild(box);
    root.appendChild(mask);
    modalOpen = true;

    function close(v) {
      modalOpen = false;
      mask.remove();
      resolve(v);
    }

    mask.onclick = (e) => { if (e.target === mask) close(null); };
    box.onkeydown = (e) => {
      if (e.key === 'Enter' && inputEl && ok) ok.click();
      if (e.key === 'Escape') close(null);
    };

    if (inputEl) {
      setTimeout(() => { inputEl.focus(); inputEl.select(); }, 30);
    } else {
      setTimeout(() => (ok || btns.lastChild).focus(), 30);
    }
  });
}

/* ---------------- 右键菜单 ---------------- */
function showMenu(x, y, items) {
  const m = $('#menu');
  m.innerHTML = '';
  items.forEach((it) => {
    if (it.hidden) return;      // 不适用的项直接不画（比如 exe 没有"放回桌面"）
    const b = document.createElement('button');
    b.textContent = it.label;
    if (it.danger) b.className = 'danger';
    b.onclick = (ev) => { ev.stopPropagation(); hideMenu(); it.act(); };
    m.appendChild(b);
  });
  m.classList.remove('hidden');
  m.style.left = '-9999px';
  m.style.top = '0px';
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
}
function hideMenu() { $('#menu').classList.add('hidden'); }
window.addEventListener('click', hideMenu);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modalOpen) hideMenu();
});

/* ---------------- 设置面板 ---------------- */
function toggleSettings() {
  const p = $('#settings');
  p.classList.toggle('hidden');
  syncSettingsUI();
}

function syncSettingsUI() {
  $('#segTheme').querySelectorAll('button').forEach((b) => {
    b.classList.toggle('on', b.dataset.v === S.settings.theme);
  });
  $('#segMat').querySelectorAll('button').forEach((b) => {
    b.classList.toggle('on', b.dataset.v === S.settings.material);
  });
  $('#chkTray').checked = !!S.settings.closeToTray;
  $('#segEntry').querySelectorAll('button').forEach((b) => {
    b.classList.toggle('on', b.dataset.v === (S.settings.entryMode || 'single'));
  });
  // 主入口被用户删掉了：给一个明确的"重建"提示，别让桌面真的变空还没人知道
  const ml = $('#btnMainLnk');
  if (ml) {
    ml.textContent = S.settings.mainLnkExists ? '重建桌面主入口' : '桌面主入口不见了 · 点此重建';
    ml.title = S.settings.mainLnkError || '在桌面放回唯一的那个入口图标';
  }
  $('#segIcon').querySelectorAll('button').forEach((b) => {
    b.classList.toggle('on', b.dataset.v === (S.settings.iconSize || 'm'));
  });
  // 三态：null=每次问 true=收走 false=保留
  const clean = S.settings.cleanDesktopOnAdd;
  const cleanV = clean === true ? 'trash' : (clean === false ? 'keep' : 'ask');
  $('#segClean').querySelectorAll('button').forEach((b) => {
    b.classList.toggle('on', b.dataset.v === cleanV);
  });
}

function wireSettings() {
  $('#segTheme').querySelectorAll('button').forEach((b) => {
    b.onclick = async () => {
      S.settings.theme = b.dataset.v;
      applyTheme();
      syncSettingsUI();
      await window.api.saveSettings({ theme: b.dataset.v });
    };
  });

  $('#segMat').querySelectorAll('button').forEach((b) => {
    b.onclick = async () => {
      const r = await window.api.saveSettings({ material: b.dataset.v });
      // 以主进程裁决为准：系统不支持时它会把设置改回 solid 并带 msg 回来
      if (r && r.state) { S.settings = r.state.settings; applyTheme(); syncSettingsUI(); }
      if (r && r.ok) toast(r.msg || (b.dataset.v === 'solid' ? '已切换为纯色' : '已切换材质'));
    };
  });

  $('#chkTray').onchange = async (e) => {
    S.settings.closeToTray = e.target.checked;
    const r = await window.api.saveSettings({ closeToTray: e.target.checked });
    // 托盘建不出来时主进程会把开关退回 false，界面必须跟着回弹，别让用户以为已经开了
    if (r && r.state) S.settings = r.state.settings;
    syncSettingsUI();
    if (e.target.checked && !S.settings.closeToTray) {
      toast('托盘图标创建失败，已保持「关闭即退出」');
      return;
    }
    toast(e.target.checked ? '关闭窗口后仍在托盘运行' : '关闭窗口将退出程序');
  };

  // 桌面入口模式：切换会真的增删桌面图标，所以先问一句再动手
  $('#segEntry').querySelectorAll('button').forEach((b) => {
    b.onclick = async () => {
      const v = b.dataset.v;
      if (v === (S.settings.entryMode || 'single')) return;

      const toSingle = v === 'single';
      const n = S.groups.length;
      const ask = await dialog({
        title: toSingle ? '切换到单一主入口' : '切换回每区一个图标',
        desc: toSingle
          ? `桌面上的 ${n} 个分区图标会被移进回收站（可撤销），之后桌面只剩一个主入口，双击它就能看到全部分区。`
          : '会为每个分区在桌面重新生成一个图标；主入口快捷方式会保留。',
        question: toSingle ? '把桌面上的分区图标都收走？' : '',
        okText: '切换',
        danger: toSingle
      });
      if (!ask) return;

      const r = await window.api.saveSettings({ entryMode: v });
      if (r && r.state) { S.settings = r.state.settings; applyTheme(); syncSettingsUI(); render(); }
      toast(r && r.entryMsg ? r.entryMsg : (toSingle ? '已切换为单一主入口' : '已切换为每区一个图标'));
    };
  });

  $('#btnMainLnk').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const r = await window.api.restoreMainLnk();
      if (r.state) { S.settings = r.state.settings; applyTheme(); syncSettingsUI(); }
      toast(r.ok ? '桌面主入口已重建' : (r.msg || '重建失败'));
    } catch (err) {
      toast('重建失败：' + err.message);
    } finally {
      btn.disabled = false;
    }
  };

  $('#segIcon').querySelectorAll('button').forEach((b) => {
    b.onclick = async () => {
      S.settings.iconSize = b.dataset.v;
      applyTheme();
      syncSettingsUI();
      await window.api.saveSettings({ iconSize: b.dataset.v });
    };
  });

  $('#segClean').querySelectorAll('button').forEach((b) => {
    b.onclick = async () => {
      const v = b.dataset.v === 'trash' ? true : (b.dataset.v === 'keep' ? false : null);
      S.settings.cleanDesktopOnAdd = v;
      syncSettingsUI();
      await window.api.saveSettings({ cleanDesktopOnAdd: v });
      toast(v === true ? '加入软件后，桌面上的快捷方式会进回收站'
        : v === false ? '加入软件后，桌面图标保持不动'
        : '每次加入软件都会问你怎么处理桌面图标');
    };
  });

  $('#btnRefreshIcons').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '抓取中…';
    try {
      const r = await window.api.refreshIcons();
      await refresh();     // 重新拉一次状态，图标 dataURL 随之更新
      toast(`已重新抓取 ${r ? r.got : 0}/${r ? r.total : 0} 个图标`);
    } catch (err) {
      toast('抓取失败：' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  };

  $('#btnCleanDupes').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '处理中…';
    try {
      const r = await window.api.cleanDesktopDupes();
      if (!r.ok) toast(r.msg || '操作失败');
      else if (!r.moved) toast('桌面上没有重复的快捷方式');
      else if (r.publicMoved) toast(`已移走 ${r.moved} 个重复图标（其中 ${r.publicMoved} 个在公共桌面，其他账户也看不到了）`);
      else toast(`已把 ${r.moved} 个已在分区里的桌面图标移进回收站`);
    } catch (err) {
      toast('操作失败：' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  };
}

/* ---------------- 提示 ---------------- */
let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2000);
}

/* ---------------- 操作型提示卡 ----------------
 * toast 只能"告诉你发生了什么"；有些场景还得问一句"要不要顺手处理"，
 * 这时候用这张卡片：带图标、带说明、带按钮，从底部滑上来。
 * 同一时刻只留一张，新的顶掉旧的（叠罗汉会挡住桌面图标）。
 */
let noticeTimer = 0;

function closeNotice() {
  clearTimeout(noticeTimer);
  const root = $('#noticeRoot');
  if (!root) return;
  const old = root.querySelector('.tcard');
  if (!old) return;
  old.classList.add('out');
  setTimeout(() => old.remove(), 220);
}

function notice(opts) {
  const root = $('#noticeRoot');
  if (!root) return;

  const had = !!root.querySelector('.tcard');
  closeNotice();

  const build = () => {
    const card = document.createElement('div');
    card.className = 'tcard';

    const ic = document.createElement('div');
    ic.className = 'tcard-ico';
    ic.innerHTML = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" '
      + 'stroke="currentColor" stroke-width="2" stroke-linecap="round">'
      + '<circle cx="12" cy="12" r="9"/><path d="M12 7.6v5"/>'
      + '<circle cx="12" cy="16.3" r="0.95" fill="currentColor" stroke="none"/></svg>';

    const main = document.createElement('div');
    main.className = 'tcard-main';

    const t = document.createElement('div');
    t.className = 'tcard-title';
    t.textContent = opts.title || '';
    main.appendChild(t);

    if (opts.desc) {
      const d = document.createElement('div');
      d.className = 'tcard-desc';
      d.textContent = opts.desc;
      main.appendChild(d);
    }

    const btns = document.createElement('div');
    btns.className = 'tcard-btns';
    (opts.actions || []).forEach((a) => {
      const b = document.createElement('button');
      b.className = 'tbtn' + (a.kind === 'primary' ? ' primary' : '');
      b.textContent = a.label;
      b.onclick = async () => {
        closeNotice();
        try { await a.act(); } catch (e) { toast('操作失败：' + e.message); }
      };
      btns.appendChild(b);
    });

    card.appendChild(ic);
    card.appendChild(main);
    card.appendChild(btns);
    root.appendChild(card);

    // 鼠标停在上面就别自己消失——正在读的用户不想它突然溜走
    const arm = () => {
      clearTimeout(noticeTimer);
      noticeTimer = setTimeout(closeNotice, opts.timeout || 9000);
    };
    card.addEventListener('mouseenter', () => clearTimeout(noticeTimer));
    card.addEventListener('mouseleave', arm);
    arm();
  };

  if (had) setTimeout(build, 210);
  else build();
}

/** 软件已经不在的提示：给"从收纳盒移除"和"先留着"两个出口 */
function missingNotice(g, a) {
  notice({
    title: `找不到「${a.name}」`,
    desc: '它可能已经被卸载，或文件被移动、改名了。要把这条从收纳盒里移除吗？',
    timeout: 12000,
    actions: [
      {
        label: '从收纳盒移除',
        kind: 'primary',
        act: async () => {
          const r = await window.api.removeApp(g.id, a.path, true);
          if (r.ok) {
            applyState(r.state);
            toast('已移除「' + a.name + '」');
          } else {
            toast(r.msg || '移除失败');
          }
        }
      },
      { label: '先留着', act: () => {} }
    ]
  });
}
