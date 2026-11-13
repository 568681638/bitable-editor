import '../styles/annotator.scss';
import '../styles/panel.scss';
import {
  FType, FieldMeta, RecordData,
  esc, isUrl, cleanUrl, segmentsToText, findUrlInSegments, extractUrlFromValue,
  detectUrlType, proxyUrl, resolveImageUrl, isFramebuster, installProxyFallback, HELP_URL,
  checkEmbeddable, clearEmbeddableCache,
} from '../shared/common';
import { createAnnotatorUI, FIELD_DRAG_TYPE } from '../shared/annotator-ui';
import { setupModeSwitch } from '../shared/mode-switch';
import { setupZoom } from '../shared/zoom';
import { setupMenu } from '../shared/menu';
import { describedError } from '../shared/errors';
import { autosizeTextarea, trackManualResize, installLineSelectAll, fitValueBox } from '../shared/textarea';
import type { HostMessage, PanelCommand, SnapshotMessage } from '../shared/bridge';

installProxyFallback();

// ── 与侧边栏插件通信 ──────────────────────────────
const opener = window.opener as Window | null;
const session = Math.random().toString(36).slice(2) + Date.now().toString(36); // 本次页面加载的标识
const pendingSaves = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
let saveSeq = 0;
let lastPong = Date.now();
let gotPong = false;
let snapshot: SnapshotMessage | null = null;

function send(cmd: PanelCommand) {
  opener?.postMessage(cmd, location.origin);
}

const connBanner = document.getElementById('connBanner') as HTMLElement;

const ui = createAnnotatorUI({
  urlPreview: true,
  draggableFields: true,
  onNavigate: (index) => send({ type: 'navigate', index }),
  onRefresh: () => { resetShareState(); send({ type: 'refresh' }); },
  saveRecord: (recordId, values) => new Promise<void>((resolve, reject) => {
    if (!opener) return reject(describedError('未连接到侧边栏：请回到多维表格侧边栏确认插件仍在运行（或重新点击 ⧉ 打开面板）'));
    const id = ++saveSeq;
    pendingSaves.set(id, { resolve, reject });
    send({ type: 'save', id, recordId, fields: values });
  }),
});

setupModeSwitch(ui.saveIfModified);
document.getElementById('autoContent')!.innerHTML = '<div class="empty-state"><p>批处理请在多维表格侧边栏里使用</p></div>';

window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.source !== opener || !e.data) return;
  const msg = e.data as HostMessage;
  if (msg.type === 'pong') { lastPong = Date.now(); gotPong = true; return; }
  if (msg.type === 'ack') {
    const p = pendingSaves.get(msg.id);
    pendingSaves.delete(msg.id);
    if (p) msg.ok ? p.resolve() : p.reject(describedError(msg.error || '保存失败，原因未知，请稍后重试'));
    return;
  }
  if (msg.type === 'snapshot') {
    lastPong = Date.now();
    gotPong = true;
    snapshot = msg;
    if (msg.tableId && msg.tableId !== currentTableId) switchTable(msg.tableId, msg.fields);
    if (msg.status) ui.showMessage(msg.status.kind, msg.status.text);
    else if (msg.record) ui.showRecord({ fields: msg.fields, options: msg.options, record: msg.record, index: msg.index, total: msg.total });
    else ui.showMessage('error', '未收到记录数据，请在侧边栏点击 ↻ 刷新');
    updateBlocks();
  }
});

if (!opener) {
  ui.showMessage('empty', '请在多维表格侧边栏的插件里点击「⧉」按钮打开本页');
} else {
  ui.showMessage('loading', '');
  // 心跳：同时用于侧边栏刷新后重新建立连接
  const openedAt = Date.now();
  let noReplyShown = false;
  const ping = () => {
    send({ type: 'panel-ready', session });
    connBanner.hidden = Date.now() - lastPong < 12000;
    // 打开后一直没收到侧边栏的任何回应：说明没连上，而不是还在加载
    if (!snapshot && !gotPong && !noReplyShown && Date.now() - openedAt > 5000) {
      noReplyShown = true;
      ui.showMessage('error', '没有收到侧边栏的响应。请确认多维表格里的插件侧边栏仍然打开、且没有被刷新，然后回到侧边栏重新点击「⧉」。');
    }
  };
  ping();
  setInterval(ping, 3000);
}

// ── 预览窗格字段块布局（树：split 节点按行/列切分，leaf 节点对应一个字段）──
// fieldName：导入时对应不上字段的字段块记着原字段名，等用户拖字段进来替换（见 isPending）
interface Leaf { kind: 'leaf'; id: string; fieldId: string; size: number; fieldName?: string; }
interface Split { kind: 'split'; dir: 'row' | 'column'; children: LayoutNode[]; size: number; }
// 组合块：把一个矩形区域里的若干字段块（任意排布）圈成一个整体：最外层有组合框，可整体移动，也可作为整体被别的字段切分。
// shared 打开时组内各字段只留标题栏，共用组底部的一个渲染区（哪个字段的链接能加载就用哪个）
// sync 打开时组内的视频 / 音频同步播放：播放其中一个，其他的一起播放；暂停其中一个，其他的一起暂停
interface Group { kind: 'group'; id: string; child: LayoutNode; shared: boolean; sync: boolean; size: number; }
type LayoutNode = Leaf | Split | Group;
type Zone = 'left' | 'right' | 'top' | 'bottom';

const LAYOUT_KEY = 'annotator-panel-layout-v2'; // 旧版：所有表格共用一份，只用于迁移
const layoutKeyOf = (tableId: string) => `annotator-panel-layout-v3:${tableId}`; // 现在：每个数据表各存一份
const LAST_TABLE_KEY = 'annotator-panel-last-table'; // 上次看的数据表，打开页面时先按它恢复布局，避免等快照时闪一下空白
const WIDTH_KEY = 'annotator-panel-width';
const ZOOM_KEY = 'annotator-panel-zoom-v4'; // 之前的版本会把默认值也自动存下来，换个 key 让它们失效
const BLOCK_DRAG_TYPE = 'application/x-annotator-block';
const NODE_DRAG_TYPE = 'application/x-annotator-node'; // 拖动组合框的把手（整组移动）
const HEADER_DRAG_TYPE = 'application/x-annotator-header'; // 拖动侧边栏标题名（同时带 FIELD_DRAG_TYPE，走字段拖入的同一套落点逻辑）
// 侧边栏的标题行也能做成字段块：fieldId 取这个固定值，不对应任何字段。
// 和字段不同，拖的是副本：侧边栏上的标题行原样保留，预览窗格里的那份把按钮操作转给侧边栏上的原按钮（侧边栏收起了也能用）
const HEADER_ID = '__header__';
const isHeaderLeaf = (l: Leaf) => l.fieldId === HEADER_ID;
// 预览窗格块标题栏里多行字段值的高度上限：窗口高度的比例。标题栏撑得越高，下面的渲染区越小，所以比侧边栏（50%）收得更紧
const BLOCK_VALUE_MAX_RATIO = 0.3;

function validNode(n: any): boolean {
  if (!n || typeof n.size !== 'number') return false;
  if (n.kind === 'leaf') return typeof n.id === 'string' && typeof n.fieldId === 'string';
  if (n.kind === 'group') return typeof n.id === 'string' && validNode(n.child);
  return n.kind === 'split' && (n.dir === 'row' || n.dir === 'column') && Array.isArray(n.children) && n.children.every(validNode);
}

function parseLayout(raw: string | null): LayoutNode | null {
  try {
    const n = JSON.parse(raw || '');
    if (validNode(n)) return normalize(n);
  } catch { /* ignore */ }
  return null;
}

let currentTableId = localStorage.getItem(LAST_TABLE_KEY) || '';
let root: LayoutNode | null = currentTableId ? parseLayout(localStorage.getItem(layoutKeyOf(currentTableId))) : null;
const saveLayout = () => { if (currentTableId) localStorage.setItem(layoutKeyOf(currentTableId), JSON.stringify(root)); };

// 侧边栏切到了另一张数据表：保存的是各表自己的布局（字段 ID 是表内的，跨表没有意义），换表就换成那张表的布局。
// 旧版所有表共用一份布局：第一次遇到字段能对上的那张表，把旧布局迁给它，然后删掉旧的，不再套到别的表上
function switchTable(tableId: string, fields: FieldMeta[]) {
  currentTableId = tableId;
  localStorage.setItem(LAST_TABLE_KEY, tableId);
  root = parseLayout(localStorage.getItem(layoutKeyOf(tableId)));
  if (!root) {
    const legacy = parseLayout(localStorage.getItem(LAYOUT_KEY));
    if (legacy && leaves(legacy).some(l => fields.some(f => f.id === l.fieldId))) {
      root = legacy;
      saveLayout();
      localStorage.removeItem(LAYOUT_KEY);
    }
  }
  renderBlocks();
}

