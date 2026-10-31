import '../styles/annotator.scss';
import '../styles/panel.scss';
import {
  FType, FieldMeta, RecordData,
  esc, isUrl, cleanUrl, segmentsToText, findUrlInSegments, extractUrlFromValue,
  detectUrlType, proxyUrl, resolveImageUrl, isFramebuster, installProxyFallback,
} from '../shared/common';
import { createAnnotatorUI, FIELD_DRAG_TYPE } from '../shared/annotator-ui';
import { autosizeTextarea, trackManualResize, installLineSelectAll } from '../shared/textarea';
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
  onRefresh: () => send({ type: 'refresh' }),
  saveRecord: (recordId, values) => new Promise<void>((resolve, reject) => {
    if (!opener) return reject(new Error('未连接到侧边栏'));
    const id = ++saveSeq;
    pendingSaves.set(id, { resolve, reject });
    send({ type: 'save', id, recordId, fields: values });
  }),
});

window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.source !== opener || !e.data) return;
  const msg = e.data as HostMessage;
  if (msg.type === 'pong') { lastPong = Date.now(); gotPong = true; return; }
  if (msg.type === 'ack') {
    const p = pendingSaves.get(msg.id);
    pendingSaves.delete(msg.id);
    if (p) msg.ok ? p.resolve() : p.reject(new Error(msg.error || '保存失败'));
    return;
  }
  if (msg.type === 'snapshot') {
    lastPong = Date.now();
    gotPong = true;
    snapshot = msg;
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

// ── 左侧分块布局（树：split 节点按行/列切分，leaf 节点对应一个字段）──
interface Leaf { kind: 'leaf'; id: string; fieldId: string; size: number; }
interface Split { kind: 'split'; dir: 'row' | 'column'; children: LayoutNode[]; size: number; }
type LayoutNode = Leaf | Split;
type Zone = 'left' | 'right' | 'top' | 'bottom';

const LAYOUT_KEY = 'annotator-panel-layout-v2';
const WIDTH_KEY = 'annotator-panel-width';
const ZOOM_KEY = 'annotator-panel-zoom';
const BLOCK_DRAG_TYPE = 'application/x-annotator-block';
// 左侧块标题栏里多行字段值的高度上限：窗口高度的比例。标题栏撑得越高，下面的渲染区越小，所以比右侧标注栏（50%）收得更紧
const BLOCK_VALUE_MAX_RATIO = 0.3;

function validNode(n: any): boolean {
  if (!n || typeof n.size !== 'number') return false;
  if (n.kind === 'leaf') return typeof n.id === 'string' && typeof n.fieldId === 'string';
  return n.kind === 'split' && (n.dir === 'row' || n.dir === 'column') && Array.isArray(n.children) && n.children.every(validNode);
}

function loadLayout(): LayoutNode | null {
  try {
    const n = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '');
    if (validNode(n)) return normalize(n);
  } catch { /* ignore */ }
  return null;
}

let root: LayoutNode | null = loadLayout();
const saveLayout = () => localStorage.setItem(LAYOUT_KEY, JSON.stringify(root));

const blocksEl = document.getElementById('blocks') as HTMLElement;
const blockEls = new Map<string, HTMLElement>();
const nodeEls = new Map<LayoutNode, HTMLElement>(); // 当前渲染出来的节点 → 元素

// 网页 / 视频 / 图片等渲染内容放在一个固定不动的图层里，按对应分块内容区的位置叠上去。
// 布局变化（新增、移动、切分块）会重建分块的容器；iframe 一旦换了父节点就会被浏览器重新加载，
// 所以渲染内容从不跟着挪动，布局变化时只更新它的位置和大小
const viewerLayer = document.getElementById('viewerLayer') as HTMLElement;
const viewerEls = new Map<string, HTMLElement>(); // 分块 id → 渲染内容元素
const bodyObserver = new ResizeObserver(() => positionViewers());

// 左侧块标题栏里的多行值：尺寸变化时重新撑开（只在宽度变化时重算，避免自己改高度又触发自己）
const valueObserver = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const ta = entry.target as HTMLTextAreaElement;
    const w = Math.round(entry.contentRect.width);
    if (String(w) === ta.dataset.lastWidth) continue;
    ta.dataset.lastWidth = String(w);
    autosizeTextarea(ta, BLOCK_VALUE_MAX_RATIO);
  }
});
window.addEventListener('resize', () => {
  blockEls.forEach(el => autosizeTextarea(el.querySelector('textarea.block-value') as HTMLTextAreaElement, BLOCK_VALUE_MAX_RATIO));
});

