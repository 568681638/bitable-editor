import { bitable, WidgetBaseEvent } from '@lark-base-open/js-sdk';
import '../styles/annotator.scss';
import { FType, FieldMeta, FieldOption, RecordData, installProxyFallback } from '../shared/common';
import { createAnnotatorUI } from '../shared/annotator-ui';
import { setupModeSwitch } from '../shared/mode-switch';
import { setupZoom } from '../shared/zoom';
import { setupMenu } from '../shared/menu';
import { describeError } from '../shared/errors';
import { createAutoFlush } from '../shared/auto-flush';
import type { MessageStatus, PanelCommand, SnapshotMessage, AckMessage, PongMessage } from '../shared/bridge';

// ── 全局状态 ──────────────────────────────────────
let currentTable: any = null;
let currentView: any = null;
let fields: FieldMeta[] = []; // 当前视图可见的字段（人工编辑、预览 / 导出的列）
let tableFields: FieldMeta[] = []; // 数据表的全部字段，含视图里隐藏的（批处理选字段用）
// 记录按需分批加载：先只取视图里全部记录 ID（顺序与视图一致，总数 = ID 数），
// 记录内容按 BLOCK_SIZE 一块块取，缓存在 recordCache 里
const BLOCK_SIZE = 40;
const PREFETCH_MARGIN = 10; // 距块边缘不足这个数时，后台预取相邻的块
let recordIds: string[] = [];
const recordCache = new Map<string, RecordData>();
const blockPromises = new Map<number, Promise<void>>();
const loadingBlocks = new Set<number>(); // 正在请求中的块
let lastLoadError = '';
let loadGen = 0; // 重置记录列表时自增，丢弃旧请求返回的数据
let navSeq = 0; // 连续跳转时只响应最后一次
let currentIndex = 0;
// 「全部记录」的短时缓存：筛选 / 预览 / 统计常常连着点，读一遍就够了。
// 任何可能让它过期的事（记录增删改、字段变化、刷新、切表切视图、插件自己写入）都会 invalidateAllCache；
// 兜底再加一个存活时间，万一事件没收到也不会一直用旧数据
const ALL_CACHE_TTL = 5 * 60 * 1000;
let allCache: { records: RecordData[]; at: number } | null = null;
let allCacheEpoch = 0; // 每次失效自增：读取过程中发生了失效，这一次读到的结果就不能存进缓存
let allCacheTimer: ReturnType<typeof setTimeout> | undefined;
let lastLoadAt = 0; // 最近一次 loadAllRecords 返回的数据是什么时候从表格里读的
let offTableEvents: Array<() => void> = [];
const fieldOptionsCache: Record<string, FieldOption[]> = {};
let currentTableId = '';
let currentBaseId = '';
let currentViewId = '';
let status: MessageStatus = { kind: 'loading', text: '' };
let panelWin: Window | null = null;
let panelSession = '';

installProxyFallback();

const ui = createAnnotatorUI({
  urlPreview: true,
  onNavigate: (index) => { show(index, true); },
  onRefresh: () => {
    refreshRecords();
    // 顶部 ↻ 在批处理面板里时，顺带重新读取后端函数列表
    if (autoMode) autoFlush.show();
  },
  saveRecord: async (recordId, values) => {
    await persistRecord(recordId, values);
    publish();
  },
});