const blocksEl = document.getElementById('blocks') as HTMLElement;
const blockEls = new Map<string, HTMLElement>();
const nodeEls = new Map<LayoutNode, HTMLElement>(); // 当前渲染出来的节点 → 元素
const shareBodyEls = new Map<string, HTMLElement>(); // 开了任一渲染的组合块 id → 组底部共用的渲染区（占位元素，内容在固定图层里）
const shareOfLeaf = new Map<string, Group>(); // 字段块 id → 管它渲染的共享组合块（最近的一层开了任一渲染的组合块）

// 网页 / 视频 / 图片等渲染内容放在一个固定不动的图层里，按对应字段块内容区的位置叠上去。
// 布局变化（新增、移动、切字段块）会重建字段块的容器；iframe 一旦换了父节点就会被浏览器重新加载，
// 所以渲染内容从不跟着挪动，布局变化时只更新它的位置和大小
const viewerLayer = document.getElementById('viewerLayer') as HTMLElement;
const viewerEls = new Map<string, HTMLElement>(); // 字段块 id → 渲染内容元素
const bodyObserver = new ResizeObserver(() => positionViewers());

// 预览窗格块标题栏里的值（单行框 / 多行框）：宽度变化时重新判断该用哪个框（变窄了单行装不下就换成自动换行的多行框，变宽了又换回来）并重新撑开高度。
// 只在宽度变化时重算，避免自己改高度又触发自己
const valueObserver = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const box = entry.target as HTMLElement;
    const w = Math.round(entry.contentRect.width);
    if (String(w) === box.dataset.lastWidth) continue;
    box.dataset.lastWidth = String(w);
    const block = box.closest('[data-block-id]') as HTMLElement | null;
    if (block) refitBlockValue(block);
  }
});
// 按块上记着的值重新判断（值和“值是不是被渲染的链接”在 updateBlock 里记下）
function refitBlockValue(el: HTMLElement) {
  const input = el.querySelector('input.block-value') as HTMLInputElement | null;
  const area = el.querySelector('textarea.block-value') as HTMLTextAreaElement | null;
  if (input && area) fitValueBox(input, area, el.dataset.valueText || '', el.dataset.valueUrl !== '1', BLOCK_VALUE_MAX_RATIO);
}
window.addEventListener('resize', () => {
  blockEls.forEach(el => {
    const ta = el.querySelector('textarea.block-value') as HTMLTextAreaElement | null;
    if (ta) autosizeTextarea(ta, BLOCK_VALUE_MAX_RATIO);
  });
});

function positionViewers() {
  const host = viewerLayer.getBoundingClientRect();
  viewerEls.forEach((wrap, id) => {
    const body = (blockEls.get(id)?.querySelector('.block-body') || shareBodyEls.get(id)) as HTMLElement | null | undefined;
    if (!body || !body.isConnected || body.hidden) { wrap.style.display = 'none'; return; }
    const r = body.getBoundingClientRect();
    wrap.style.display = 'flex';
    wrap.style.left = r.left - host.left + 'px';
    wrap.style.top = r.top - host.top + 'px';
    wrap.style.width = r.width + 'px';
    wrap.style.height = r.height + 'px';
  });
}

function ensureViewer(id: string, url: string) {
  let wrap = viewerEls.get(id);
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'viewer-item';
    wrap.dataset.leaf = id; // 单个字段块或共享组的 id
    // 渲染内容放在 .viewer-content 里；全屏按钮悬浮在左上角，不属于被渲染的页面
    wrap.innerHTML = `<div class="viewer-content"></div><button class="viewer-fs-btn" type="button" title="全屏显示（Esc 退出）">全屏</button>`;
    const item = wrap;
    (wrap.querySelector('.viewer-fs-btn') as HTMLElement).addEventListener('click', () => toggleFullscreen(item));
    viewerLayer.appendChild(wrap);
    viewerEls.set(id, wrap);
  }
  if (wrap.dataset.url === url) return; // 地址没变就不动，避免重载
  wrap.dataset.url = url;
  (wrap.querySelector('.viewer-content') as HTMLElement).innerHTML = renderViewer(url);
}

// ── 全屏：只改样式（position: fixed 铺满窗口），不挪动 DOM，所以 iframe / 视频不会重新加载 ──
function setFullscreen(wrap: HTMLElement, on: boolean) {
  wrap.classList.toggle('fullscreen', on);
  const btn = wrap.querySelector('.viewer-fs-btn') as HTMLElement;
  btn.textContent = on ? '退出全屏' : '全屏';
  btn.title = on ? '退出全屏（Esc）' : '全屏显示（Esc 退出）';
}

function exitFullscreen() {
  viewerEls.forEach(w => { if (w.classList.contains('fullscreen')) setFullscreen(w, false); });
}

function toggleFullscreen(wrap: HTMLElement) {
  const on = !wrap.classList.contains('fullscreen');
  exitFullscreen(); // 同一时间只允许一个全屏
  if (on) setFullscreen(wrap, true);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') exitFullscreen();
});

// ── 同步播放：开了同步播放的组里，一个视频 / 音频播放、暂停或拖动进度，同组其他的跟着一起 ──
// 媒体事件不冒泡，所以在渲染图层上用捕获监听。程序触发的 play / pause / seeked 会再产生一次事件，用 syncExpect 记下“这次是我们自己触发的”并忽略，避免来回触发。
// 各个音视频的长度不一定一样，规则是按秒对齐：
//   · 同步到某个时间点，比它短的就停在自己的结尾，不会倒回去重播；
//   · 长的继续播，短的播完后保持停着；长的把进度拖回短的范围内，短的立刻跟上并继续播；
//   · 都停下后再点播放，所有人一起从当前位置重新开始（播完的从头开始）。
const syncExpect = new WeakMap<HTMLMediaElement, Record<string, number>>();
function expectEvent(el: HTMLMediaElement, type: string) {
  const o = syncExpect.get(el) || {};
  o[type] = (o[type] || 0) + 1;
  syncExpect.set(el, o);
  // 有的操作不会产生事件（比如播放被浏览器拦下），过一会儿还没消耗掉就清掉，免得误吞掉用户后面的真实操作
  setTimeout(() => { if (o[type] > 0) o[type]--; }, 2000);
}
function consumeExpected(el: HTMLMediaElement, type: string): boolean {
  const o = syncExpect.get(el);
  if (!o || !(o[type] > 0)) return false;
  o[type]--;
  return true;
}

function syncGroupOf(viewerId: string): Group | null {
  for (const g of groups(root)) { // 外层在前：嵌套时按最外层开了同步的组算
    if (g.sync && (g.id === viewerId || leaves(g.child).some(l => l.id === viewerId))) return g;
  }
  return null;
}

// 让 other 跟上 m：位置按秒对齐（不超过 other 自己的长度），m 在播且 other 还没到结尾就播，否则停
function alignTo(m: HTMLMediaElement, other: HTMLMediaElement) {
  const d = isFinite(other.duration) ? other.duration : Infinity;
  const t = Math.min(m.currentTime, d);
  if (Math.abs(other.currentTime - t) > 0.1) {
    expectEvent(other, 'seeked');
    other.currentTime = t;
  }
  const shouldPlay = !m.paused && !m.ended && m.currentTime < d - 0.05;
  if (shouldPlay && other.paused) {
    expectEvent(other, 'play');
    other.play().catch(() => { const o = syncExpect.get(other); if (o && o.play > 0) o.play--; }); // 被浏览器拦下就不会有事件
  } else if (!shouldPlay && !other.paused) {
    expectEvent(other, 'pause');
    other.pause();
  }
}

function onMediaSync(e: Event) {
  const m = e.target as HTMLMediaElement;
  if (!(m instanceof HTMLMediaElement)) return;
  if (consumeExpected(m, e.type)) return;
  if (e.type === 'pause' && m.ended) return; // 播完自动触发的暂停不算，别把还没播完的拉停
  const wrap = m.closest('.viewer-item') as HTMLElement | null;
  const g = wrap?.dataset.leaf ? syncGroupOf(wrap.dataset.leaf) : null;
  if (!g) return;
  const ids = new Set([g.id, ...leaves(g.child).map(l => l.id)]);
  viewerLayer.querySelectorAll<HTMLElement>('.viewer-item').forEach(viewer => {
    if (!ids.has(viewer.dataset.leaf || '')) return;
    viewer.querySelectorAll<HTMLMediaElement>('video, audio').forEach(other => { if (other !== m) alignTo(m, other); });
  });
}
viewerLayer.addEventListener('play', onMediaSync, true);
viewerLayer.addEventListener('pause', onMediaSync, true);
viewerLayer.addEventListener('seeked', onMediaSync, true);

function removeViewer(id: string) {
  viewerEls.get(id)?.remove();
  viewerEls.delete(id);
}