function positionViewers() {
  const host = viewerLayer.getBoundingClientRect();
  viewerEls.forEach((wrap, id) => {
    const body = blockEls.get(id)?.querySelector('.block-body') as HTMLElement | null | undefined;
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

function removeViewer(id: string) {
  viewerEls.get(id)?.remove();
  viewerEls.delete(id);
}

function newId() { return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// 清理空 split、只剩一个子节点的 split，并把同方向的嵌套 split 拍平
function normalize(node: LayoutNode | null): LayoutNode | null {
  if (!node || node.kind === 'leaf') return node;
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
  return node.kind === 'leaf' ? [node] : node.children.flatMap(leaves);
}

function findParent(node: LayoutNode | null, target: LayoutNode): Split | null {
  if (!node || node.kind === 'leaf') return null;
  for (const c of node.children) {
    if (c === target) return node;
    const p = findParent(c, target);
    if (p) return p;
  }
  return null;
}

function removeLeaf(leaf: Leaf) {
  const parent = findParent(root, leaf);
  if (parent) parent.children = parent.children.filter(c => c !== leaf);
  else if (root === leaf) root = null;
  root = normalize(root);
}

// 在 target 的某个方向上插入新分块
function insertBeside(target: Leaf, added: Leaf, zone: Zone) {
  const dir = zone === 'left' || zone === 'right' ? 'row' : 'column';
  const before = zone === 'left' || zone === 'top';
  const parent = findParent(root, target);
  if (parent && parent.dir === dir) {
    const i = parent.children.indexOf(target);
    target.size = target.size / 2;
    added.size = target.size;
    parent.children.splice(before ? i : i + 1, 0, added);
    return;
  }
  const split: Split = { kind: 'split', dir, size: target.size, children: before ? [added, target] : [target, added] };
  target.size = 1;
  added.size = 1;
  if (parent) parent.children[parent.children.indexOf(target)] = split;
  else root = split;
}

// ── 字段值 → 展示内容 ─────────────────────────────
function fieldName(fieldId: string): string {
  return snapshot?.fields.find(f => f.id === fieldId)?.name || '（字段不在当前视图）';
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
  const field = snapshot?.fields.find(f => f.id === leaf.fieldId);
  (el.querySelector('.block-title') as HTMLElement).textContent = fieldName(leaf.fieldId);

  const content = blockContent(field, snapshot?.record || null);
  const { url } = content;
  // 飞书文本每段末尾自带换行，先去掉首尾空白，否则所有文本都会被当成多行
  const text = content.text.trim();
  const open = el.querySelector('.block-open') as HTMLAnchorElement;
  open.hidden = !url;
  if (url) open.href = url;

  // 标题栏：字段名 | 字段值（左右结构，悬停看全文）。
  // 值里没有换行 → 单行输入框（过长用省略号）；有换行 → 多行输入框，保留换行。都只读，可选中复制。
  // 多行框与右侧标注栏同一套规则：每行不折行（横向滚动）、高度随内容撑开、Ctrl+A 分两步；上限更紧（BLOCK_VALUE_MAX_RATIO）
  const valueInput = el.querySelector('input.block-value') as HTMLInputElement;
  const valueArea = el.querySelector('textarea.block-value') as HTMLTextAreaElement;
  const multiline = text.includes('\n');
  valueInput.hidden = multiline;
  valueArea.hidden = !multiline;
  valueInput.value = multiline ? '' : text;
  valueInput.title = text;
  if (multiline) {
    // 框是复用的：内容变了（切换记录）就清掉“手动拖拽过高度”的标记，重新按内容撑开
    if (valueArea.value !== text) delete valueArea.dataset.manual;
    valueArea.value = text;
    autosizeTextarea(valueArea, BLOCK_VALUE_MAX_RATIO);
  }

  // 内容区：只有 URL 渲染成网页/媒体；其他字段的值只显示在标题栏（输入框里，可选中复制），块只占标题栏高度（值有换行时标题栏会随多行输入框变高）
  const body = el.querySelector('.block-body') as HTMLElement;
  body.hidden = !!field && !url;
  el.classList.toggle('compact', body.hidden); // 没有可渲染内容：高度收缩到只剩标题栏
  // 渲染内容放在固定图层里（见 ensureViewer）；内容区本身只是个占位，字段不存在时才显示提示
  if (field && url) ensureViewer(leaf.id, url);
  else removeViewer(leaf.id);
  const bodyKey = field ? '' : 'x';
  if (body.dataset.key !== bodyKey) {
    body.dataset.key = bodyKey;
    body.innerHTML = field ? '' : '<div class="block-hint">该字段不在当前视图中</div>';
  }
}

// 没有可渲染内容的块（以及全由这类块组成的子树）：下方还有别的块时只占自身高度；
// 下方没有东西时不收缩，占满能占的高度
function isCompactNode(node: LayoutNode): boolean {
  if (node.kind === 'leaf') return !!blockEls.get(node.id)?.classList.contains('compact');
  return node.children.every(isCompactNode);
}

function applyFit(node: LayoutNode) {
  if (node.kind === 'leaf') return;
  const flexible: LayoutNode[] = [];
  node.children.forEach((child, i) => {
    const hasBelow = node.dir === 'column' && i < node.children.length - 1;
    const fit = hasBelow && isCompactNode(child);
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
  if (root) {
    nodeEls.get(root)?.removeAttribute('data-fit');
    applyFit(root);
  }
  positionViewers();
}

function createBlockEl(leaf: Leaf): HTMLElement {
  const el = document.createElement('div');
  el.className = 'block';
  el.dataset.blockId = leaf.id;
  el.innerHTML = `<div class="block-header">
      <span class="block-title" draggable="true" title="拖动字段名可调整位置"></span>
      <input class="block-value" readonly placeholder="（空）" />
      <textarea class="block-value block-value-multi" rows="2" wrap="off" readonly hidden></textarea>
      <a class="block-open" target="_blank" rel="noopener noreferrer" title="在新窗口打开">↗</a>
      <button class="block-close" title="移除该分块（字段回到右侧标注栏）">✕</button>
    </div><div class="block-body"></div>`;
  bodyObserver.observe(el.querySelector('.block-body') as HTMLElement);
  const area = el.querySelector('textarea.block-value') as HTMLTextAreaElement;
  installLineSelectAll(area);
  trackManualResize(area);
  valueObserver.observe(area);
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
  if (!root) {
    blocksEl.innerHTML = '<div class="blocks-empty"><div class="blocks-empty-title">← 把右侧标注栏里的字段名拖到这里</div><div class="blocks-empty-sub">可拖入多个字段，拖到已有分块的边缘即可上下左右分屏</div></div>';
  } else {
    blocksEl.appendChild(buildNode(root));
  }
  // 已在左侧展示的字段，右侧标注栏不再显示；移除分块后自动回到右侧
  ui.setHiddenFields(new Set(all.map(l => l.fieldId)));
  updateBlocks();
}

// ── 分隔线拖动：只改相邻两块，其余保持 ─────────────
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

// ── 拖入字段 / 拖动分块：落在分块哪条边附近，就从哪个方向切分 ──
const ZONES: Zone[] = ['left', 'right', 'top', 'bottom'];

function clearDropMarks() {
  blocksEl.querySelectorAll('.block').forEach(el => ZONES.forEach(z => el.classList.remove('drop-' + z)));
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

interface DropTarget { leaf: Leaf; el: HTMLElement; zone: Zone; blank?: { left: number; top: number; right: number; bottom: number } }

function dropTarget(e: DragEvent): DropTarget | null {
  const el = (e.target as HTMLElement).closest('.block') as HTMLElement | null;
  const leaf = el && leaves(root).find(l => l.id === el.dataset.blockId);
  if (el && leaf) {
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    const dist: Record<Zone, number> = { left: x, right: 1 - x, top: y, bottom: 1 - y };
    const zone = ZONES.reduce((best, z) => dist[z] < dist[best] ? z : best, 'left' as Zone);
    return { leaf, el, zone };
  }

  // 落在空白处（比如收缩成标题栏的分块下方）：找最近的分块，沿空白所在的方向填充
  let best: { leaf: Leaf; el: HTMLElement; r: DOMRect; dx: number; dy: number } | null = null;
  for (const l of leaves(root)) {
    const be = blockEls.get(l.id);
    if (!be) continue;
    const r = be.getBoundingClientRect();
    const dx = e.clientX < r.left ? r.left - e.clientX : e.clientX > r.right ? e.clientX - r.right : 0;
    const dy = e.clientY < r.top ? r.top - e.clientY : e.clientY > r.bottom ? e.clientY - r.bottom : 0;
    // 空白区优先归属“鼠标正上方/下方”的分块（同一列，dx 为 0），其次是“左右侧同一行”的（dy 为 0），
    // 都没有才取最近的。例如左边是高高的网页块、右边是只有标题栏的块时，右块下方的空白归右块
    const rank = dx === 0 ? 0 : dy === 0 ? 1 : 2;
    const bestRank = best ? (best.dx === 0 ? 0 : best.dy === 0 ? 1 : 2) : 3;
    const better = rank < bestRank || (rank === bestRank && best !== null && Math.hypot(dx, dy) < Math.hypot(best.dx, best.dy));
    if (better) best = { leaf: l, el: be, r, dx, dy };
  }
  if (!best) return null;
  const { r, dx, dy } = best;
  const zone: Zone = dy >= dx ? (e.clientY > r.bottom ? 'bottom' : 'top') : (e.clientX > r.right ? 'right' : 'left');
  const p = (best.el.parentElement as HTMLElement).getBoundingClientRect();
  const blank = zone === 'bottom' ? { left: r.left, right: r.right, top: r.bottom, bottom: p.bottom }
    : zone === 'top' ? { left: r.left, right: r.right, top: p.top, bottom: r.top }
    : zone === 'right' ? { left: r.right, right: p.right, top: r.top, bottom: r.bottom }
    : { left: p.left, right: r.left, top: r.top, bottom: r.bottom };
  return { leaf: best.leaf, el: best.el, zone, blank };
}

blocksEl.addEventListener('dragover', (e) => {
  const types = e.dataTransfer?.types || [];
  const isField = types.includes(FIELD_DRAG_TYPE), isBlock = types.includes(BLOCK_DRAG_TYPE);
  if (!isField && !isBlock) return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = isBlock ? 'move' : 'copy';
  clearDropMarks();
  if (!root) { blocksEl.classList.add('drop-active'); return; }
  const t = dropTarget(e);
  if (!t) return;
  if (t.blank) showDropHint(t.blank);
  else t.el.classList.add('drop-' + t.zone);
});
blocksEl.addEventListener('dragleave', (e) => {
  if (!blocksEl.contains(e.relatedTarget as globalThis.Node)) endDrag();
});
blocksEl.addEventListener('drop', (e) => {
  e.preventDefault();
  const fieldId = e.dataTransfer?.getData(FIELD_DRAG_TYPE);
  const blockId = e.dataTransfer?.getData(BLOCK_DRAG_TYPE);
  const t = dropTarget(e);
  endDrag();
  if (fieldId) {
    if (leaves(root).some(l => l.fieldId === fieldId)) return; // 同一字段只放一块
    const added: Leaf = { kind: 'leaf', id: newId(), fieldId, size: 1 };
    if (!root) root = added;
    else if (t) insertBeside(t.leaf, added, t.zone);
    else return;
  } else if (blockId) {
    const moved = leaves(root).find(l => l.id === blockId);
    if (!moved || !t || t.leaf === moved) return;
    removeLeaf(moved);
    moved.size = 1;
    insertBeside(t.leaf, moved, t.zone);
  } else {
    return;
  }
  root = normalize(root);
  saveLayout();
  renderBlocks();
});
document.addEventListener('dragend', endDrag);

renderBlocks();

// ── 左右两栏之间拖动调整宽度；右栏字号缩放 ────────
const layoutEl = document.querySelector('.panel-layout') as HTMLElement;
const splitter = document.getElementById('splitter') as HTMLElement;
const savedWidth = parseInt(localStorage.getItem(WIDTH_KEY) || '');
if (savedWidth > 0) layoutEl.style.setProperty('--ann-width', savedWidth + 'px');

splitter.addEventListener('mousedown', (e) => {
  e.preventDefault();
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

let zoom = parseFloat(localStorage.getItem(ZOOM_KEY) || '') || 0.85;
function setZoom(z: number) {
  zoom = Math.min(1.2, Math.max(0.6, Math.round(z * 100) / 100));
  layoutEl.style.setProperty('--ann-zoom', String(zoom));
  localStorage.setItem(ZOOM_KEY, String(zoom));
}
setZoom(zoom);
document.getElementById('zoomOutBtn')!.addEventListener('click', () => setZoom(zoom - 0.05));
document.getElementById('zoomInBtn')!.addEventListener('click', () => setZoom(zoom + 0.05));