const autoFlush = createAutoFlush(document.getElementById('autoContent') as HTMLElement, {
  getFields: () => fields,
  getAllFields: () => tableFields,
  getFieldOptions: async (fieldId) => {
    // 每次都重新取，保证选项是最新的（别人可能刚改过）
    const ff = await currentTable.getFieldById(fieldId);
    const options = (await ff.getOptions()) as FieldOption[];
    fieldOptionsCache[fieldId] = options;
    return options;
  },
  getTableId: () => currentTableId,
  // 异步任务按「多维表格 / 数据表」归属，插件只会取回自己这张表的任务
  getScope: () => (currentTableId ? `${currentBaseId}/${currentTableId}` : ''),
  loadAllRecords: async (onProgress, opts) => {
    if (!opts?.fresh && allCache && Date.now() - allCache.at < ALL_CACHE_TTL) {
      lastLoadAt = allCache.at;
      onProgress(allCache.records.length, allCache.records.length);
      return allCache.records.slice(); // 复制数组，调用方怎么 filter / sort 都不会影响缓存
    }
    const epoch = allCacheEpoch;
    const startedAt = Date.now();
    // 分批并发读取（串行的话，总耗时 = 批数 × 单次往返）；并发数不宜太大，避免触发飞书客户端限流
    const ids = recordIds.slice();
    const STEP = 200;
    const CONCURRENCY = 5;
    const batches: string[][] = [];
    for (let i = 0; i < ids.length; i += STEP) batches.push(ids.slice(i, i + STEP));
    const results: RecordData[][] = new Array(batches.length);
    let next = 0;
    let done = 0;
    let failed = false;
    const worker = async () => {
      while (!failed && next < batches.length) {
        const idx = next++;
        try {
          results[idx] = await withTimeout(fetchRecords(batches[idx]), '读取记录');
        } catch (e) {
          failed = true; // 一批失败，其余 worker 不再发新请求
          throw e;
        }
        done += batches[idx].length;
        onProgress(done, ids.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
    const records = results.flat();
    lastLoadAt = startedAt;
    if (epoch === allCacheEpoch) {
      allCache = { records, at: startedAt };
      clearTimeout(allCacheTimer);
      allCacheTimer = setTimeout(invalidateAllCache, ALL_CACHE_TTL); // 到期释放内存
    }
    return records.slice();
  },
  loadedAt: () => lastLoadAt,
  writeRecords: async (items) => {
    invalidateAllCache(); // 写之前就失效：写入过程中并发的读取不会把旧数据存进缓存
    await currentTable.setRecords(items.map(i => ({ recordId: i.recordId, fields: i.fields })));
    invalidateAllCache();
    for (const item of items) {
      const record = recordCache.get(item.recordId);
      if (record) Object.assign(record.fields, item.fields);
    }
    sync();
  },
}, document.getElementById('runBtn') as HTMLButtonElement);
let autoMode = false;
// 视图/字段变化（刷新、切换表格视图）后，批处理面板要重画，字段下拉才会同步
const refreshAutoFlush = () => { if (autoMode) autoFlush.rerender(); };
setupMenu();
document.getElementById('historyBtn')!.addEventListener('click', () => autoFlush.openHistory());
setupModeSwitch(ui.saveIfModified, (mode) => { autoMode = mode === 'auto'; if (autoMode) autoFlush.show(); });
document.body.classList.add('sidebar-zoom');
setupZoom(document.documentElement, 'annotator-sidebar-zoom-v2', 1.05);

function invalidateAllCache() {
  allCache = null;
  allCacheEpoch++;
  clearTimeout(allCacheTimer);
}

// 监听当前表格的记录 / 字段变化（别人或自己改了数据），让缓存失效；切表时先解除上一张表的监听
function watchTable(table: any) {
  offTableEvents.forEach(off => { try { off(); } catch { /* ignore */ } });
  offTableEvents = [];
  const handlers = [table.onRecordAdd, table.onRecordDelete, table.onRecordModify, table.onFieldAdd, table.onFieldDelete, table.onFieldModify];
  for (const on of handlers) {
    try { offTableEvents.push(on.call(table, invalidateAllCache)); } catch { /* 取不到事件就只靠存活时间兜底 */ }
  }
}

function currentRecord(): RecordData | undefined {
  return recordCache.get(recordIds[currentIndex]);
}

// ── 渲染 + 同步到双栏面板 ─────────────────────────
// 当前该展示什么：显式状态 > 当前记录 > 正在加载 > 加载失败。
// 侧边栏和面板页共用这份结果，保证面板页不会因为收到“既无状态又无记录”的快照而一直转圈
function viewState(): { status: MessageStatus; record?: RecordData } {
  if (status) return { status };
  const record = currentRecord();
  if (record) return { status: null, record };
  if (loadingBlocks.has(Math.floor(currentIndex / BLOCK_SIZE))) return { status: { kind: 'loading', text: '' } };
  return { status: { kind: 'error', text: `记录加载失败（${lastLoadError || '未知原因'}），请点击 ↻ 刷新重试` } };
}

function sync() {
  const state = viewState();
  if (state.record) ui.showRecord({ fields, options: fieldOptionsCache, record: state.record, index: currentIndex, total: recordIds.length });
  else if (state.status) ui.showMessage(state.status.kind, state.status.text);
  publish();
}

// ── 分批加载记录 ──────────────────────────────────
function resetRecords(ids: string[]) {
  loadGen++;
  invalidateAllCache(); // 刷新、切表切视图都会走到这里
  loadingBlocks.clear();
  recordIds = ids;
  recordCache.clear();
  blockPromises.clear();
}

async function fetchRecords(ids: string[]): Promise<RecordData[]> {
  let list: any[];
  try {
    list = await currentTable.getRecordsByIds(ids);
  } catch (error) {
    // 批量接口不可用（比如飞书客户端版本偏旧）时，退回逐条获取
    console.warn('getRecordsByIds 失败，退回逐条获取:', error);
    return fetchEachRecord(ids);
  }
  if (list.every(r => r && r.recordId)) {
    return list.map(r => ({ recordId: r.recordId, fields: r.fields || {} }));
  }
  // 返回值不带 recordId 时，按请求顺序对应
  if (list.length === ids.length) {
    return list.map((r, i) => ({ recordId: ids[i], fields: (r && r.fields) || {} }));
  }
  // 数量也对不上：退回逐条获取
  return fetchEachRecord(ids);
}

async function fetchEachRecord(ids: string[]): Promise<RecordData[]> {
  let firstError: unknown = null;
  const each = await Promise.all(ids.map(async (id) => {
    try { return { recordId: id, fields: (await currentTable.getRecordById(id))?.fields || {} }; }
    catch (error) { firstError ??= error; return null; }
  }));
  const list = each.filter((r): r is RecordData => !!r);
  if (list.length === 0 && firstError) throw firstError;
  return list;
}

function ensureBlock(block: number): Promise<void> {
  const start = block * BLOCK_SIZE;
  if (block < 0 || start >= recordIds.length) return Promise.resolve();
  let p = blockPromises.get(block);
  if (!p) {
    const gen = loadGen;
    loadingBlocks.add(block);
    p = withTimeout(fetchRecords(recordIds.slice(start, start + BLOCK_SIZE)), '加载记录内容')
      .then((list) => { if (gen === loadGen) list.forEach(r => recordCache.set(r.recordId, r)); })
      .catch((error) => {
        console.error('加载记录失败:', error);
        lastLoadError = describeError(error, 'read');
        if (gen === loadGen) blockPromises.delete(block); // 允许之后重试
      })
      .finally(() => { if (gen === loadGen) loadingBlocks.delete(block); });
    blockPromises.set(block, p);
  }
  return p;
}

// 后台预取相邻的块，连续翻页时基本不用等待
function prefetchAround(index: number) {
  const block = Math.floor(index / BLOCK_SIZE);
  const offset = index % BLOCK_SIZE;
  if (offset < PREFETCH_MARGIN) ensureBlock(block - 1);
  if (offset >= BLOCK_SIZE - PREFETCH_MARGIN) ensureBlock(block + 1);
}

// 显示第 index 条：所在块未加载时先等它加载完（跳转到任意位置都只需等一次请求）
async function show(index: number, locate: boolean) {
  const seq = ++navSeq;
  await ensureBlock(Math.floor(index / BLOCK_SIZE));
  if (seq !== navSeq) return;
  currentIndex = index;
  sync();
  if (locate) locateRecord(recordIds[index]);
  prefetchAround(index);
}

async function persistRecord(recordId: string, values: Record<string, any>) {
  invalidateAllCache();
  await currentTable.setRecord(recordId, { fields: values });
  invalidateAllCache();
  const record = recordCache.get(recordId);
  if (record) Object.assign(record.fields, values);
}

// ── 双栏面板（新标签页）──────────────────────────
const openPanelBtn = document.getElementById('openPanelBtn') as HTMLButtonElement;

const PANEL_WINDOW_NAME = 'bitable-annotator-panel';

openPanelBtn.addEventListener('click', () => {
  // 面板已经打开且连着：只切回去，不重新加载，保留网页的滚动位置和视频进度。
  // 地址传空串 + 同名窗口：返回已有窗口并把它切到前台，不会导航
  if (panelWin && !panelWin.closed) {
    const existing = window.open('', PANEL_WINDOW_NAME);
    if (existing === panelWin) { existing.focus(); return; }
    existing?.close(); // 没找到同名窗口时浏览器会新开一个空白页，关掉它，走下面的正常打开
  }
  // 面板没开（或侧边栏刚刷新、丢了连接）：打开；同名窗口会被复用并重新加载，加载后会发 panel-ready 建立连接
  const win = window.open(new URL('panel.html', location.href).href, PANEL_WINDOW_NAME);
  if (!win) alert('浏览器拦截了弹窗，请允许后重试');
});

function postToPanel(msg: SnapshotMessage | AckMessage | PongMessage) {
  if (!panelWin) return;
  if (panelWin.closed) { panelWin = null; return; }
  panelWin.postMessage(msg, location.origin);
}

function publish() {
  const state = viewState();
  postToPanel({
    type: 'snapshot',
    tableId: currentTableId,
    status: state.status,
    fields,
    options: fieldOptionsCache,
    index: currentIndex,
    total: recordIds.length,
    record: state.record || null,
  });
}

window.addEventListener('message', async (e) => {
  if (e.origin !== location.origin || !e.data || typeof e.data !== 'object') return;
  const cmd = e.data as PanelCommand;
  if (cmd.type === 'panel-ready') {
    // 面板页心跳：新连接才推全量快照，避免打断面板里正在编辑的内容
    const isNew = panelWin !== e.source || panelSession !== cmd.session;
    panelWin = e.source as Window;
    panelSession = cmd.session;
    postToPanel({ type: 'pong' });
    if (isNew) publish();
    return;
  }
  if (e.source !== panelWin) return;
  switch (cmd.type) {
    case 'navigate':
      if (Number.isInteger(cmd.index) && cmd.index >= 0 && cmd.index < recordIds.length) {
        await ui.saveIfModified();
        await show(cmd.index, true);
      } else {
        publish();
      }
      break;
    case 'refresh':
      if (!ui.isSaving()) await refreshRecords();
      break;
    case 'save':
      try {
        await persistRecord(cmd.recordId, cmd.fields);
        postToPanel({ type: 'ack', id: cmd.id, ok: true });
        sync();
      } catch (error) {
        postToPanel({ type: 'ack', id: cmd.id, ok: false, error: describeError(error, 'write') });
      }
      break;
  }
});

// ── 切换记录时自动在表格中定位高亮 ──────────────────
async function locateRecord(recordId: string) {
  if (fields.length === 0) return;
  try {
    await (bitable as any).ui.showFieldValueEditor({
      tableId: currentTableId,
      viewId: currentViewId,
      recordId,
      fieldId: fields[0].id,
    });
  } catch {
    // 忽略定位失败
  }
}

// 飞书接口偶尔会长时间不返回，超时后给出明确的报错，而不是让界面一直停在“加载中”
const REQUEST_TIMEOUT = 20000;
function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时（超过 ${REQUEST_TIMEOUT / 1000} 秒无响应）`)), REQUEST_TIMEOUT);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

async function loadVisibleRecordIds(): Promise<string[]> {
  const ids: (string | undefined)[] = await withTimeout(currentView.getVisibleRecordIdList(), '获取记录列表');
  return ids.filter((id): id is string => !!id);
}

// ── 刷新记录列表（同步字段列表/顺序/可见性/选项 + 记录列表）──
async function refreshRecords() {
  if (!currentTable) return;
  try {
    // 1. 重新获取字段元数据（覆盖新增/删除/重命名的字段）
    const allFields: FieldMeta[] = await currentTable.getFieldMetaList();
    tableFields = allFields;
    const fieldMap = new Map<string, FieldMeta>();
    allFields.forEach(f => fieldMap.set(f.id, f));

    // 2. 重新获取视图可见字段顺序
    const visibleIds: string[] = await currentView.getVisibleFieldIdList();
    const newFields = visibleIds
      .map(id => fieldMap.get(id))
      .filter((f): f is FieldMeta => !!f);

    if (newFields.length > 0) {
      fields = newFields;
    }

    // 3. 刷新选择字段的选项（覆盖选项列表变更），同时重新获取记录 ID 列表
    const prevRecordId = recordIds[currentIndex];
    const [ids] = await Promise.all([loadVisibleRecordIds(), loadFieldOptions()]);

    // 4. 清空缓存，只重新加载当前所在的块
    resetRecords(ids);
    const kept = ids.indexOf(prevRecordId);
    currentIndex = kept >= 0 ? kept : Math.min(currentIndex, Math.max(0, ids.length - 1));
    await showLoaded();
    refreshAutoFlush();
  } catch (e) {
    console.error('刷新失败', e);
    alert('刷新失败：' + describeError(e, 'read'));
  }
}

// 加载当前位置所在的块并渲染（init / 刷新共用）
async function showLoaded() {
  if (recordIds.length === 0) {
    status = { kind: 'empty', text: '当前视图没有记录' };
    sync();
    return;
  }
  const seq = ++navSeq;
  setStatus('loading', `正在加载记录内容（共 ${recordIds.length} 条）…`);
  await ensureBlock(Math.floor(currentIndex / BLOCK_SIZE));
  if (seq !== navSeq) return;
  status = null;
  sync();
  prefetchAround(currentIndex);
}

async function loadFieldOptions() {
  const selectFields = fields.filter(f => f.type === FType.SINGLE_SELECT || f.type === FType.MULTI_SELECT);
  await Promise.all(selectFields.map(async (field) => {
    try {
      const ff = await currentTable.getFieldById(field.id);
      if (ff && typeof ff.getOptions === 'function') {
        fieldOptionsCache[field.id] = (await ff.getOptions()) as FieldOption[];
      }
    } catch { /* ignore */ }
  }));
}

// ── 初始化 ────────────────────────────────────────
function setStatus(kind: 'loading' | 'empty' | 'error', text = '') {
  status = { kind, text };
  sync();
}

async function init() {
  try {
    setStatus('loading', '正在读取当前表格…');
    const sel = await bitable.base.getSelection();

    if (!sel.tableId) {
      setStatus('empty', '请先在多维表格中选中一个表格');
      return;
    }

    currentTable = await bitable.base.getTableById(sel.tableId);
    currentTableId = sel.tableId;
    currentBaseId = sel.baseId || '';
    invalidateAllCache();
    watchTable(currentTable);
    const allFields: FieldMeta[] = await currentTable.getFieldMetaList();
    tableFields = allFields;

    const views = await currentTable.getViewMetaList();
    let viewId = sel.viewId;
    if (!viewId && views.length > 0) viewId = views[0].id;
    if (!viewId) {
      setStatus('empty', '表格中没有可用视图');
      return;
    }

    currentView = await currentTable.getViewById(viewId);
    currentViewId = viewId;
    const visibleIds: string[] = await currentView.getVisibleFieldIdList();

    const fieldMap = new Map<string, FieldMeta>();
    allFields.forEach(f => fieldMap.set(f.id, f));
    fields = visibleIds
      .map(id => fieldMap.get(id))
      .filter((f): f is FieldMeta => !!f);

    if (fields.length === 0) {
      setStatus('empty', '视图中没有可见字段');
      return;
    }

    setStatus('loading', '正在获取字段和记录列表…');
    // 选择字段的选项与记录 ID 列表并行加载
    const [ids] = await Promise.all([loadVisibleRecordIds(), loadFieldOptions()]);
    resetRecords(ids);

    currentIndex = 0;
    if (sel.recordId) {
      const idx = ids.indexOf(sel.recordId);
      if (idx >= 0) currentIndex = idx;
    }
    await showLoaded();
    refreshAutoFlush();
  } catch (error) {
    console.error('初始化失败:', error);
    setStatus('error', describeError(error, 'read') + '。可点击右上角 ↻ 刷新重试');
  }
}

// ── 选择变化监听 ──────────────────────────────────
async function onSelectionChange() {
  try {
    const sel = await bitable.base.getSelection();
    if (sel.tableId) {
      const tc = currentTableId !== sel.tableId;
      const vc = sel.viewId && currentViewId !== sel.viewId;
      if (tc || vc) { await init(); return; }
    }
    if (sel.recordId && recordIds.length > 0) {
      const idx = recordIds.indexOf(sel.recordId);
      if (idx >= 0 && idx !== currentIndex) {
        await ui.saveIfModified();
        await show(idx, false);
      }
    }
  } catch (e) { /* ignore */ }
}

async function setupSelectionListener() {
  try {
    await bitable.base.registerBaseEvent(WidgetBaseEvent.SelectionChange);
    bitable.base.onSelectionChange(onSelectionChange);
  } catch (e) { /* ignore */ }
}

// ── 启动 ──────────────────────────────────────────
init();
setupSelectionListener();