function newId() { return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// 清理空 split、只剩一个子节点的 split，并把同方向的嵌套 split 拍平
function normalize(node: LayoutNode | null): LayoutNode | null {
  if (!node || node.kind === 'leaf') return node;
  if (node.kind === 'group') {
    const c = normalize(node.child);
    if (!c || leaves(c).length === 0) return null;
    // 组里只剩一个字段块也保留组合（单个字段块也可以成组，要散开点“取消组合”）；组里一个都不剩才整组消失（上面已处理）
    node.child = c;
    node.shared = !!node.shared;
    node.sync = !!node.sync;
    return node;
  }
  const kids: LayoutNode[] = [];
  for (const child of node.children) {
    const c = normalize(child);
    if (!c) continue;
    if (c.kind === 'split' && c.dir === node.dir) {
      const total = c.children.reduce((s, x) => s + x.size, 0) || 1;
      c.children.forEach(x => { x.size = c.size * x.size / total; kids.push(x); });
    } else {
      kids.push(c);
    }
  }
  if (kids.length === 0) return null;
  if (kids.length === 1) { kids[0].size = node.size; return kids[0]; }
  node.children = kids;
  return node;
}

function leaves(node: LayoutNode | null): Leaf[] {
  if (!node) return [];
  if (node.kind === 'leaf') return [node];
  return node.kind === 'group' ? leaves(node.child) : node.children.flatMap(leaves);
}

// 所有组合块（外层在前、内层在后）
function groups(node: LayoutNode | null): Group[] {
  if (!node || node.kind === 'leaf') return [];
  if (node.kind === 'group') return [node, ...groups(node.child)];
  return node.children.flatMap(groups);
}

function findParent(node: LayoutNode | null, target: LayoutNode): Split | Group | null {
  if (!node || node.kind === 'leaf') return null;
  if (node.kind === 'group') return node.child === target ? node : findParent(node.child, target);
  for (const c of node.children) {
    if (c === target) return node;
    const p = findParent(c, target);
    if (p) return p;
  }
  return null;
}

// 把节点从树里摘下来（不整理树；调用方在重新插入之后再 normalize，这样目标节点不会因为整理而消失）
function detach(node: LayoutNode) {
  const parent = findParent(root, node);
  if (parent && parent.kind === 'split') parent.children = parent.children.filter(c => c !== node);
  else if (parent) parent.child = { kind: 'split', dir: 'row', size: 1, children: [] }; // 组合块里摘空了：留个空壳，normalize 时整组消失
  else if (root === node) root = null;
}

function removeLeaf(leaf: Leaf) {
  detach(leaf);
  root = normalize(root);
}

// 在 target（单个字段块或组合块）的某个方向上插入新字段块 / 一整组字段块
function insertBeside(target: Leaf | Group, added: LayoutNode, zone: Zone) {
  const dir = zone === 'left' || zone === 'right' ? 'row' : 'column';
  const before = zone === 'left' || zone === 'top';
  const parent = findParent(root, target);
  if (parent && parent.kind === 'split' && parent.dir === dir) {
    const i = parent.children.indexOf(target);
    target.size = target.size / 2;
    added.size = target.size;
    parent.children.splice(before ? i : i + 1, 0, added);
    return;
  }
  const split: Split = { kind: 'split', dir, size: target.size, children: before ? [added, target] : [target, added] };
  target.size = 1;
  added.size = 1;
  if (parent && parent.kind === 'split') parent.children[parent.children.indexOf(target)] = split;
  else if (parent) parent.child = split;
  else root = split;
}

// ── 字段值 → 展示内容 ─────────────────────────────
// 字段块的字段在当前视图里找不到（跨表导入的布局、或字段后来被移出视图）：保留字段块位置，等用户拖字段进来替换
function isPending(leaf: Leaf): boolean {
  return !isHeaderLeaf(leaf) && !!snapshot && !snapshot.fields.some(f => f.id === leaf.fieldId);
}

function valueToText(value: any): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) {
    return value.map(v => (v && typeof v === 'object') ? (v.name || v.text || v.fullAddress || '') : String(v)).filter(Boolean)
      .join(value.every((v: any) => v && v.type === 'text') ? '' : '、');
  }
  if (typeof value === 'object') return value.name || value.text || value.fullAddress || value.address || '';
  return String(value);
}

function blockContent(field: FieldMeta | undefined, record: RecordData | null): { url?: string; text: string } {
  if (!field || !record) return { text: '' };
  const value = record.fields[field.id];
  if (value === undefined || value === null) return { text: '' };
  let url = '';
  if (field.type === FType.URL) url = extractUrlFromValue(value);
  else if (field.type === FType.TEXT || field.type === FType.FORMULA) url = findUrlInSegments(value) || cleanUrl(segmentsToText(value));
  if (isUrl(url)) return { url, text: url };
  return { text: field.type === FType.TEXT || field.type === FType.FORMULA ? segmentsToText(value) : valueToText(value) };
}

function renderViewer(url: string): string {
  const type = detectUrlType(url);
  const src = esc(proxyUrl(url));
  const link = `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`;
  switch (type) {
    case 'video': return `<video controls src="${src}" class="block-media"></video>`;
    case 'audio': return `<audio controls src="${src}" class="block-audio"></audio>`;
    case 'image': return `<img src="${esc(resolveImageUrl(proxyUrl(url)))}" alt="" class="block-media" />`;
    default:
      if (isFramebuster(url)) return `<div class="block-text">该站点禁止嵌入，请在新窗口打开：<br>${link}</div>`;
      return `<iframe src="${src}" class="block-frame" sandbox="allow-scripts allow-same-origin allow-popups allow-forms"></iframe>`;
  }
}

function updateBlock(leaf: Leaf) {
  const el = blockEls.get(leaf.id);
  if (!el) return;
  if (isHeaderLeaf(leaf)) { // 标题行块：只有标题行
    (el.querySelector('.block-body') as HTMLElement).hidden = true;
    el.classList.add('compact');
    removeViewer(leaf.id);
    return;
  }
  const field = snapshot?.fields.find(f => f.id === leaf.fieldId);
  const pending = !field && isPending(leaf);
  el.classList.toggle('pending', pending);
  (el.querySelector('.block-title') as HTMLElement).textContent = field ? field.name : (leaf.fieldName || '（字段不在当前视图）');

  const content = blockContent(field, snapshot?.record || null);
  const { url } = content;
  // 飞书文本每段末尾自带换行，先去掉首尾空白，否则所有文本都会被当成多行
  const text = content.text.trim();
  const open = el.querySelector('.block-open') as HTMLAnchorElement;
  open.hidden = !url;
  if (url) open.href = url;

  // 标题栏：字段名 | 字段值（左右结构，悬停看全文）。都只读，可选中复制。
  //   值里有换行 → 多行输入框，保留换行；
  //   值是被渲染的链接 → 单行输入框（过长用省略号，内容在下面的渲染区）；
  //   其他值（只在标题栏里显示）→ 单行装得下就是单行输入框，装不下换成自动换行的多行输入框，免得看不全（见 fitValueBox）。
  // 多行框与侧边栏同一套规则：长行自动换行（不出横向滚动条）、高度随内容撑开、Ctrl+A 分两步；上限更紧（BLOCK_VALUE_MAX_RATIO）
  el.dataset.valueText = text;
  el.dataset.valueUrl = url ? '1' : '';
  refitBlockValue(el);

  // 内容区：只有 URL 渲染成网页/媒体；其他字段的值只显示在标题栏（输入框里，可选中复制），块只占标题栏高度（值有换行时标题栏会随多行输入框变高）
  const body = el.querySelector('.block-body') as HTMLElement;
  const inShare = shareOfLeaf.has(leaf.id); // 组内成员只留标题栏，渲染区由组统一管理
  body.hidden = inShare || (!!field && !url);
  el.classList.toggle('compact', body.hidden); // 没有可渲染内容：高度收缩到只剩标题栏
  // 渲染内容放在固定图层里（见 ensureViewer）；内容区本身只是个占位，字段不存在时才显示提示
  if (!inShare && field && url) ensureViewer(leaf.id, url);
  else removeViewer(leaf.id);
  const bodyKey = field ? '' : 'x';
  if (body.dataset.key !== bodyKey) {
    body.dataset.key = bodyKey;
    body.innerHTML = field ? '' : '<div class="block-hint">该字段不在当前视图中<br>把侧边栏里的字段拖到这里可替换</div>';
  }
}

// ── 任一渲染：组里按顺序找第一个“能加载”的字段，把它的内容放到组底部共用的渲染区 ──
// 图片 / 视频 / 音频：加载失败（直连和服务端中转都不行）就跳过；网页：先问服务端能否嵌入，禁止的就跳过。
// 前面的网页还在检查时先等结果，不抢跑到后面的字段。失败记录按“记录 + 地址”存在内存里，换记录或刷新就重新判断
const shareFailed = new Set<string>();
const shareEmbed = new Map<string, 'pending' | 'ok'>();
const isMediaUrl = (url: string) => ['video', 'audio', 'image'].includes(detectUrlType(url));

