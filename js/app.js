'use strict';
/* ============================================================
 * my-album · 本地相册浏览器（纯静态，零依赖，离线可用）
 * 技术：File System Access API + IndexedDB
 * ============================================================ */
(() => {

  /* ---------- 常量 ---------- */
  const DAY = 86400000;
  const TRASH_DAYS = 30;
  const IMG_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif', 'tif', 'tiff'];

  /* ---------- 浏览器文件系统能力检测（用于相册管理降级） ---------- */
  const fsCaps = (() => {
    const DH = typeof FileSystemDirectoryHandle !== 'undefined' ? FileSystemDirectoryHandle.prototype : null;
    const H = typeof FileSystemHandle !== 'undefined' ? FileSystemHandle.prototype : null;
    const FH = typeof FileSystemFileHandle !== 'undefined' ? FileSystemFileHandle.prototype : null;
    return {
      createDir: !!(DH && (typeof DH.createDirectory === 'function' || typeof DH.getDirectoryHandle === 'function')),
      removeEntry: !!(DH && typeof DH.removeEntry === 'function'),
      move: !!(H && typeof H.move === 'function'),
      writeFile: !!(FH && typeof FH.createWritable === 'function'),
    };
  })();
  const fsTip = '当前浏览器不支持此操作，建议使用 Chrome 或 Edge（或 Firefox 131+）';

  /* ---------- 工具 ---------- */
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const isImage = n => { const i = n.lastIndexOf('.'); return i > 0 && IMG_EXT.includes(n.slice(i + 1).toLowerCase()); };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = n => String(n).padStart(2, '0');
  const fmtDate = ts => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const trashId = (album, name) => album + '\u0000' + name;

  /* ---------- 状态 ---------- */
  const state = {
    root: null,          // 相册根目录句柄
    albums: [],          // [{name, photos:[{name,lastModified,file}]}]
    album: null,         // 当前打开的相册
    sortDesc: true,      // true=最新优先 false=最早优先
    view: 'landing',
    viewerPhotos: [],    // 查看器当前照片列表（已按排序/回收站过滤）
    viewerIndex: 0,
    viewerUrl: null,
    urls: new Set(),     // 待释放的 objectURL
  };
  let trashIds = new Set(); // 已删除照片 id 集合
  let albumModalMode = 'create'; // create | rename
  let albumModalTarget = null;
  let sheetTarget = null;

  /* ---------- IndexedDB（失败时降级为内存，保证兼容模式可用） ---------- */
  let idbOk = true, _db = null;
  const memKV = new Map();
  const memTrash = new Map();

  function openDB() {
    return new Promise((res, rej) => {
      const rq = indexedDB.open('my-album-db', 1);
      rq.onupgradeneeded = () => {
        const d = rq.result;
        if (!d.objectStoreNames.contains('trash')) d.createObjectStore('trash', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      };
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
  }
  async function db() { if (!_db) _db = await openDB(); return _db; }
  function idbReq(rq) { return new Promise((res, rej) => { rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); }); }

  async function kvGet(key) {
    if (!idbOk) return memKV.get(key);
    try { const d = await db(); return await idbReq(d.transaction('kv').objectStore('kv').get(key)); }
    catch (e) { idbOk = false; return memKV.get(key); }
  }
  async function kvSet(key, val) {
    if (!idbOk) { memKV.set(key, val); return; }
    try { const d = await db(); await idbReq(d.transaction('kv', 'readwrite').objectStore('kv').put(val, key)); }
    catch (e) { idbOk = false; memKV.set(key, val); }
  }
  async function trashAdd(item) {
    if (!idbOk) { memTrash.set(item.id, item); return; }
    try { const d = await db(); await idbReq(d.transaction('trash', 'readwrite').objectStore('trash').put(item)); }
    catch (e) { idbOk = false; memTrash.set(item.id, item); }
  }
  async function trashAll() {
    if (!idbOk) return Array.from(memTrash.values());
    try { const d = await db(); return (await idbReq(d.transaction('trash').objectStore('trash').getAll())) || []; }
    catch (e) { idbOk = false; return Array.from(memTrash.values()); }
  }
  async function trashRemove(id) {
    if (!idbOk) { memTrash.delete(id); return; }
    try { const d = await db(); await idbReq(d.transaction('trash', 'readwrite').objectStore('trash').delete(id)); }
    catch (e) { idbOk = false; memTrash.delete(id); }
  }
  async function trashClear() {
    if (!idbOk) { memTrash.clear(); return; }
    try { const d = await db(); await idbReq(d.transaction('trash', 'readwrite').objectStore('trash').clear()); }
    catch (e) { idbOk = false; memTrash.clear(); }
  }

  /* ---------- objectURL 管理 ---------- */
  function urlOf(file) { const u = URL.createObjectURL(file); state.urls.add(u); return u; }
  function releaseUrls() { state.urls.forEach(u => URL.revokeObjectURL(u)); state.urls.clear(); }
  function releaseViewerUrl() { if (state.viewerUrl) { URL.revokeObjectURL(state.viewerUrl); state.viewerUrl = null; } }

  /* ---------- 生成缩略图（用于最近删除存储） ---------- */
  async function makeThumb(file, size = 480) {
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, size / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * scale));
      const h = Math.max(1, Math.round(bmp.height * scale));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(bmp, 0, 0, w, h);
      bmp.close();
      return await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
    } catch (e) { return file; } // 兜底：存原文件
  }

  /* ---------- 扫描：两层结构（相册/子相册/照片） ---------- */
  async function scan(root) {
    const albums = [];
    const rootPhotos = [];
    for await (const [name, handle] of root.entries()) {
      if (handle.kind === 'directory') {
        const photos = [];
        for await (const [fn, fh] of handle.entries()) {
          if (fh.kind === 'file' && isImage(fn)) {
            try { const file = await fh.getFile(); photos.push({ name: fn, lastModified: file.lastModified, file }); } catch (e) { /* 跳过无法读取的文件 */ }
          }
        }
        albums.push({ name, photos, handle });
      } else if (handle.kind === 'file' && isImage(name)) {
        try { const file = await handle.getFile(); rootPhotos.push({ name, lastModified: file.lastModified, file }); } catch (e) { }
      }
    }
    // 没有子相册时，根目录照片显示为「默认相册」
    if (albums.length === 0 && rootPhotos.length) {
      albums.push({ name: '默认相册', photos: rootPhotos, isDefault: true });
    }
    albums.forEach(a => a.photos.sort((x, y) => x.lastModified - y.lastModified));
    albums.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    return albums;
  }

  /* ---------- 兼容模式：由 webkitdirectory 选中的文件构造伪根句柄 ---------- */
  function pseudoRootFromFiles(files) {
    const map = new Map(); // 子相册名 -> 照片数组
    const rootPhotos = [];
    for (const f of files) {
      if (!isImage(f.name)) continue;
      const parts = (f.webkitRelativePath || f.name).split('/');
      const rel = parts.slice(1);
      if (rel.length <= 1) {
        rootPhotos.push({ name: rel[0] || f.name, lastModified: f.lastModified, file: f });
      } else if (rel.length === 2) {
        const arr = map.get(rel[0]) || [];
        arr.push({ name: rel[1], lastModified: f.lastModified, file: f });
        map.set(rel[0], arr);
      } // 超过两层：忽略
    }
    return {
      kind: 'directory', name: 'root',
      entries: async function* () {
        for (const [name, photos] of map) {
          yield [name, {
            kind: 'directory', name,
            entries: async function* () {
              for (const p of photos) yield [p.name, { kind: 'file', name: p.name, getFile: async () => p.file }];
            }
          }];
        }
        for (const p of rootPhotos) yield [p.name, { kind: 'file', name: p.name, getFile: async () => p.file }];
      }
    };
  }
  /* 拖拽 fallback：webkitGetAsEntry 遍历 */
  function entryToHandle(entry) {
    return new Promise((resolve, reject) => {
      if (!entry) return reject(new Error('无法读取拖入的项目'));
      if (entry.isFile) {
        entry.file(f => resolve({ kind: 'file', name: entry.name, getFile: async () => f }), reject);
      } else {
        const reader = entry.createReader();
        const all = [];
        const readAll = () => reader.readEntries(async es => {
          if (!es.length) {
            resolve({
              kind: 'directory', name: entry.name,
              entries: async function* () {
                for (const e of all) yield [e.name, await entryToHandle(e)];
              }
            });
          } else { all.push(...es); readAll(); }
        }, reject);
        readAll();
      }
    });
  }

  /* ---------- 视图切换 ---------- */
  function switchView(name) {
    state.view = name;
    $$('.view').forEach(v => v.classList.remove('active'));
    $('#view-' + name).classList.add('active');
    window.scrollTo(0, 0);
  }
  function showLanding() { switchView('landing'); }

  /* ---------- Toast / Loading ---------- */
  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }
  function showLoading(msg) { $('#loading-msg').textContent = msg || '正在扫描相册…'; $('#loading').classList.remove('hidden'); }
  function hideLoading() { $('#loading').classList.add('hidden'); }

  /* ---------- 根目录设置与扫描 ---------- */
  async function setRoot(h) {
    state.root = h;
    releaseUrls();
    state.albums = []; state.album = null;
    await kvSet('dirHandle', h); // 记住授权（部分浏览器不支持持久化句柄，会静默降级）
    showLoading('正在扫描相册…');
    try {
      state.albums = await scan(h);
      renderAlbums();
      switchView('albums');
      toast('已载入 ' + state.albums.length + ' 个相册');
    } catch (e) {
      console.error(e);
      toast('读取失败：' + e.message + '（文件夹可能已被移动，请重新选择）');
      showLanding();
    } finally {
      hideLoading();
    }
  }

  async function pickDir() {
    try {
      // 优先申请读写权限（相册增删改查需要）
      const h = await window.showDirectoryPicker({ mode: 'readwrite', id: 'album-root' });
      await setRoot(h);
    } catch (e) {
      if (e && e.name !== 'AbortError') {
        try {
          const h = await window.showDirectoryPicker({ mode: 'read', id: 'album-root' });
          await setRoot(h);
          toast('已使用只读模式：可以浏览，但无法新建/重命名/删除相册');
        } catch (e2) {
          if (e2 && e2.name !== 'AbortError') toast('打开文件夹失败：' + e2.message);
        }
      }
    }
  }

  /* ---------- 相册列表 ---------- */
  function renderAlbums() {
    releaseUrls();
    const visibleCount = a => a.photos.filter(p => !trashIds.has(trashId(a.name, p.name))).length;
    const total = state.albums.reduce((n, a) => n + visibleCount(a), 0);
    $('#albums-sub').textContent = `${state.albums.length} 个相册 · ${total} 张照片`;
    const grid = $('#album-grid');
    grid.innerHTML = '';
    state.albums.forEach(a => {
      // 封面与计数同样过滤最近删除中的照片
      const photos = a.photos.filter(p => !trashIds.has(trashId(a.name, p.name)));
      const card = document.createElement('div');
      card.className = 'album-card';
      const cover = document.createElement('div');
      cover.className = 'album-cover';
      const cells = photos.slice(-4).reverse(); // 最新 4 张（已过滤回收站）
      if (cells.length) {
        for (let i = 0; i < 4; i++) {
          const cell = document.createElement('div');
          cell.className = 'album-cell';
          if (cells[i]) {
            const img = document.createElement('img');
            img.loading = 'lazy'; img.decoding = 'async'; img.alt = '';
            img.src = urlOf(cells[i].file);
            cell.appendChild(img);
          }
          cover.appendChild(cell);
        }
      } else {
        cover.classList.add('album-cover-empty');
        cover.innerHTML = '<span>📂</span>';
      }
      const name = document.createElement('div');
      name.className = 'album-name';
      name.textContent = a.name;
      name.title = a.name;
      const cnt = document.createElement('div');
      cnt.className = 'album-count';
      cnt.textContent = `${photos.length} 张`;
      card.append(cover, name, cnt);
      const more = document.createElement('button');
      more.className = 'album-more';
      more.textContent = '⋯';
      more.title = '更多操作';
      more.addEventListener('click', e => { e.stopPropagation(); openAlbumActions(a); });
      card.appendChild(more);
      card.addEventListener('click', () => openAlbum(a));
      grid.appendChild(card);
    });
    if (!state.albums.length) {
      grid.innerHTML = `<div class="empty">
        <div class="empty-icon">🖼️</div>
        <div class="empty-title">「相册」文件夹还是空的</div>
        <div class="empty-sub">在「相册」文件夹下新建子文件夹作为相册，并把照片放进去；<br>或直接把照片放在「相册」文件夹里，会显示为「默认相册」</div>
      </div>`;
    }
  }

  /* ---------- 相册内照片 ---------- */
  function visiblePhotos() {
    const list = state.album.photos.filter(p => !trashIds.has(trashId(state.album.name, p.name)));
    if (state.sortDesc) list.reverse(); // 模型升序，显示按需反转
    return list;
  }
  function openAlbum(album) {
    state.album = album;
    renderPhotos();
    switchView('photos');
  }
  function renderPhotos() {
    releaseUrls();
    const photos = visiblePhotos();
    $('#photo-title').textContent = state.album.name;
    $('#photo-title').title = state.album.name;
    $('#photo-sub').textContent = `${photos.length} 张`;
    updateSegmented();
    const grid = $('#photo-grid');
    grid.innerHTML = '';
    if (photos.length) {
      // 时间线：按天分组，每组前插入灰色日期标签
      const groups = groupPhotos(photos);
      let idx = 0;
      groups.forEach(g => {
        const label = document.createElement('div');
        label.className = 'timeline-label';
        label.textContent = fmtDayLabel(g.ts);
        grid.appendChild(label);
        g.photos.forEach(p => {
          const t = document.createElement('button');
          t.className = 'photo-tile';
          t.type = 'button';
          t.title = `${p.name}\n${fmtDate(p.lastModified)}`;
          const img = document.createElement('img');
          img.loading = 'lazy'; img.decoding = 'async';
          img.src = urlOf(p.file);
          img.alt = p.name;
          t.appendChild(img);
          const i = idx; // 按值捕获，避免闭包拿到循环结束后的最终值
          t.addEventListener('click', () => openViewer(photos, i));
          grid.appendChild(t);
          idx++;
        });
      });
    } else {
      grid.innerHTML = `<div class="empty">
        <div class="empty-icon">🖼️</div>
        <div class="empty-title">此相册暂无照片</div>
        <div class="empty-sub">把照片放到「相册」文件夹下的「${esc(state.album.name)}」子文件夹里</div>
      </div>`;
    }
  }
  function updateSegmented() {
    $$('#sort-seg button').forEach(b => b.classList.toggle('on', (b.dataset.v === 'desc') === state.sortDesc));
  }

  /* ---------- 全屏查看器 ---------- */
  function openViewer(photos, index) {
    state.viewerPhotos = photos;
    state.viewerIndex = index;
    $('#viewer').classList.remove('hidden');
    $('#viewer').classList.remove('chrome-hidden');
    document.body.classList.add('no-scroll');
    showViewerImage();
  }
  function closeViewer() {
    $('#viewer').classList.add('hidden');
    document.body.classList.remove('no-scroll');
    releaseViewerUrl();
    resetZoom();
  }
  function showViewerImage() {
    const p = state.viewerPhotos[state.viewerIndex];
    if (!p) { closeViewer(); return; }
    releaseViewerUrl();
    state.viewerUrl = urlOf(p.file);
    const img = $('#viewer-img');
    img.style.opacity = 0;
    img.src = state.viewerUrl;
    img.onload = () => { img.style.opacity = 1; };
    $('#viewer-count').textContent = `${state.viewerIndex + 1} / ${state.viewerPhotos.length}`;
    $('#viewer-name').textContent = p.name;
    resetZoom();
  }
  function navViewer(d) {
    if (!state.viewerPhotos.length) return;
    state.viewerIndex = (state.viewerIndex + d + state.viewerPhotos.length) % state.viewerPhotos.length;
    showViewerImage();
  }

  /* 缩放 / 平移 / 滑动 */
  let z = { scale: 1, tx: 0, ty: 0, ox: 50, oy: 50 };
  function applyZoom() {
    const img = $('#viewer-img');
    img.style.transform = `translate(${z.tx}px, ${z.ty}px) scale(${z.scale})`;
    img.style.transformOrigin = `${z.ox}% ${z.oy}%`;
  }
  function resetZoom() { z = { scale: 1, tx: 0, ty: 0, ox: 50, oy: 50 }; applyZoom(); }

  const stage = $('#viewer-stage');
  stage.addEventListener('wheel', e => {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    z.ox = ((e.clientX - r.left) / r.width) * 100;
    z.oy = ((e.clientY - r.top) / r.height) * 100;
    z.scale = Math.min(8, Math.max(1, z.scale * (e.deltaY < 0 ? 1.25 : 0.8)));
    if (z.scale === 1) { z.tx = 0; z.ty = 0; }
    applyZoom();
  }, { passive: false });

  let drag = null, moved = 0;
  stage.addEventListener('pointerdown', e => {
    drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, id: e.pointerId, type: e.pointerType };
    moved = 0;
    try { stage.setPointerCapture(e.pointerId); } catch (err) { }
  });
  stage.addEventListener('pointermove', e => {
    if (!drag || drag.id !== e.pointerId) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    moved = Math.max(moved, Math.abs(e.clientX - drag.sx), Math.abs(e.clientY - drag.sy));
    if (z.scale > 1) {
      z.tx += dx; z.ty += dy;
      stage.classList.add('dragging');
      const img = $('#viewer-img');
      img.style.transition = 'none';
      applyZoom();
      img.style.transition = '';
    }
    drag.x = e.clientX; drag.y = e.clientY;
  });
  stage.addEventListener('pointerup', e => {
    if (!drag || drag.id !== e.pointerId) return;
    const d = drag;
    drag = null;
    stage.classList.remove('dragging');
    if (z.scale === 1 && d.type === 'touch' && moved > 50) {
      navViewer(e.clientX - d.sx < 0 ? 1 : -1); // 左滑下一张，右滑上一张
    }
  });
  stage.addEventListener('click', e => {
    if (moved > 8) return; // 拖动/滑动后不触发
    $('#viewer').classList.toggle('chrome-hidden');
  });
  stage.addEventListener('dblclick', e => {
    if (z.scale > 1) { resetZoom(); return; }
    const r = stage.getBoundingClientRect();
    z.ox = ((e.clientX - r.left) / r.width) * 100;
    z.oy = ((e.clientY - r.top) / r.height) * 100;
    z.scale = 2.5; z.tx = 0; z.ty = 0;
    applyZoom();
  });

  /* ---------- 相册管理（增删改查，需读写权限） ---------- */
  function validAlbumName(n) {
    n = (n || '').trim();
    if (!n) return '相册名不能为空';
    if (n.length > 60) return '相册名太长（最多 60 个字符）';
    if (/[\\/:*?"<>|]/.test(n)) return '不能包含 \\ / : * ? " < > | 字符';
    if (/[. ]$/.test(n)) return '相册名不能以空格或点结尾';
    return null;
  }
  async function canWrite() {
    const h = state.root;
    if (!h || !h.queryPermission) return false; // 兼容模式句柄不支持写
    try {
      let p = await h.queryPermission({ mode: 'readwrite' });
      if (p !== 'granted') p = await h.requestPermission({ mode: 'readwrite' });
      return p === 'granted';
    } catch (e) { return false; }
  }
  async function rescan() {
    showLoading('正在刷新…');
    try {
      state.albums = await scan(state.root);
      renderAlbums();
      if (state.view === 'photos' && state.album) {
        state.album = state.albums.find(a => a.name === state.album.name) || null;
        if (state.album) renderPhotos();
        else { renderAlbums(); switchView('albums'); }
      }
    } finally { hideLoading(); }
  }
  /* 创建 */
  async function doCreateAlbum(name) {
    if (!fsCaps.createDir) { toast(fsTip); return false; }
    try {
      if (typeof state.root.createDirectory === 'function') {
        await state.root.createDirectory(name);
      } else {
        await state.root.getDirectoryHandle(name, { create: true });
      }
    } catch (e) {
      toast('创建失败：' + (e && e.message || e));
      return false;
    }
    await rescan();
    const a = state.albums.find(x => x.name === name);
    if (a) openAlbum(a);
    toast('已创建相册「' + name + '」');
    return true;
  }
  /* 重命名：move 优先，不支持时降级为「复制到新目录 + 删除旧目录」 */
  async function doRenameAlbum(oldName, newName) {
    const album = state.albums.find(a => a.name === oldName);
    if (!album || !album.handle) { toast('无法重命名（当前为兼容模式）'); return false; }
    try {
      if (typeof album.handle.move === 'function') {
        await album.handle.move(newName);
      } else {
        await fsCopyRename(album, newName);
      }
    } catch (e) {
      toast('重命名失败：' + (e && e.message || e));
      return false;
    }
    await renameTrashAlbum(oldName, newName); // 同步最近删除中的相册名
    await rescan();
    toast('已重命名为「' + newName + '」');
    return true;
  }
  /* 降级重命名：新建目标目录 → 逐张复制照片 → 删除旧目录 */
  async function fsCopyRename(album, newName) {
    if (!fsCaps.writeFile || !fsCaps.removeEntry) throw new Error(fsTip);
    const dir = album.handle;
    const newDir = typeof state.root.createDirectory === 'function'
      ? await state.root.createDirectory(newName)
      : await state.root.getDirectoryHandle(newName, { create: true });
    for await (const [n, child] of dir.entries()) {
      if (child.kind !== 'file') continue; // 深层子目录不复制（本项目约定最多两层）
      const f = await child.getFile();
      const dest = await newDir.getFileHandle(n, { create: true });
      const w = await dest.createWritable();
      await w.write(f);
      await w.close();
    }
    await fsDeleteAlbum(album);
  }
  /* 删除（真实删除磁盘文件夹及其内所有照片）
   * 用标准 removeEntry 实现，不依赖较新的 FileSystemHandle.remove() */
  async function deleteAlbum(album) {
    if (!album.handle) { toast('无法删除（当前为兼容模式）'); return; }
    if (!await canWrite()) { toast('需要「读写」权限才能删除相册'); return; }
    if (!fsCaps.removeEntry) { toast(fsTip); return; }
    const msg = `确定删除相册「${album.name}」吗？\n\n将删除磁盘上该文件夹内的 ${album.photos.length} 张照片，且无法恢复！`;
    if (!confirm(msg)) return;
    try { await fsDeleteAlbum(album); }
    catch (e) { toast('删除失败：' + (e && e.message || e)); return; }
    await removeTrashAlbum(album.name);
    toast('已删除相册「' + album.name + '」');
    if (state.album && state.album.name === album.name) {
      state.album = null;
      switchView('albums');
    }
    await rescan();
  }
  /* 递归清空目录并用 removeEntry 删除相册目录本身 */
  async function fsDeleteAlbum(album) {
    const dir = album.handle;
    if (typeof dir.removeEntry !== 'function') throw new Error(fsTip);
    async function clear(h) {
      for await (const [n, child] of h.entries()) {
        if (child.kind === 'directory') await clear(child);
        await h.removeEntry(n);
      }
    }
    await clear(dir);
    await state.root.removeEntry(album.name);
  }
  async function renameTrashAlbum(oldName, newName) {
    for (const t of await trashAll()) {
      if (t.album === oldName) { t.album = newName; await trashAdd(t); }
    }
  }
  async function removeTrashAlbum(name) {
    for (const t of await trashAll()) {
      if (t.album === name) await trashRemove(t.id);
    }
    const prefix = name + '\u0000';
    trashIds = new Set(Array.from(trashIds).filter(id => !id.startsWith(prefix)));
  }
  /* 弹窗 */
  function openAlbumModal(mode, album) {
    albumModalMode = mode;
    albumModalTarget = album || null;
    $('#album-modal-title').textContent = mode === 'create' ? '新建相册' : '重命名相册';
    $('#album-modal-input').value = mode === 'create' ? '' : album.name;
    $('#album-modal-err').textContent = '';
    $('#album-modal').classList.remove('hidden');
    const input = $('#album-modal-input');
    input.focus();
    input.select();
  }
  function closeAlbumModal() { $('#album-modal').classList.add('hidden'); }
  function openAlbumActions(album) {
    sheetTarget = album;
    $('#sheet-title').textContent = album.name;
    $('#action-sheet').classList.remove('hidden');
  }
  function closeActionSheet() { $('#action-sheet').classList.add('hidden'); sheetTarget = null; }
  async function submitAlbumModal() {
    const name = $('#album-modal-input').value.trim();
    if (albumModalMode === 'rename' && albumModalTarget && name === albumModalTarget.name) {
      closeAlbumModal();
      return;
    }
    const err = validAlbumName(name);
    if (err) { $('#album-modal-err').textContent = err; return; }
    if (state.albums.some(a => a.name === name)) { $('#album-modal-err').textContent = '已存在同名相册'; return; }
    closeAlbumModal();
    if (albumModalMode === 'create') await doCreateAlbum(name);
    else if (albumModalTarget) await doRenameAlbum(albumModalTarget.name, name);
  }

  /* ---------- 时间线分组（按天） ---------- */
  function groupPhotos(photos) {
    const groups = [];
    let cur = null, curDay = null;
    for (const p of photos) {
      const d = new Date(p.lastModified);
      const day = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
      if (day !== curDay) { cur = { day, ts: d.getTime(), photos: [] }; groups.push(cur); curDay = day; }
      cur.photos.push(p);
    }
    return groups;
  }
  function fmtDayLabel(ts) {
    const d = new Date(ts);
    const wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${wd}`;
  }

  /* ---------- 最近删除 ---------- */
  async function refreshTrashIds() {
    trashIds = new Set((await trashAll()).map(t => t.id));
  }
  async function purgeTrash() {
    const cutoff = Date.now() - TRASH_DAYS * DAY;
    for (const t of await trashAll()) {
      if (t.deletedAt < cutoff) await trashRemove(t.id);
    }
  }
  async function deleteCurrent() {
    const p = state.viewerPhotos[state.viewerIndex];
    if (!p) return;
    const id = trashId(state.album.name, p.name);
    if (trashIds.has(id)) return;
    showLoading('正在处理…');
    try {
      const thumb = await makeThumb(p.file);
      await trashAdd({ id, album: state.album.name, name: p.name, deletedAt: Date.now(), lastModified: p.lastModified, thumb });
      trashIds.add(id);
    } finally { hideLoading(); }
    toast('已移到「最近删除」，30 天后自动清除');
    state.viewerPhotos.splice(state.viewerIndex, 1);
    if (state.viewerPhotos.length) {
      if (state.viewerIndex >= state.viewerPhotos.length) state.viewerIndex = state.viewerPhotos.length - 1;
      showViewerImage();
    } else {
      closeViewer();
    }
    renderPhotos();
  }

  function daysLeft(t) { return Math.max(0, Math.ceil((t.deletedAt + TRASH_DAYS * DAY - Date.now()) / DAY)); }

  async function renderTrash() {
    await purgeTrash();
    const items = (await trashAll()).sort((a, b) => b.deletedAt - a.deletedAt);
    $('#trash-sub').textContent = items.length
      ? `${items.length} 张 · ${TRASH_DAYS} 天后自动清除`
      : '暂无已删除的照片';
    const grid = $('#trash-grid');
    grid.innerHTML = '';
    items.forEach(t => {
      const tile = document.createElement('button');
      tile.className = 'photo-tile';
      tile.type = 'button';
      tile.title = t.name;
      const img = document.createElement('img');
      img.alt = t.name;
      img.src = URL.createObjectURL(t.thumb);
      tile.appendChild(img);
      const days = daysLeft(t);
      const badge = document.createElement('span');
      badge.className = 'trash-days';
      badge.textContent = days ? `${days} 天` : '即将清除';
      tile.appendChild(badge);
      tile.addEventListener('click', () => openTrashModal(t));
      grid.appendChild(tile);
    });
    if (!items.length) {
      grid.innerHTML = `<div class="empty">
        <div class="empty-icon">🗑️</div>
        <div class="empty-title">最近删除是空的</div>
        <div class="empty-sub">删除的照片会在这里保留 ${TRASH_DAYS} 天，可随时恢复</div>
      </div>`;
    }
  }

  /* 回收站详情弹窗 */
  let modalItem = null;
  function openTrashModal(t) {
    modalItem = t;
    $('#modal-img').src = URL.createObjectURL(t.thumb);
    $('#modal-name').textContent = t.name;
    const days = daysLeft(t);
    $('#modal-info').innerHTML =
      `<div>相册：${esc(t.album)}</div>` +
      `<div>删除于 ${fmtDate(t.deletedAt)}${days ? ` · 剩余 ${days} 天` : ' · 即将自动清除'}</div>`;
    $('#trash-modal').classList.remove('hidden');
  }
  function closeTrashModal() { $('#trash-modal').classList.add('hidden'); modalItem = null; }
  async function restoreModalItem() {
    if (!modalItem) return;
    await trashRemove(modalItem.id);
    trashIds.delete(modalItem.id);
    toast('已恢复「' + modalItem.name + '」');
    closeTrashModal();
    renderTrash();
    if (state.view === 'photos') renderPhotos();
  }
  async function purgeModalItem() {
    if (!modalItem) return;
    await trashRemove(modalItem.id);
    trashIds.delete(modalItem.id);
    toast('已彻底删除');
    closeTrashModal();
    renderTrash();
  }

  /* ---------- 事件绑定 ---------- */
  /* 首页 */
  $('#btn-pick').addEventListener('click', async () => {
    // 已有记住的句柄：先尝试直接复用
    const h = state.root || await kvGet('dirHandle');
    if (h && h.queryPermission) {
      try {
        let perm = await h.queryPermission({ mode: 'read' });
        if (perm !== 'granted') perm = await h.requestPermission({ mode: 'read' });
        if (perm === 'granted') { await setRoot(h); return; }
      } catch (e) { /* 句柄失效则重新选择 */ }
    }
    pickDir();
  });
  $('#btn-pick-fallback').addEventListener('click', () => $('#dir-input').click());
  $('#dir-input').addEventListener('change', async e => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    e.target.value = '';
    await setRoot(pseudoRootFromFiles(files));
  });
  /* 拖拽文件夹进页面 */
  window.addEventListener('dragover', e => { e.preventDefault(); });
  window.addEventListener('drop', async e => {
    e.preventDefault();
    const items = e.dataTransfer && e.dataTransfer.items;
    if (!items) return;
    for (const it of items) {
      if (it.kind !== 'file') continue;
      let h = null;
      if (it.getAsFileSystemHandle) { try { h = await it.getAsFileSystemHandle(); } catch (err) { } }
      if (!h && it.webkitGetAsEntry) { try { h = await entryToHandle(it.webkitGetAsEntry()); } catch (err) { } }
      if (h && h.kind === 'directory') { await setRoot(h); return; }
    }
    toast('请拖入一个文件夹（例如「相册」文件夹）');
  });

  /* 顶栏 */
  $('#btn-create').addEventListener('click', async () => {
    if (!fsCaps.createDir) { toast(fsTip); return; }
    if (!await canWrite()) { toast('需要「读写」权限才能新建相册'); return; }
    openAlbumModal('create');
  });
  $('#btn-repick').addEventListener('click', pickDir);
  $('#btn-trash').addEventListener('click', async () => { renderTrash(); switchView('trash'); });
  $('#btn-trash-clear').addEventListener('click', async () => {
    if (!(await trashAll()).length) { toast('最近删除已经是空的'); return; }
    if (!confirm('确定清空最近删除吗？清空后无法恢复。')) return;
    await trashClear();
    trashIds.clear();
    renderTrash();
    toast('已清空最近删除');
  });
  $('#btn-back-albums').addEventListener('click', () => { renderAlbums(); switchView('albums'); });
  $('#btn-back-trash').addEventListener('click', () => { renderAlbums(); switchView('albums'); });

  /* 排序 */
  $('#sort-seg').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    state.sortDesc = b.dataset.v === 'desc';
    kvSet('sortDesc', state.sortDesc);
    updateSegmented();
    renderPhotos();
  });

  /* 查看器 */
  $('#viewer-close').addEventListener('click', closeViewer);
  $('#viewer-prev').addEventListener('click', () => navViewer(-1));
  $('#viewer-next').addEventListener('click', () => navViewer(1));
  $('#viewer-delete').addEventListener('click', deleteCurrent);

  /* 快捷键：Escape 关闭任意弹窗，Enter 提交相册名 */
  document.addEventListener('keydown', e => {
    const anyModal = ['#trash-modal', '#album-modal', '#action-sheet'].some(s => !$(s).classList.contains('hidden'));
    if (anyModal) {
      if (e.key === 'Escape') {
        closeTrashModal(); closeAlbumModal(); closeActionSheet();
      } else if (e.key === 'Enter' && !$('#album-modal').classList.contains('hidden')) {
        e.preventDefault();
        submitAlbumModal();
      }
      return;
    }
    if ($('#viewer').classList.contains('hidden')) return;
    if (e.key === 'Escape') closeViewer();
    else if (e.key === 'ArrowLeft') navViewer(-1);
    else if (e.key === 'ArrowRight') navViewer(1);
    else if (e.key === 'Delete') deleteCurrent();
  });

  /* 弹窗 */
  $('#modal-close').addEventListener('click', closeTrashModal);
  $('#modal-restore').addEventListener('click', restoreModalItem);
  $('#modal-purge').addEventListener('click', async () => {
    if (modalItem && confirm('彻底删除「' + modalItem.name + '」？此操作无法撤销。')) await purgeModalItem();
  });
  $('#trash-modal').addEventListener('click', e => { if (e.target === e.currentTarget) closeTrashModal(); });

  /* 相册管理弹窗 */
  $('#album-modal-cancel').addEventListener('click', closeAlbumModal);
  $('#album-modal-ok').addEventListener('click', submitAlbumModal);
  $('#album-modal-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submitAlbumModal(); } });
  $('#album-modal').addEventListener('click', e => { if (e.target === e.currentTarget) closeAlbumModal(); });
  $('#sheet-cancel').addEventListener('click', closeActionSheet);
  $('#action-sheet').addEventListener('click', e => { if (e.target === e.currentTarget) closeActionSheet(); });
  $('#sheet-rename').addEventListener('click', async () => {
    const target = sheetTarget; // 先保存，closeActionSheet 会清空它
    closeActionSheet();
    if (!target) return;
    if (!fsCaps.move && !(fsCaps.writeFile && fsCaps.removeEntry)) { toast(fsTip); return; }
    if (!await canWrite()) { toast('需要「读写」权限才能重命名相册'); return; }
    openAlbumModal('rename', target);
  });
  $('#sheet-delete').addEventListener('click', () => {
    const target = sheetTarget; // 先保存，closeActionSheet 会清空它
    closeActionSheet();
    if (target) deleteAlbum(target);
  });

  /* ---------- 启动 ---------- */
  (async function init() {
    if (!window.showDirectoryPicker) {
      $('#btn-pick').classList.add('hidden');
      $('#btn-pick-fallback').textContent = 'Choose photo folder';
    }
    try {
      await purgeTrash();
      await refreshTrashIds();
      const sd = await kvGet('sortDesc');
      if (typeof sd === 'boolean') state.sortDesc = sd;
      const h = await kvGet('dirHandle');
      if (h && h.queryPermission) {
        try {
          if (await h.queryPermission({ mode: 'read' }) === 'granted') {
            await setRoot(h);
            return;
          }
        } catch (e) { }
      }
    } catch (e) { console.warn('初始化降级：', e); }
    showLanding();
  })();

})();