function resetShareState() {
  shareFailed.clear();
  shareEmbed.clear();
  clearEmbeddableCache();
}

function updateShare(group: Group) {
  const el = nodeEls.get(group);
  const bodyEl = shareBodyEls.get(group.id);
  if (!el || !bodyEl) return;
  const recordId = snapshot?.record?.recordId || '';
  let active: { leaf: Leaf; url: string } | null = null;
  let waiting = false;
  for (const leaf of leaves(group.child)) {
    if (shareOfLeaf.get(leaf.id) !== group) continue; // 里层另有共享组合块的，归里层管
    const field = snapshot?.fields.find(f => f.id === leaf.fieldId);
    const { url } = blockContent(field, snapshot?.record || null);
    if (!url) continue;
    const key = recordId + '|' + url;
    if (shareFailed.has(key)) continue;
    if (!isMediaUrl(url)) {
      if (isFramebuster(url)) continue;
      const st = shareEmbed.get(key);
      if (!st) {
        shareEmbed.set(key, 'pending');
        checkEmbeddable(url).then(({ ok }) => {
          if (ok) shareEmbed.set(key, 'ok'); else { shareEmbed.delete(key); shareFailed.add(key); }
          updateBlocks();
        });
        waiting = true;
        break;
      }
      if (st === 'pending') { waiting = true; break; }
    }
    active = { leaf, url };
    break;
  }
  blockEls.forEach((b, id) => { if (shareOfLeaf.get(id) === group) b.classList.toggle('source-active', active?.leaf.id === id); });
  bodyEl.hidden = !active && !waiting;
  el.classList.toggle('compact', bodyEl.hidden); // 组里没有能加载的内容：只剩各字段的标题栏
  if (active) ensureViewer(group.id, active.url);
  else removeViewer(group.id);
}

// 任一渲染的图片 / 视频 / 音频最终加载失败：直连失败会先由 installProxyFallback 改走代理重试（它会拦下这次事件），
// 走代理也失败才会冒泡到这里
viewerLayer.addEventListener('error', (e) => {
  const t = e.target as HTMLElement;
  if (!['IMG', 'VIDEO', 'AUDIO'].includes(t.tagName)) return;
  const wrap = t.closest('.viewer-item') as HTMLElement | null;
  if (!wrap || !wrap.dataset.leaf || !shareBodyEls.has(wrap.dataset.leaf) || !wrap.dataset.url) return;
  shareFailed.add((snapshot?.record?.recordId || '') + '|' + wrap.dataset.url);
  updateBlocks();
}, true);

// 没有可渲染内容的块（以及全由这类块组成的子树）：下方还有别的块时只占自身高度；
// 下方没有东西时不收缩，占满能占的高度
function isCompactNode(node: LayoutNode): boolean {
  if (node.kind === 'leaf') return !!blockEls.get(node.id)?.classList.contains('compact');
  if (node.kind === 'group') return node.shared ? !!nodeEls.get(node)?.classList.contains('compact') : isCompactNode(node.child);
  return node.children.every(isCompactNode);
}

function applyFit(node: LayoutNode) {
  if (node.kind === 'group') { applyFit(node.child); return; }
  if (node.kind === 'leaf') return;
  const flexible: LayoutNode[] = [];
  // 上下排列时，没有可渲染内容的块只占自身高度：下方还有别的块，或同级里有会伸展的块（有渲染内容的）都算。
  // 同级全是这类块时，最后一个占满剩余高度，免得下面空出一片
  const anyFlexible = node.dir === 'column' && node.children.some(c => !isCompactNode(c));
  node.children.forEach((child, i) => {
    const hasBelow = node.dir === 'column' && i < node.children.length - 1;
    const fit = (hasBelow || anyFlexible) && isCompactNode(child);
    nodeEls.get(child)?.toggleAttribute('data-fit', fit);
    if (!fit) flexible.push(child);
    applyFit(child);
  });
  // 会伸展的子节点把权重归一，使 flex-grow 之和恒为 1：
  // 多次切分后权重会越来越小，之和不足 1 时最后一个块就占不满剩余空间
  const total = flexible.reduce((sum, c) => sum + (c.size || 1), 0);
  flexible.forEach(c => {
    const el = nodeEls.get(c);
    if (el) el.style.flex = `${(c.size || 1) / total} 1 0`;
  });
}

function updateBlocks() {
  leaves(root).forEach(updateBlock);
  syncHeaderClone();
  groups(root).filter(g => g.shared).forEach(updateShare);
  if (root) {
    nodeEls.get(root)?.removeAttribute('data-fit');
    applyFit(root);
  }
  positionViewers();
  drawSelection();
}

function createBlockEl(leaf: Leaf): HTMLElement {
  const el = document.createElement('div');
  el.className = 'block';
  el.dataset.blockId = leaf.id;
  if (isHeaderLeaf(leaf)) {
    el.classList.add('block-header-clone');
    el.appendChild(buildHeaderClone());
    el.insertAdjacentHTML('beforeend', '<div class="block-body"></div>');
  } else {
    el.innerHTML = `<div class="block-header">
      <span class="block-title" draggable="true" title="拖动字段名可调整位置"></span>
      <input class="block-value" readonly placeholder="（空）" />
      <textarea class="block-value block-value-multi" rows="2" readonly hidden></textarea>
      <a class="block-open" target="_blank" rel="noopener noreferrer" title="在新窗口打开">↗</a>
      <button class="block-close" title="移除该字段块（字段回到侧边栏）">✕</button>
    </div><div class="block-body"></div>`;
    const area = el.querySelector('textarea.block-value') as HTMLTextAreaElement;
    installLineSelectAll(area);
    trackManualResize(area);
    valueObserver.observe(area);
    valueObserver.observe(el.querySelector('input.block-value') as HTMLInputElement); // 单行框的宽度变化也要重新判断（变窄了装不下，就换成多行框）
  }
  bodyObserver.observe(el.querySelector('.block-body') as HTMLElement);
  (el.querySelector('.block-close') as HTMLElement).addEventListener('click', () => {
    removeLeaf(leaf);
    saveLayout();
    renderBlocks();
  });
  el.addEventListener('dragstart', (e) => {
    if (!(e.target as HTMLElement).classList.contains('block-title') || !e.dataTransfer) return;
    e.dataTransfer.setData(BLOCK_DRAG_TYPE, leaf.id);
    e.dataTransfer.effectAllowed = 'move';
    document.body.classList.add('dragging-field');
  });
  el.addEventListener('dragend', endDrag);
  return el;
}

function buildNode(node: LayoutNode): HTMLElement {
  let el: HTMLElement;
  if (node.kind === 'leaf') {
    let cached = blockEls.get(node.id);
    if (!cached) { cached = createBlockEl(node); blockEls.set(node.id, cached); }
    el = cached;
  } else if (node.kind === 'group') {
    const group = node;
    el = document.createElement('div');
    el.className = 'group' + (group.shared ? ' shared' : '');
    el.dataset.groupId = group.id;
    el.innerHTML = `<div class="group-bar">
        <span class="group-handle" draggable="true" title="拖动这里移动整个组合；把别的字段拖到组合框的边缘，会按整组来切分">⠿ 组合</span>
        <button type="button" class="group-share${group.shared ? ' on' : ''}" title="${group.shared ? '关闭任一渲染：各字段块恢复各自的渲染区' : '开启任一渲染：组内各字段只留标题栏，共用组底部的一个渲染区，哪个字段的链接能加载就显示哪个'}">任一渲染</button>
        <button type="button" class="group-sync${group.sync ? ' on' : ''}" title="${group.sync ? '关闭同步播放' : '开启同步播放：组内的视频 / 音频一起播放、一起暂停（播放或暂停其中任何一个，其他的跟着一起）'}">同步播放</button>
        <button type="button" class="group-ungroup" title="取消组合：各字段块恢复独立">取消组合</button>
      </div>`;
    const inner = document.createElement('div');
    inner.className = 'group-inner';
    inner.appendChild(buildNode(group.child));
    el.appendChild(inner);
    if (group.shared) {
      let body = shareBodyEls.get(group.id);
      if (!body) {
        body = document.createElement('div');
        body.className = 'share-body';
        bodyObserver.observe(body);
        shareBodyEls.set(group.id, body);
      }
      el.appendChild(body);
    }
    (el.querySelector('.group-share') as HTMLElement).addEventListener('click', () => {
      group.shared = !group.shared;
      saveLayout();
      renderBlocks();
    });
    (el.querySelector('.group-sync') as HTMLElement).addEventListener('click', (e) => {
      group.sync = !group.sync;
      (e.currentTarget as HTMLElement).classList.toggle('on', group.sync);
      saveLayout(); // 只切开关，不重绘（重绘会让正在播放的视频重新加载）
    });
    (el.querySelector('.group-ungroup') as HTMLElement).addEventListener('click', () => {
      replaceNode(group, group.child);
      commitLayout();
    });
    (el.querySelector('.group-handle') as HTMLElement).addEventListener('dragstart', (e) => {
      if (!e.dataTransfer) return;
      e.dataTransfer.setData(NODE_DRAG_TYPE, group.id);
      e.dataTransfer.effectAllowed = 'move';
      document.body.classList.add('dragging-field');
    });
  } else {
    el = document.createElement('div');
    el.className = 'split ' + node.dir;
    const childEls: HTMLElement[] = [];
    node.children.forEach((child, i) => {
      if (i > 0) {
        const sp = document.createElement('div');
        sp.className = 'block-splitter';
        sp.addEventListener('mousedown', (e) => startResize(e, node, childEls, i));
        el.appendChild(sp);
      }
      const childEl = buildNode(child);
      childEls.push(childEl);
      el.appendChild(childEl);
    });
  }
  el.style.flex = `${node.size || 1} 1 0`;
  nodeEls.set(node, el);
  return el;
}

// ── 标题行块：侧边栏标题行的副本 ──
// 副本里带 id 的元素记下原 id（data-proxy）再去掉 id；点击 / 回车都转给侧边栏上同 id 的原元素，
// 按钮的可用状态、记录序号、框选高亮每次刷新时从原元素同步过来。☰ 菜单是副本自己的，只有菜单项转给原按钮
const sidebarHeader = document.querySelector('#app > .header') as HTMLElement;
const origEl = (id: string | undefined) => (id ? document.getElementById(id) : null);

function buildHeaderClone(): HTMLElement {
  const h = sidebarHeader.cloneNode(true) as HTMLElement;
  h.querySelectorAll<HTMLElement>('[id]').forEach(n => { n.dataset.proxy = n.id; n.removeAttribute('id'); });
  const title = h.querySelector('h3') as HTMLElement;
  delete title.dataset.proxy;
  title.className = 'block-title'; // 和字段块一样：拖标题名调整位置
  title.title = '拖动标题名可调整位置';
  h.querySelector('.header-actions')!.insertAdjacentHTML('beforeend', '<button type="button" class="refresh-btn block-close" title="移除这个标题行块（侧边栏上的标题行不受影响）">✕</button>');
  const menu = h.querySelector('.menu') as HTMLElement;
  const menuBtn = h.querySelector('[data-proxy="menuBtn"]') as HTMLElement;
  // 展开方向按实际空间定：下方放不下、上方更宽裕就往上展开；左边放不下就改成左对齐往右展开。展开 / 二级菜单展开后高度变了，都要重新判断
  const placeMenu = () => {
    menu.classList.remove('up', 'left');
    if (menu.hidden) return;
    const wrap = menu.parentElement!.getBoundingClientRect();
    const r = menu.getBoundingClientRect();
    const below = window.innerHeight - wrap.bottom, above = wrap.top;
    if (r.height + 6 > below && above > below) menu.classList.add('up');
    if (r.left < 0) menu.classList.add('left');
  };
  menuBtn.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; placeMenu(); });
  document.addEventListener('click', (e) => { if (!menu.contains(e.target as Node)) menu.hidden = true; });
  h.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const group = t.closest('[data-submenu]') as HTMLElement | null;
    if (group) { // 二级菜单展开 / 收起，不收起整个菜单
      e.stopPropagation();
      const sub = group.nextElementSibling as HTMLElement;
      sub.hidden = !sub.hidden;
      group.classList.toggle('open', !sub.hidden);
      placeMenu();
      return;
    }
    const proxy = (t.closest('[data-proxy]') as HTMLElement | null)?.dataset.proxy;
    if (!proxy || proxy === 'menuBtn' || proxy === 'recordJump') return;
    if (proxy === 'helpLink') { menu.hidden = true; return; } // 链接自己会打开
    if (menu.contains(t)) menu.hidden = true;
    origEl(proxy)?.click();
  });
  h.addEventListener('keydown', (e) => {
    const t = e.target as HTMLInputElement;
    if (e.key !== 'Enter' || t.dataset.proxy !== 'recordJump') return;
    const src = origEl('recordJump') as HTMLInputElement;
    src.value = t.value;
    src.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    t.value = src.value; // 输入无效时原输入框会恢复成当前序号
  });
  return h;
}

function syncHeaderClone() {
  const leaf = leaves(root).find(isHeaderLeaf);
  const h = leaf && blockEls.get(leaf.id)?.querySelector('.header');
  if (!h) return;
  h.querySelectorAll<HTMLElement>('[data-proxy]').forEach(el => {
    const src = origEl(el.dataset.proxy);
    if (!src) return;
    if (el instanceof HTMLInputElement) {
      el.disabled = (src as HTMLInputElement).disabled;
      el.max = (src as HTMLInputElement).max;
      if (document.activeElement !== el) el.value = (src as HTMLInputElement).value;
    } else if (el instanceof HTMLButtonElement) {
      el.disabled = (src as HTMLButtonElement).disabled;
      el.classList.toggle('active', src.classList.contains('active'));
    } else if (el instanceof HTMLAnchorElement) {
      el.href = (src as HTMLAnchorElement).href;
    } else if (el.classList.contains('index-display')) {
      el.textContent = src.textContent;
    }
  });
}

function renderBlocks() {
  blocksEl.innerHTML = '';
  nodeEls.clear();
  const all = leaves(root);
  for (const id of [...blockEls.keys()]) {
    if (all.some(l => l.id === id)) continue;
    const body = blockEls.get(id)?.querySelector('.block-body');
    if (body) bodyObserver.unobserve(body);
    blockEls.delete(id);
    removeViewer(id);
  }
  const sharedIds = new Set(groups(root).filter(g => g.shared).map(g => g.id));
  for (const id of [...shareBodyEls.keys()]) {
    if (sharedIds.has(id)) continue;
    bodyObserver.unobserve(shareBodyEls.get(id)!);
    shareBodyEls.delete(id);
    removeViewer(id);
  }
  shareOfLeaf.clear();
  const markOwner = (n: LayoutNode, owner: Group | null) => {
    if (n.kind === 'leaf') { if (owner) shareOfLeaf.set(n.id, owner); }
    else if (n.kind === 'group') markOwner(n.child, n.shared ? n : owner);
    else n.children.forEach(c => markOwner(c, owner));
  };
  if (root) markOwner(root, null);
  if (!root) {
    blocksEl.innerHTML = '<div class="blocks-empty"><div class="blocks-empty-title">← 把侧边栏里的字段名拖到这里</div><div class="blocks-empty-sub">可拖入多个字段，拖到已有字段块的边缘即可上下左右分屏</div><div class="blocks-empty-sub"><a href="' + HELP_URL + '" target="_blank" rel="noopener noreferrer">不知道怎么用？查看使用教程</a></div></div>';
  } else {
    blocksEl.appendChild(buildNode(root));
  }
  // 已在预览窗格展示的字段，侧边栏不再显示；移除字段块后自动回到侧边栏
  ui.setHiddenFields(new Set(all.map(l => l.fieldId)));
  sel = null; // 布局变了，原来的选区作废
  updateBlocks();
}

// ── 布局导入 / 导出：把当前数据表的预览窗格字段块布局存成文件，方便分享给别人 ──
// 布局记在浏览器 localStorage 里，换电脑、换浏览器、发给同事都带不走，所以提供文件导出。
// 文件里每个字段块除了字段 ID，还带上字段名：对方是另一张表（字段 ID 不同）时，按字段名重新匹配。
const LAYOUT_FILE_TYPE = 'data-engine-layout';
const LEGACY_LAYOUT_FILE_TYPE = 'bitable-editor-layout'; // 插件改名（bitable-editor → data-engine）前导出的文件，仍可导入
const layoutMsgEl = document.getElementById('layoutMsg') as HTMLElement;
let layoutMsgTimer: number | undefined;

function layoutNotice(text: string, isError = false) {
  layoutMsgEl.textContent = text;
  layoutMsgEl.classList.toggle('error', isError);
  window.clearTimeout(layoutMsgTimer);
  layoutMsgTimer = window.setTimeout(() => { layoutMsgEl.textContent = ''; }, 8000);
}

function exportLayout() {
  if (!root) { layoutNotice('当前没有布局可导出：先把字段拖到预览窗格', true); return; }
  const names = new Map((snapshot?.fields || []).map(f => [f.id, f.name]));
  const withNames = (n: LayoutNode): any => n.kind === 'leaf'
    ? { kind: 'leaf', fieldId: n.fieldId, fieldName: names.get(n.fieldId) || n.fieldName || '', size: n.size }
    : n.kind === 'group'
      ? { kind: 'group', size: n.size, shared: n.shared, sync: n.sync, child: withNames(n.child) }
      : { kind: 'split', dir: n.dir, size: n.size, children: n.children.map(withNames) };
  const text = JSON.stringify({ type: LAYOUT_FILE_TYPE, version: 1, layout: withNames(root) }, null, 2);
  const pad = (x: number) => String(x).padStart(2, '0');
  const d = new Date();
  const name = `双栏布局_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.json`;
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  layoutNotice('已导出布局');
}

// 导入的布局里每个字段块的字段对应到当前数据表：ID 和名字都对得上就用 ID；否则按字段名找（名字唯一才算）；
// 找不到的字段块保留位置（记下原字段名，等用户拖字段进来替换）。字段块 ID 全部重新生成，避免和现有的冲突
function mapImportedLayout(raw: any, fields: FieldMeta[], missing: string[], depth = 0): LayoutNode | null {
  if (!raw || depth > 12 || typeof raw !== 'object') return null;
  const sizeOf = (r: any) => typeof r.size === 'number' && r.size > 0 ? r.size : 1;
  const mapLeaf = (r: any): Leaf => {
    if (r.fieldId === HEADER_ID) return { kind: 'leaf', id: newId(), fieldId: HEADER_ID, size: sizeOf(r) };
    const name = typeof r.fieldName === 'string' ? r.fieldName : '';
    const id = String(r.fieldId ?? '');
    const byId = fields.find(f => f.id === id);
    let hit = byId && (!name || byId.name === name) ? byId : undefined;
    if (!hit && name) {
      const same = fields.filter(f => f.name === name);
      if (same.length === 1) hit = same[0];
    }
    if (!hit) {
      missing.push(name || id);
      return { kind: 'leaf', id: newId(), fieldId: id || `missing:${newId()}`, size: sizeOf(r), fieldName: name || undefined };
    }
    return { kind: 'leaf', id: newId(), fieldId: hit.id, size: sizeOf(r) };
  };
  if (raw.kind === 'leaf') return mapLeaf(raw);
  if (raw.kind === 'group') {
    const child = mapImportedLayout(raw.child, fields, missing, depth + 1);
    return child ? { kind: 'group', id: newId(), child, shared: !!raw.shared, sync: !!raw.sync, size: sizeOf(raw) } : null;
  }
  if (raw.kind === 'split' && (raw.dir === 'row' || raw.dir === 'column') && Array.isArray(raw.children)) {
    const children = raw.children.map((c: any) => mapImportedLayout(c, fields, missing, depth + 1)).filter((c: LayoutNode | null): c is LayoutNode => !!c);
    return children.length ? { kind: 'split', dir: raw.dir, size: sizeOf(raw), children } : null;
  }
  throw new Error('布局文件里有无法识别的内容');
}

function importLayout() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      let data: any;
      try { data = JSON.parse(await file.text()); } catch { throw new Error('文件不是合法的 JSON'); }
      if (!data || (data.type !== LAYOUT_FILE_TYPE && data.type !== LEGACY_LAYOUT_FILE_TYPE)) throw new Error('这不是本插件导出的布局文件');
      if (!snapshot) throw new Error('还没有连上侧边栏，无法对应字段，请稍后再试');
      const missing: string[] = [];
      const mapped = normalize(mapImportedLayout(data.layout, snapshot.fields, missing));
      if (!mapped) throw new Error('布局文件是空的，未导入');
      if (root && !confirm('导入会替换当前表格的预览窗格布局，确定吗？')) return;
      root = mapped;
      saveLayout();
      renderBlocks();
      const uniq = [...new Set(missing)];
      layoutNotice(uniq.length ? `已导入布局，有 ${missing.length} 个字段块的字段在当前视图里找不到：${uniq.join('、')}。把侧边栏里的字段拖到这些字段块上即可替换` : '已导入布局', uniq.length > 0);
    } catch (e) {
      layoutNotice(`导入失败：${e instanceof Error ? e.message : String(e)}`, true);
    }
  });
  input.click();
}

// 顶部栏的 ☰ 菜单（逻辑在 shared/menu.ts）；选了菜单项后收起
const { close: closeMenu } = setupMenu();
document.getElementById('layoutExportBtn')!.addEventListener('click', () => { closeMenu(); exportLayout(); });
document.getElementById('layoutImportBtn')!.addEventListener('click', () => { closeMenu(); importLayout(); });

// ── 字段块分隔线拖动：只改相邻两块，其余保持 ─────────────
function startResize(e: MouseEvent, split: Split, childEls: HTMLElement[], i: number) {
  e.preventDefault();
  const horizontal = split.dir === 'row';
  // 相邻块里有收缩成标题栏高度的，上下方向没有可调的空间
  if (!horizontal && (childEls[i - 1].hasAttribute('data-fit') || childEls[i].hasAttribute('data-fit'))) return;
  // 先把同级所有子节点的权重换算成当前像素。
  // 必须先读完所有尺寸再统一写入：边读边写的话，前面的块一改 flex 布局就重算，后面读到的已经是被扭曲的尺寸，
  // 会导致仅仅按下鼠标就出现跳变
  const rects = childEls.map(el => el.getBoundingClientRect());
  split.children.forEach((c, k) => { c.size = Math.max(1, horizontal ? rects[k].width : rects[k].height); });
  split.children.forEach((c, k) => { childEls[k].style.flex = `${c.size} 1 0`; });
  const a = split.children[i - 1], b = split.children[i];
  const start = horizontal ? e.clientX : e.clientY;
  const sizeA = a.size, sum = a.size + b.size;
  // 最小尺寸 80px；但本来就比 80px 小的块不强行撑大，否则拖动的第一下会跳变
  const minA = Math.min(80, sizeA), minB = Math.min(80, sum - sizeA);
  document.body.classList.add('dragging-field');
  const move = (ev: MouseEvent) => {
    const delta = (horizontal ? ev.clientX : ev.clientY) - start;
    a.size = Math.min(sum - minB, Math.max(minA, sizeA + delta));
    b.size = sum - a.size;
    childEls[i - 1].style.flex = `${a.size} 1 0`;
    childEls[i].style.flex = `${b.size} 1 0`;
  };
  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    document.body.classList.remove('dragging-field');
    saveLayout();
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}

// ── 拖入字段 / 拖动字段块：落在字段块哪条边附近，就从哪个方向切分 ──
const ZONES: Zone[] = ['left', 'right', 'top', 'bottom'];

function clearDropMarks() {
  blocksEl.querySelectorAll('.block, .group').forEach(el => { el.classList.remove('drop-replace'); ZONES.forEach(z => el.classList.remove('drop-' + z)); });
  blocksEl.querySelector('.drop-hint')?.remove();
}

// 落在空白区时，高亮将被填充的那块空白
function showDropHint(rect: { left: number; top: number; right: number; bottom: number }) {
  const host = blocksEl.getBoundingClientRect();
  const hint = document.createElement('div');
  hint.className = 'drop-hint';
  hint.style.left = rect.left - host.left + 'px';
  hint.style.top = rect.top - host.top + 'px';
  hint.style.width = Math.max(0, rect.right - rect.left) + 'px';
  hint.style.height = Math.max(0, rect.bottom - rect.top) + 'px';
  blocksEl.appendChild(hint);
}

function endDrag() {
  document.body.classList.remove('dragging-field');
  clearDropMarks();
  blocksEl.classList.remove('drop-active');
}

interface Rect { left: number; top: number; right: number; bottom: number }
// node：落点所在的单元（单个字段块或组合块）
interface DropTarget { node: Leaf | Group; el: HTMLElement; zone: Zone; blank?: Rect }

// 字段拖到字段已不存在的字段块上：替换字段，不切分
function replaceTarget(t: DropTarget): Leaf | undefined {
  if (t.blank) return undefined;
  return t.node.kind === 'leaf' && isPending(t.node) ? t.node : undefined;
}

// 最外层的单元：单个字段块和组合块（不往组合块里面找）。框选、空白处落点都以它们为单位
function unitEls(): { node: Leaf | Group; el: HTMLElement }[] {
  const out: { node: Leaf | Group; el: HTMLElement }[] = [];
  const walk = (n: LayoutNode) => {
    if (n.kind === 'split') { n.children.forEach(walk); return; }
    const el = nodeEls.get(n);
    if (el) out.push({ node: n, el });
  };
  if (root) walk(root);
  return out;
}

function zoneOf(el: HTMLElement, e: DragEvent): Zone {
  const r = el.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
  const dist: Record<Zone, number> = { left: x, right: 1 - x, top: y, bottom: 1 - y };
  return ZONES.reduce((best, z) => dist[z] < dist[best] ? z : best, 'left' as Zone);
}

const GROUP_EDGE = 12; // 离组合框边缘多近（或在组合框顶部的操作条上）算“落在组合框上”：按整组切分；再往里就是组内的块

function groupEdgeHit(e: DragEvent): Group | null {
  for (const g of groups(root)) { // 外层在前：同时落在外层和内层组合框边缘时，按外层整组算
    const el = nodeEls.get(g);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) continue;
    const bar = el.querySelector(':scope > .group-bar') as HTMLElement | null;
    const edge = Math.min(e.clientX - r.left, r.right - e.clientX, e.clientY - r.top, r.bottom - e.clientY);
    if (edge <= GROUP_EDGE || (bar && e.clientY <= bar.getBoundingClientRect().bottom)) return g;
  }
  return null;
}

function dropTarget(e: DragEvent): DropTarget | null {
  const g = groupEdgeHit(e);
  if (g) {
    const el = nodeEls.get(g)!;
    return { node: g, el, zone: zoneOf(el, e) };
  }
  const blockEl = (e.target as HTMLElement).closest('.block') as HTMLElement | null;
  const leaf = blockEl && leaves(root).find(l => l.id === blockEl.dataset.blockId);
  if (blockEl && leaf) return { node: leaf, el: blockEl, zone: zoneOf(blockEl, e) };

  // 落在空白处（比如收缩成标题栏的字段块下方）：找最近的单元，沿空白所在的方向填充
  let best: { node: Leaf | Group; el: HTMLElement; r: DOMRect; dx: number; dy: number } | null = null;
  for (const u of unitEls()) {
    const r = u.el.getBoundingClientRect();
    const dx = e.clientX < r.left ? r.left - e.clientX : e.clientX > r.right ? e.clientX - r.right : 0;
    const dy = e.clientY < r.top ? r.top - e.clientY : e.clientY > r.bottom ? e.clientY - r.bottom : 0;
    // 空白区优先归属“鼠标正上方/下方”的字段块（同一列，dx 为 0），其次是“左右侧同一行”的（dy 为 0），
    // 都没有才取最近的。例如左边是高高的网页块、右边是只有标题栏的块时，右块下方的空白归右块
    const rank = dx === 0 ? 0 : dy === 0 ? 1 : 2;
    const bestRank = best ? (best.dx === 0 ? 0 : best.dy === 0 ? 1 : 2) : 3;
    const better = rank < bestRank || (rank === bestRank && best !== null && Math.hypot(dx, dy) < Math.hypot(best.dx, best.dy));
    if (better) best = { ...u, r, dx, dy };
  }
  if (!best) return null;
  const { r, dx, dy } = best;
  const zone: Zone = dy >= dx ? (e.clientY > r.bottom ? 'bottom' : 'top') : (e.clientX > r.right ? 'right' : 'left');
  const p = (best.el.parentElement as HTMLElement).getBoundingClientRect();
  const blank = zone === 'bottom' ? { left: r.left, right: r.right, top: r.bottom, bottom: p.bottom }
    : zone === 'top' ? { left: r.left, right: r.right, top: p.top, bottom: r.top }
    : zone === 'right' ? { left: r.right, right: p.right, top: r.top, bottom: r.bottom }
    : { left: p.left, right: r.left, top: r.top, bottom: r.bottom };
  return { node: best.node, el: best.el, zone, blank };
}

const nodeContains = (a: LayoutNode, b: LayoutNode): boolean =>
  a === b || (a.kind === 'split' && a.children.some(c => nodeContains(c, b))) || (a.kind === 'group' && nodeContains(a.child, b));

function replaceNode(target: LayoutNode, withNode: LayoutNode) {
  const parent = findParent(root, target);
  withNode.size = target.size;
  if (parent && parent.kind === 'split') parent.children[parent.children.indexOf(target)] = withNode;
  else if (parent) parent.child = withNode;
  else root = withNode;
}

function commitLayout() {
  root = normalize(root);
  saveLayout();
  renderBlocks();
}

// 把 node 整体移到 t 旁边（单个字段块、组合块、框选的组合都走这里）：先摘下来，插到落点旁边，最后再整理树
function moveNode(node: LayoutNode, t: DropTarget | null) {
  if (!t || nodeContains(node, t.node) || (t.node.kind === 'group' && nodeContains(t.node, node) && leaves(t.node).length <= leaves(node).length)) return;
  detach(node);
  node.size = 1;
  insertBeside(t.node, node, t.zone);
  commitLayout();
}

// ── 框选：在预览窗格空白处按住拖出矩形，选中碰到的字段块 / 组合块；选区自动补成矩形，直接圈成组合块 ──
// 布局是树：碰到的单元先找到它们共同的最近上级切分，再把这个切分里“第一个到最后一个被碰到的子节点”之间的全部子节点选中
// （连续的兄弟节点拼起来一定是矩形）；子节点全选就等于选中整个切分。组合块整个算一个单元
interface Selection { nodes: LayoutNode[]; parent: Split | null }
let sel: Selection | null = null;

const selLayer = document.createElement('div'); // 盖在渲染内容图层上面，放选框和框选时的矩形
selLayer.className = 'sel-layer';
viewerLayer.parentElement!.appendChild(selLayer);

function pathTo(node: LayoutNode | null, target: LayoutNode): LayoutNode[] | null {
  if (!node) return null;
  if (node === target) return [node];
  if (node.kind !== 'split') return null;
  for (const c of node.children) {
    const p = pathTo(c, target);
    if (p) return [node, ...p];
  }
  return null;
}

function selectionFor(units: LayoutNode[]): Selection | null {
  const paths = units.map(u => pathTo(root, u)).filter((p): p is LayoutNode[] => !!p);
  if (!paths.length) return null;
  let depth = 0;
  while (paths.every(p => p[depth + 1] && p[depth + 1] === paths[0][depth + 1])) depth++;
  const lca = paths[0][depth];
  const parentOf = (n: LayoutNode) => findParent(root, n) as Split | null; // 单元不在组合块里面，上级一定是切分或没有
  if (lca.kind !== 'split') return { nodes: [lca], parent: parentOf(lca) };
  const idx = paths.map(p => lca.children.indexOf(p[depth + 1]));
  const nodes = lca.children.slice(Math.min(...idx), Math.max(...idx) + 1);
  if (nodes.length === lca.children.length) return { nodes: [lca], parent: parentOf(lca) };
  return { nodes, parent: lca };
}

// 选区里至少有一个字段块、且还不是单独一个组合块，才能圈成（新的）组合块（单个字段块也可以成组）
function groupable(): boolean {
  if (!sel) return false;
  if (sel.nodes.length === 1 && sel.nodes[0].kind === 'group') return false;
  return sel.nodes.reduce((n, x) => n + leaves(x).length, 0) >= 1;
}

function makeGroup() {
  if (!sel || !groupable()) return;
  const { nodes, parent } = sel;
  const child: LayoutNode = nodes.length === 1 ? nodes[0] : { kind: 'split', dir: parent!.dir, size: 1, children: nodes };
  const group: Group = { kind: 'group', id: newId(), child, shared: false, sync: false, size: nodes.reduce((sum, n) => sum + (n.size || 1), 0) };
  if (nodes.length === 1) replaceNode(nodes[0], group);
  else parent!.children.splice(parent!.children.indexOf(nodes[0]), nodes.length, group);
  commitLayout();
}

function clearSelection() {
  sel = null;
  drawSelection();
}

function drawSelection() {
  selLayer.querySelector('.sel-box')?.remove();
  if (!sel) return;
  const rects = sel.nodes.map(n => nodeEls.get(n)?.getBoundingClientRect()).filter((r): r is DOMRect => !!r);
  if (!rects.length) { sel = null; return; }
  const host = selLayer.getBoundingClientRect();
  const left = Math.min(...rects.map(r => r.left)), top = Math.min(...rects.map(r => r.top));
  const right = Math.max(...rects.map(r => r.right)), bottom = Math.max(...rects.map(r => r.bottom));
  const box = document.createElement('div');
  box.className = 'sel-box';
  box.style.left = left - host.left + 'px';
  box.style.top = top - host.top + 'px';
  box.style.width = right - left + 'px';
  box.style.height = bottom - top + 'px';
  // 只画虚线选框，没有操作条：框出一个或多个字段块都会直接圈成组合块；只框到已有的单个组合块时，
  // 它们自己的标题（字段名 / 组合框顶部的「⠿ 组合」）就是移动把手，再加一条操作条只会盖住标题。取消选择：Esc、点别处、或再进入框选
  selLayer.appendChild(box);
}

// 点任意位置取消选择（框选模式下由框选自己处理）
document.addEventListener('pointerdown', () => {
  if (sel && !document.body.classList.contains('marquee-mode')) clearSelection();
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setMarqueeMode(false); clearSelection(); } });
new ResizeObserver(() => drawSelection()).observe(blocksEl);

// 框选模式：点侧边栏标题栏的 ⬚ 进入，此时选区图层盖住整个预览窗格（连网页 / 视频上面也能起手），
// 按住拖出矩形，松开后选中并退出框选模式；再点一次 ⬚ 或按 Esc 也会退出
const marqueeBtn = document.getElementById('marqueeBtn') as HTMLButtonElement;
function setMarqueeMode(on: boolean) {
  document.body.classList.toggle('marquee-mode', on);
  marqueeBtn.classList.toggle('active', on);
  if (!on) marqueeBtn.blur(); // 点过的按钮还占着焦点，按 Esc 时浏览器会给它画出黑色焦点框
  syncHeaderClone();
}
marqueeBtn.addEventListener('click', () => {
  const on = !document.body.classList.contains('marquee-mode');
  if (on && !root) { layoutNotice('预览窗格里还没有字段块，先把字段拖进来', true); return; }
  if (on) clearSelection();
  setMarqueeMode(on);
});

// 用指针捕获：鼠标拖出预览窗格（到侧边栏、网页 iframe 上）再松开，松开事件也一定回到选区图层，不会让框选卡住。
// 矩形限制在预览窗格内
selLayer.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !root || !document.body.classList.contains('marquee-mode')) return;
  e.preventDefault();
  clearSelection();
  selLayer.setPointerCapture(e.pointerId);
  const host = selLayer.getBoundingClientRect();
  const clampX = (x: number) => Math.min(host.right, Math.max(host.left, x));
  const clampY = (y: number) => Math.min(host.bottom, Math.max(host.top, y));
  const sx = clampX(e.clientX), sy = clampY(e.clientY);
  let marquee: HTMLElement | null = null;
  const rectOf = (ev: PointerEvent) => {
    const x = clampX(ev.clientX), y = clampY(ev.clientY);
    return { left: Math.min(sx, x), top: Math.min(sy, y), right: Math.max(sx, x), bottom: Math.max(sy, y) };
  };
  const move = (ev: PointerEvent) => {
    if (!marquee && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
    if (!marquee) {
      marquee = document.createElement('div');
      marquee.className = 'marquee';
      selLayer.appendChild(marquee);
      document.body.classList.add('dragging-field'); // 让渲染内容不抢鼠标事件
    }
    const r = rectOf(ev);
    marquee.style.left = r.left - host.left + 'px';
    marquee.style.top = r.top - host.top + 'px';
    marquee.style.width = r.right - r.left + 'px';
    marquee.style.height = r.bottom - r.top + 'px';
  };
  const up = (ev: PointerEvent) => {
    selLayer.removeEventListener('pointermove', move);
    selLayer.removeEventListener('pointerup', up);
    selLayer.removeEventListener('pointercancel', up);
    setMarqueeMode(false);
    if (!marquee) return;
    marquee.remove();
    document.body.classList.remove('dragging-field');
    const r = rectOf(ev);
    const hit = unitEls().filter(u => {
      const b = u.el.getBoundingClientRect();
      return b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top;
    }).map(u => u.node);
    sel = hit.length ? selectionFor(hit) : null;
    if (groupable()) { makeGroup(); return; } // 框出一个或多个字段块就直接圈成组合块，不用再点按钮
    drawSelection();
  };
  selLayer.addEventListener('pointermove', move);
  selLayer.addEventListener('pointerup', up);
  selLayer.addEventListener('pointercancel', up);
});

blocksEl.addEventListener('dragover', (e) => {
  const types = e.dataTransfer?.types || [];
  const isField = types.includes(FIELD_DRAG_TYPE), isBlock = types.includes(BLOCK_DRAG_TYPE);
  const isNode = types.includes(NODE_DRAG_TYPE);
  if (!isField && !isBlock && !isNode) return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = isField ? 'copy' : 'move';
  clearDropMarks();
  if (!root) { blocksEl.classList.add('drop-active'); return; }
  const t = dropTarget(e);
  if (!t) return;
  if (t.blank) { showDropHint(t.blank); return; }
  const rep = isField && !types.includes(HEADER_DRAG_TYPE) ? replaceTarget(t) : undefined;
  if (rep) blockEls.get(rep.id)?.classList.add('drop-replace');
  else t.el.classList.add('drop-' + t.zone);
});
blocksEl.addEventListener('dragleave', (e) => {
  if (!blocksEl.contains(e.relatedTarget as globalThis.Node)) endDrag();
});
blocksEl.addEventListener('drop', (e) => {
  e.preventDefault();
  const fieldId = e.dataTransfer?.getData(FIELD_DRAG_TYPE);
  const blockId = e.dataTransfer?.getData(BLOCK_DRAG_TYPE);
  const nodeId = e.dataTransfer?.getData(NODE_DRAG_TYPE);
  const t = dropTarget(e);
  endDrag();
  if (fieldId) {
    if (leaves(root).some(l => l.fieldId === fieldId)) return; // 同一字段只放一块
    const rep = t && fieldId !== HEADER_ID ? replaceTarget(t) : undefined;
    if (rep) {
      // 落在“字段不存在”的字段块上：替换字段，保留字段块的位置和大小
      rep.fieldId = fieldId;
      delete rep.fieldName;
      saveLayout();
      renderBlocks();
      return;
    }
    const added: Leaf = { kind: 'leaf', id: newId(), fieldId, size: 1 };
    if (!root) root = added;
    else if (t) insertBeside(t.node, added, t.zone);
    else return;
    commitLayout();
  } else if (blockId) {
    const moved = leaves(root).find(l => l.id === blockId);
    if (moved) moveNode(moved, t);
  } else if (nodeId) {
    const moved = groups(root).find(g => g.id === nodeId);
    if (moved) moveNode(moved, t);
  }
});
document.addEventListener('dragend', endDrag);

// 侧边栏标题栏里的标题名「data-engine」可拖：拖到预览窗格放下，把标题行的副本放进去（侧边栏的标题行保留），和拖字段一样按落点切分
const navHandle = document.getElementById('navHandle') as HTMLElement;
navHandle.addEventListener('dragstart', (e) => {
  if (!e.dataTransfer) return;
  e.dataTransfer.setData(FIELD_DRAG_TYPE, HEADER_ID);
  e.dataTransfer.setData(HEADER_DRAG_TYPE, '1');
  e.dataTransfer.effectAllowed = 'copyMove';
  document.body.classList.add('dragging-field');
});
navHandle.addEventListener('dragend', endDrag);

renderBlocks();
// 教程链接被服务端配置覆盖后，空状态里的链接也要跟着更新
document.addEventListener('config-loaded', () => { if (!root) renderBlocks(); });

// ── 分隔条：拖动调整预览窗格与侧边栏的宽度；侧边栏字号缩放 ────────
const layoutEl = document.querySelector('.panel-layout') as HTMLElement;
const splitter = document.getElementById('splitter') as HTMLElement;
const savedWidth = parseInt(localStorage.getItem(WIDTH_KEY) || '');
if (savedWidth > 0) layoutEl.style.setProperty('--ann-width', savedWidth + 'px');

splitter.addEventListener('mousedown', (e) => {
  e.preventDefault();
  if (layoutEl.classList.contains('collapsed')) return; // 收起时只能点按钮展开，不能拖
  document.body.classList.add('dragging-field');
  const move = (ev: MouseEvent) => {
    const w = Math.min(window.innerWidth - 240, Math.max(300, window.innerWidth - ev.clientX));
    layoutEl.style.setProperty('--ann-width', w + 'px');
  };
  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    document.body.classList.remove('dragging-field');
    localStorage.setItem(WIDTH_KEY, String(parseInt(layoutEl.style.getPropertyValue('--ann-width')) || ''));
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
});

setupZoom(layoutEl, ZOOM_KEY, 0.85 * 1.05);

// ── 侧边栏收起 / 展开：分隔条上的小按钮，收起后预览窗格占满页面，分隔条留在右边缘用来展开（状态记在 localStorage）──
const COLLAPSED_KEY = 'annotator-panel-sidebar-collapsed';
const collapseBtn = document.getElementById('collapseBtn') as HTMLElement;
function setCollapsed(on: boolean) {
  layoutEl.classList.toggle('collapsed', on);
  collapseBtn.textContent = on ? '◀' : '▶';
  collapseBtn.title = on ? '展开侧边栏' : '收起侧边栏';
  splitter.title = on ? '' : '拖动调整预览窗格与侧边栏的宽度';
  localStorage.setItem(COLLAPSED_KEY, on ? '1' : '');
  window.dispatchEvent(new Event('resize')); // 预览窗格变宽 / 变窄：让块标题栏里的多行值重新撑开
}
collapseBtn.addEventListener('mousedown', (e) => e.stopPropagation()); // 点按钮不触发分隔条的拖动
collapseBtn.addEventListener('click', () => setCollapsed(!layoutEl.classList.contains('collapsed')));
setCollapsed(!!localStorage.getItem(COLLAPSED_KEY));
