import { bitable, WidgetBaseEvent } from '@lark-base-open/js-sdk';
import './index.scss';

// ── 类型定义 ──────────────────────────────────────
interface FieldMeta {
  id: string;
  name: string;
  type: number;
  isPrimary?: boolean;
}

interface FieldOption {
  id: string;
  name: string;
  color?: number;
}

interface RecordData {
  recordId: string;
  fields: Record<string, any>;
}

// ── 飞书字段类型常量 ─────────────────────────────
const FType: Record<string, number> = {
  TEXT: 1, NUMBER: 2, SINGLE_SELECT: 3, MULTI_SELECT: 4,
  DATE_TIME: 5, CHECKBOX: 7, USER: 11, PHONE: 13,
  URL: 15, ATTACHMENT: 17, SINGLE_LINK: 18, FORMULA: 20,
  DUPLEX_LINK: 21, LOCATION: 22, GROUP_CHAT: 23, OBJECT: 25,
  EMAIL: 99005, AUTO_NUMBER: 1005, PROGRESS: 99002,
  CURRENCY: 99003, RATING: 99004,
};

const READONLY_TYPES = new Set([
  FType.URL, FType.FORMULA, FType.SINGLE_LINK, FType.DUPLEX_LINK,
  FType.ATTACHMENT, FType.AUTO_NUMBER, FType.LOCATION, FType.OBJECT,
  FType.USER, FType.GROUP_CHAT,
]);

// ── 全局状态 ──────────────────────────────────────
let currentTable: any = null;
let currentView: any = null;
let fields: FieldMeta[] = [];
let records: RecordData[] = [];
let currentIndex = 0;
let modifiedFields: Record<string, any> = {};
let isSaving = false;
const fieldOptionsCache: Record<string, FieldOption[]> = {};
let currentTableId = '';
let currentViewId = '';

// ── DOM 引用 ──────────────────────────────────────
const recordContent = document.getElementById('recordContent')!;
const prevBtn = document.getElementById('prevBtn') as HTMLButtonElement;
const nextBtn = document.getElementById('nextBtn') as HTMLButtonElement;
const recordIndex = document.getElementById('recordJump') as HTMLInputElement;
const totalCount = document.getElementById('totalCount') as HTMLSpanElement;
const saveBtn = document.getElementById('saveBtn') as HTMLButtonElement;
const undoBtn = document.getElementById('undoBtn') as HTMLButtonElement;
const refreshBtn = document.getElementById('refreshBtn') as HTMLButtonElement;

// ── 切换记录时自动在表格中定位高亮 ──────────────────
async function locateRecord(record: RecordData) {
  if (fields.length === 0) return;
  try {
    await (bitable as any).ui.showFieldValueEditor({
      tableId: currentTableId,
      viewId: currentViewId,
      recordId: record.recordId,
      fieldId: fields[0].id,
    });
  } catch {
    // 忽略定位失败
  }
}

// ── 撤销修改 ──────────────────────────────────────
undoBtn.addEventListener('click', () => {
  if (Object.keys(modifiedFields).length === 0) return;
  modifiedFields = {};
  renderCurrentRecord();
  updateSaveBtn();
  undoBtn.disabled = true;
});

// ── 刷新记录列表（同步字段列表/顺序/可见性/选项 + 记录列表）──
async function refreshRecords() {
  if (!currentTable || isSaving) return;
  try {
    // 1. 重新获取字段元数据（覆盖新增/删除/重命名的字段）
    const allFields: FieldMeta[] = await currentTable.getFieldMetaList();
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

    // 3. 刷新选择字段的选项（覆盖选项列表变更）
    for (const field of fields) {
      if (field.type === FType.SINGLE_SELECT || field.type === FType.MULTI_SELECT) {
        try {
          const ff = await currentTable.getFieldById(field.id);
          if (ff && typeof ff.getOptions === 'function') {
            fieldOptionsCache[field.id] = (await ff.getOptions()) as FieldOption[];
          }
        } catch { /* ignore */ }
      }
    }

    // 4. 刷新记录列表
    await loadRecords();
    if (currentIndex >= records.length) currentIndex = Math.max(0, records.length - 1);
    updateNavButtons();
    if (records.length > 0) {
      renderCurrentRecord();
    } else {
      renderEmptyState('当前视图没有记录');
    }
  } catch (e) {
    console.error('刷新失败', e);
  }
}

refreshBtn.addEventListener('click', refreshRecords);

// ── 只读判断 ──────────────────────────────────────
function isFieldReadonly(field: FieldMeta, rawValue: any): boolean {
  if (fields.length > 0 && field.id === fields[0].id) return true;
  if (READONLY_TYPES.has(field.type)) return true;
  if (field.type === FType.TEXT && Array.isArray(rawValue)) {
    return rawValue.some((seg: any) => seg && seg.type === 'url');
  }
  return false;
}

// ── 清理URL中的反引号和前后空格 ──────────────────
function cleanUrl(raw: string): string {
  return raw.replace(/`/g, '').trim();
}

// ── IOpenSegment[] → 纯文本（保留换行） ───────────
function segmentsToText(value: any): string {
  if (!Array.isArray(value)) {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') return value.text || '';
    return String(value || '');
  }
  // 每个 segment.text 末尾自带 \n，直接拼接即可
  return value
    .filter((seg: any) => seg)
    .map((seg: any) => seg.text || '')
    .join('');
}

// ── IOpenSegment[] → 提取第一个 URL ───────────────
function findUrlInSegments(value: any): string | null {
  if (!Array.isArray(value)) return null;
  for (const seg of value) {
    if (seg && seg.type === 'url' && (seg.link || seg.text)) {
      return cleanUrl(seg.link || seg.text);
    }
  }
  return null;
}

// ── 提取 URL（通用） ──────────────────────────────
function extractUrlFromValue(value: any): string {
  if (Array.isArray(value) && value.length > 0) {
    for (const seg of value) {
      if (seg && seg.type === 'url' && (seg.link || seg.text)) return cleanUrl(seg.link || seg.text);
    }
    return cleanUrl(value[0].link || value[0].text || '');
  }
  if (typeof value === 'object' && value !== null) return cleanUrl(value.link || value.text || '');
  return cleanUrl(String(value || ''));
}

// ── 文本是否包含换行（去掉末尾换行判断） ──────────
function hasNewlines(value: any): boolean {
  const text = Array.isArray(value) ? segmentsToText(value) : String(value || '');
  return text.trimEnd().includes('\n');
}

// ── 初始化 ────────────────────────────────────────
async function init() {
  try {
    renderLoading();
    const sel = await bitable.base.getSelection();

    if (!sel.tableId) {
      renderEmptyState('请先在多维表格中选中一个表格');
      return;
    }

    currentTable = await bitable.base.getTableById(sel.tableId);
    currentTableId = sel.tableId;
    const allFields: FieldMeta[] = await currentTable.getFieldMetaList();

    const views = await currentTable.getViewMetaList();
    let viewId = sel.viewId;
    if (!viewId && views.length > 0) viewId = views[0].id;
    if (!viewId) {
      renderEmptyState('表格中没有可用视图');
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
      renderEmptyState('视图中没有可见字段');
      return;
    }

    // 预加载选择字段的选项
    for (const field of fields) {
      if (field.type === FType.SINGLE_SELECT || field.type === FType.MULTI_SELECT) {
        try {
          const ff = await currentTable.getFieldById(field.id);
          if (ff && typeof ff.getOptions === 'function') {
            fieldOptionsCache[field.id] = (await ff.getOptions()) as FieldOption[];
          }
        } catch (e) { /* ignore */ }
      }
    }

    await loadRecords();

    if (sel.recordId) {
      const idx = records.findIndex(r => r.recordId === sel.recordId);
      if (idx >= 0) currentIndex = idx;
    }
    updateNavButtons();
    if (records.length > 0) renderCurrentRecord();
  } catch (error) {
    console.error('初始化失败:', error);
    renderError(error instanceof Error ? error.message : '未知错误');
  }
}

async function loadRecords() {
  try {
    const result = await currentTable.getRecords({
      fieldIds: fields.map(f => f.id),
      viewId: currentViewId,
    });
    const rawRecords = result.records || [];
    // IRecord 使用 recordId，这里统一字段名
    records = rawRecords.map((r: any) => ({
      recordId: r.recordId || r.id || r._id || '',
      fields: r.fields || {},
    }));
  } catch (error) {
    console.error('加载记录失败:', error);
  }
}

// ── 渲染 ──────────────────────────────────────────
function renderLoading() {
  recordContent.innerHTML = '<div class="loading">加载中...</div>';
  prevBtn.disabled = nextBtn.disabled = saveBtn.disabled = true;
}

function renderEmptyState(msg: string) {
  recordContent.innerHTML = `<div class="empty-state"><p>${msg}</p></div>`;
  prevBtn.disabled = nextBtn.disabled = saveBtn.disabled = true;
}

function renderError(msg: string) {
  recordContent.innerHTML = `<div class="error-message">${msg}</div>`;
}

function updateNavButtons() {
  prevBtn.disabled = currentIndex <= 0;
  nextBtn.disabled = currentIndex >= records.length - 1;
  recordIndex.disabled = records.length === 0;
  recordIndex.max = String(records.length);
  recordIndex.value = records.length > 0 ? String(currentIndex + 1) : '0';
  totalCount.textContent = `/ ${records.length}`;
}

function renderCurrentRecord() {
  if (records.length === 0 || currentIndex < 0 || currentIndex >= records.length) return;
  const record = records[currentIndex];

  const fieldsHtml = fields.map(field => {
    const value = record.fields[field.id];
    const ctrl = renderFieldControl(field, value);
    return `<div class="field-row" data-field-id="${field.id}">
      <div class="field-label">${esc(field.name)}</div>
      <div class="field-value">${ctrl}</div>
    </div>`;
  }).join('');

  recordContent.innerHTML = `<div class="record-fields">${fieldsHtml}</div>`;
  attachFieldListeners();
  updateSaveBtn();
}

// ── 字段控件分发 ──────────────────────────────────
function renderFieldControl(field: FieldMeta, rawValue: any): string {
  switch (field.type) {
    case FType.SINGLE_SELECT: return renderSingleSelect(field, rawValue);
    case FType.MULTI_SELECT: return renderMultiSelect(field, rawValue);
    case FType.CHECKBOX: return renderCheckbox(field, rawValue);
    case FType.DATE_TIME: return renderDateField(field, rawValue);
    case FType.NUMBER:
    case FType.CURRENCY:
    case FType.PROGRESS:
    case FType.RATING: return renderNumberField(field, rawValue);
    case FType.URL: return renderUrlField(field, rawValue);
    case FType.FORMULA: return renderFormulaField(field, rawValue);
    case FType.TEXT: return renderTextField(field, rawValue);
    case FType.PHONE: return renderTextField(field, rawValue);
    case FType.EMAIL: return renderTextField(field, rawValue);
    case FType.LOCATION: return renderLocationField(field, rawValue);
    case FType.AUTO_NUMBER: return renderReadonlyField(field, rawValue);
    case FType.ATTACHMENT: return renderReadonlyField(field, rawValue);
    case FType.USER:
    case FType.GROUP_CHAT: return renderUserField(field, rawValue);
    default: return renderTextField(field, rawValue);
  }
}

// ── 控件渲染 ──────────────────────────────────────
function renderSingleSelect(field: FieldMeta, rawValue: any): string {
  const options = fieldOptionsCache[field.id] || [];
  let sid = '';
  if (rawValue && typeof rawValue === 'object') sid = (rawValue as any).id || '';
  const ro = isFieldReadonly(field, rawValue);
  let h = `<select class="field-select${ro ? '' : ' field-input'}" data-field-id="${field.id}"${ro ? ' disabled' : ''}>`;
  h += `<option value="">— 请选择 —</option>`;
  for (const o of options) {
    h += `<option value="${esc(o.id)}"${o.id === sid ? ' selected' : ''}>${esc(o.name)}</option>`;
  }
  h += '</select>';
  return h;
}

function renderMultiSelect(field: FieldMeta, rawValue: any): string {
  const options = fieldOptionsCache[field.id] || [];
  const sids = new Set<string>();
  if (Array.isArray(rawValue)) rawValue.forEach((v: any) => { if (v && v.id) sids.add(v.id); });
  const ro = isFieldReadonly(field, rawValue);
  let h = `<div class="field-checkbox-group${ro ? '' : ' field-input'}" data-field-id="${field.id}" data-field-type="multiSelect">`;
  for (const o of options) {
    h += `<label class="checkbox-item">
      <input type="checkbox" value="${esc(o.id)}" class="field-checkbox"${sids.has(o.id) ? ' checked' : ''}${ro ? ' disabled' : ''} />
      <span>${esc(o.name)}</span></label>`;
  }
  h += '</div>';
  return h;
}

function renderCheckbox(field: FieldMeta, rawValue: any): string {
  const checked = rawValue === true;
  const ro = isFieldReadonly(field, rawValue);
  return `<label class="checkbox-item${ro ? '' : ' field-input'}" data-field-id="${field.id}" data-field-type="checkbox">
    <input type="checkbox" class="field-checkbox"${checked ? ' checked' : ''}${ro ? ' disabled' : ''} />
    <span>已勾选</span></label>`;
}

function renderDateField(field: FieldMeta, rawValue: any): string {
  let ds = '';
  if (typeof rawValue === 'number' && rawValue > 0) ds = new Date(rawValue).toISOString().slice(0, 16);
  else if (typeof rawValue === 'string') {
    try { const d = new Date(rawValue); if (!isNaN(d.getTime())) ds = d.toISOString().slice(0, 16); } catch { /* */ }
  }
  const ro = isFieldReadonly(field, rawValue);
  return `<input type="datetime-local" class="${ro ? '' : 'field-input'}" data-field-id="${field.id}" data-field-type="date" value="${ds}"${ro ? ' readonly' : ''} />`;
}

function renderNumberField(field: FieldMeta, rawValue: any): string {
  const val = (rawValue !== undefined && rawValue !== null) ? String(rawValue) : '';
  const ro = isFieldReadonly(field, rawValue);
  return `<input type="number" class="${ro ? '' : 'field-input'}" data-field-id="${field.id}" data-field-type="number" value="${esc(val)}"${ro ? ' readonly' : ''} />`;
}

function renderUrlField(field: FieldMeta, rawValue: any): string {
  const url = extractUrlFromValue(rawValue);
  let prev = '';
  if (isUrl(url)) prev = `<div class="url-preview">${renderUrlPreview(url, detectUrlType(url))}</div>`;
  return `<input type="url" data-field-id="${field.id}" value="${esc(url)}" readonly />${prev}`;
}

function renderFormulaField(field: FieldMeta, rawValue: any): string {
  const text = segmentsToText(rawValue);
  if (isUrl(text)) {
    const ut = detectUrlType(text);
    return `<input type="text" data-field-id="${field.id}" value="${esc(text)}" readonly /><div class="url-preview">${renderUrlPreview(text, ut)}</div>`;
  }
  return `<input type="text" data-field-id="${field.id}" value="${esc(text)}" readonly />`;
}

function renderTextField(field: FieldMeta, rawValue: any): string {
  const ro = isFieldReadonly(field, rawValue);

  // 尝试从各种格式中提取URL
  let urlToRender: string | null = null;

  // 1) IOpenSegment[] 中的 URL
  const embeddedUrl = findUrlInSegments(rawValue);
  if (embeddedUrl && isUrl(embeddedUrl)) {
    urlToRender = embeddedUrl;
  }

  // 2) 纯文本值用 cleanUrl 清洗后检测
  let textVal: string;
  if (Array.isArray(rawValue)) {
    textVal = segmentsToText(rawValue);
  } else {
    textVal = (rawValue !== undefined && rawValue !== null) ? String(rawValue) : '';
  }

  if (!urlToRender && isUrl(cleanUrl(textVal))) {
    urlToRender = cleanUrl(textVal);
  }

  // 有URL → 只读显示 + 预览
  if (urlToRender) {
    const prev = `<div class="url-preview">${renderUrlPreview(urlToRender, detectUrlType(urlToRender))}</div>`;
    return `<input type="text" data-field-id="${field.id}" value="${esc(urlToRender)}" readonly />${prev}`;
  }

  const useTextarea = hasNewlines(rawValue) || textVal.length > 100;

  if (useTextarea) {
    const lineCount = textVal.split('\n').length;
    const rows = Math.min(Math.max(lineCount, 2), 7);
    return `<textarea class="${ro ? '' : 'field-input'}" data-field-id="${field.id}" data-field-type="text" rows="${rows}"${ro ? ' readonly' : ''}>${esc(textVal)}</textarea>`;
  }
  return `<input type="text" class="${ro ? '' : 'field-input'}" data-field-id="${field.id}" data-field-type="text" value="${esc(textVal)}"${ro ? ' readonly' : ''} />`;
}

function renderLocationField(field: FieldMeta, rawValue: any): string {
  let addr = '';
  if (rawValue && typeof rawValue === 'object') {
    addr = rawValue.fullAddress || rawValue.address || rawValue.name || JSON.stringify(rawValue);
  } else if (typeof rawValue === 'string') addr = rawValue;
  return `<input type="text" data-field-id="${field.id}" value="${esc(addr)}" readonly />`;
}

function renderUserField(field: FieldMeta, rawValue: any): string {
  // rawValue 可能是 [{id:"xxx", name:"张三"}] 或 {id:"xxx", name:"张三"}
  const names: string[] = [];
  if (Array.isArray(rawValue)) {
    for (const item of rawValue) {
      if (item && item.name) names.push(item.name);
    }
  } else if (rawValue && typeof rawValue === 'object' && rawValue.name) {
    names.push(rawValue.name);
  } else if (rawValue) {
    names.push(String(rawValue));
  }
  const text = names.join('、') || '—';
  return `<input type="text" data-field-id="${field.id}" value="${esc(text)}" readonly />`;
}

function renderReadonlyField(field: FieldMeta, rawValue: any): string {
  const text = segmentsToText(rawValue);
  return `<input type="text" data-field-id="${field.id}" value="${esc(text)}" readonly />`;
}

// ── 工具函数 ──────────────────────────────────────
function isUrl(value: string): boolean {
  return /^https?:\/\/[^\s]+$/.test(value);
}

// ── 从搜索页URL中提取真实图片链接 ─────────────────
function resolveImageUrl(url: string): string {
  const lo = url.toLowerCase();
  // Bing: mediaurl= 参数
  const mediaMatch = url.match(/mediaurl=([^&\s]+)/i);
  if (mediaMatch) {
    return decodeURIComponent(mediaMatch[1]);
  }
  // 谷歌: imgurl= 参数
  const imgMatch = url.match(/imgurl=([^&\s]+)/i);
  if (imgMatch) {
    return decodeURIComponent(imgMatch[1]);
  }
  return url;
}

function detectUrlType(url: string): 'video' | 'image' | 'audio' | 'webpage' {
  const lo = url.toLowerCase();
  // 视频
  if (['.mp4','.webm','.ogg','.avi','.mov','.mkv'].some(e => lo.includes(e)) ||
      ['youtube.com','youtu.be','vimeo.com'].some(e => lo.includes(e))) return 'video';
  // 音频
  if (['.mp3','.wav','.flac','.aac'].some(e => lo.includes(e))) return 'audio';
  // 图片：扩展名 / 常见图床 / OSS / 路径关键字 / mediaurl参数
  if (['.jpg','.jpeg','.png','.gif','.bmp','.svg','.webp','.ico'].some(e => lo.includes(e))) return 'image';
  if (['bing.net/th/id/','imgur.com','picsum.photos','placehold.co',
       'lorempixel.com','dummyimage.com','giphy.com',
       'aliyuncs.com','oss-'].some(e => lo.includes(e))) return 'image';
  if (/\/img\/|\/image\/|\/photo\/|\/pic\/|mediaurl=/.test(lo)) return 'image';
  return 'webpage';
}

// ── 所有外部URL走同源代理，绕过Chrome PNA/CORS限制 ──
// ── 内网域名必须走代理；其他域名先直连，失败后自动回退到代理 ──
const PROXY_DOMAINS = [
  'oss-cn-shenzhen-internal.aliyuncs.com',
];

function needsProxy(url: string): boolean {
  return PROXY_DOMAINS.some(d => url.includes(d));
}

function toProxy(url: string): string {
  return 'api-proxy/' + encodeURIComponent(url);
}

function proxyUrl(url: string): string {
  if (/^https?:\/\//.test(url) && needsProxy(url)) return toProxy(url);
  return url;
}

// 媒体直连失败（网络不通 / 混合内容 / CORS / PNA 等）时，自动改走服务器代理重试一次
document.addEventListener('error', (e) => {
  const el = e.target as HTMLElement | null;
  if (!el || !['IMG', 'VIDEO', 'AUDIO', 'SOURCE'].includes(el.tagName)) return;
  const raw = el.getAttribute('src');
  if (!raw || !/^https?:\/\//i.test(raw) || el.dataset.proxied) return;
  el.dataset.proxied = '1';
  el.setAttribute('src', toProxy(raw));
  const media = el.tagName === 'SOURCE' ? el.parentElement as HTMLMediaElement | null : null;
  if (media && typeof media.load === 'function') media.load();
  e.stopPropagation();
}, true);

// ── 会执行破框代码的域名（不渲染 iframe，只展示链接） ──
const FRAMEBUSTER_DOMAINS = [
  'tte.zytintra.com',
];

function isFramebuster(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return FRAMEBUSTER_DOMAINS.some(d => hostname.includes(d));
  } catch { return false; }
}

function renderUrlPreview(url: string, type: string): string {
  const src = proxyUrl(url);
  const fallbackLink = `<a href="${src}" target="_blank" rel="noopener noreferrer">${esc(src)}</a>`;
  switch (type) {
    case 'video': return `<video controls style="width:100%;"><source src="${src}" type="video/mp4">${fallbackLink}</video>`;
    case 'image': {
      const imgSrc = resolveImageUrl(src);
      return `<img src="${imgSrc}" alt="预览" style="width:100%;object-fit:contain;" onerror="this.style.display='none';this.nextElementSibling.style.display=''" /><span style="display:none">${fallbackLink}</span>`;
    }
    case 'audio': return `<audio controls style="max-width:100%;"><source src="${src}">${fallbackLink}</audio>`;
    case 'webpage': {
      if (isFramebuster(url)) return fallbackLink;
      return `<iframe src="${src}" style="width:100%;aspect-ratio:16/9;border:1px solid #ddd;border-radius:4px;" sandbox="allow-scripts allow-same-origin allow-popups">${fallbackLink}</iframe>`;
    }
    default: return fallbackLink;
  }
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// ── 事件监听（仅 .field-input class 的元素可编辑） ──
function attachFieldListeners() {
  const textSegmentFieldIds = new Set<string>();

  // 阻止 number 输入框聚焦时滚轮改值，但不影响页面滚动
   recordContent.querySelectorAll('input[type="number"].field-input').forEach(el => {
     el.addEventListener('wheel', (e: Event) => {
       if (document.activeElement === el) e.preventDefault();
     }, { passive: false });
   });

  recordContent.querySelectorAll('.field-row').forEach(row => {
    const fid = (row as HTMLElement).dataset.fieldId;
    if (!fid) return;
    const field = fields.find(f => f.id === fid);
    if (!field) return;
    const record = records[currentIndex];
    const rawValue = record.fields[fid];
    if (Array.isArray(rawValue) && rawValue.length > 0 && rawValue[0] && rawValue[0].type === 'text') {
      textSegmentFieldIds.add(fid);
    }
  });
  // select
  recordContent.querySelectorAll('.field-select.field-input').forEach(el => {
    el.addEventListener('change', (e) => {
      const t = e.target as HTMLSelectElement;
      const fid = t.dataset.fieldId!;
      const opt = fieldOptionsCache[fid]?.find(o => o.id === t.value);
      modifiedFields[fid] = opt ? { id: opt.id, text: opt.name } : null;
      updateSaveBtn();
    });
  });

  // 多选复选框组
  recordContent.querySelectorAll('.field-checkbox-group.field-input').forEach(group => {
    const hg = group as HTMLElement;
    const cbs = hg.querySelectorAll('.field-checkbox');
    cbs.forEach(cb => {
      cb.addEventListener('change', () => {
        const fid = hg.dataset.fieldId!;
        const sel: { id: string; text: string }[] = [];
        cbs.forEach((b: Element) => {
          const inp = b as HTMLInputElement;
          if (inp.checked) {
            const opt = fieldOptionsCache[fid]?.find(o => o.id === inp.value);
            if (opt) sel.push({ id: opt.id, text: opt.name });
          }
        });
        modifiedFields[fid] = sel;
        updateSaveBtn();
      });
    });
  });

  // 单复选框
  recordContent.querySelectorAll('.field-input[data-field-type="checkbox"]').forEach(el => {
    const hc = el as HTMLElement;
    const cb = hc.querySelector('.field-checkbox') as HTMLInputElement;
    if (!cb) return;
    cb.addEventListener('change', () => {
      modifiedFields[hc.dataset.fieldId!] = cb.checked;
      updateSaveBtn();
    });
  });

  // 普通 input / textarea（只有带 .field-input class 的才处理）
  recordContent.querySelectorAll('input.field-input, textarea.field-input').forEach(el => {
    const inp = el as HTMLInputElement | HTMLTextAreaElement;
    if (inp.type === 'datetime-local') {
      inp.addEventListener('change', () => {
        modifiedFields[inp.dataset.fieldId!] = new Date(inp.value).getTime();
        updateSaveBtn();
      });
    } else {
      inp.addEventListener('input', () => {
        const fid = inp.dataset.fieldId!;
        if (textSegmentFieldIds.has(fid)) {
          // 文本字段用 IOpenSegment[] 格式保存
          modifiedFields[fid] = [{ type: 'text', text: inp.value }];
        } else {
          modifiedFields[fid] = inp.value;
        }
        updateSaveBtn();
      });
    }
  });
}

function updateSaveBtn() {
  const hasChanges = Object.keys(modifiedFields).length > 0;
  saveBtn.disabled = !hasChanges || isSaving;
  undoBtn.disabled = !hasChanges;
}

// ── 导航 ──────────────────────────────────────────
prevBtn.addEventListener('click', async () => {
  if (currentIndex > 0) { await saveIfModified(); currentIndex--; modifiedFields = {}; updateNavButtons(); renderCurrentRecord(); locateRecord(records[currentIndex]); }
});
nextBtn.addEventListener('click', async () => {
  if (currentIndex < records.length - 1) { await saveIfModified(); currentIndex++; modifiedFields = {}; updateNavButtons(); renderCurrentRecord(); locateRecord(records[currentIndex]); }
});
recordIndex.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    const target = parseInt(recordIndex.value);
    if (!isNaN(target) && target >= 1 && target <= records.length && target !== currentIndex + 1) {
      await saveIfModified();
      currentIndex = target - 1;
      modifiedFields = {};
      updateNavButtons();
      renderCurrentRecord();
      locateRecord(records[currentIndex]);
    } else {
      // 无效输入恢复原值
      recordIndex.value = String(currentIndex + 1);
    }
  }
});
saveBtn.addEventListener('click', async () => { await saveIfModified(); });

// ── 保存 ──────────────────────────────────────────
async function saveIfModified() {
  if (Object.keys(modifiedFields).length === 0 || isSaving) return;

  isSaving = true;
  saveBtn.textContent = '保存中...';
  saveBtn.classList.add('saving');

  try {
    const record = records[currentIndex];
    console.log('currentTable:', !!currentTable, 'recordId:', record.recordId);
    console.log('modifiedFields before filter:', JSON.stringify(modifiedFields));

    const writableFields: Record<string, any> = {};
    for (const fid of Object.keys(modifiedFields)) {
      const field = fields.find(f => f.id === fid);
      if (!field) { console.log('字段未找到, fid:', fid); continue; }
      const isRO = isFieldReadonly(field, record.fields[fid]);
      console.log('字段:', field.name, 'type:', field.type, 'isReadonly:', isRO, 'modifiedValue:', JSON.stringify(modifiedFields[fid]));
      if (!isRO) writableFields[fid] = modifiedFields[fid];
    }

    if (Object.keys(writableFields).length === 0) {
      console.log('所有修改字段均为只读，跳过保存');
      modifiedFields = {};
      isSaving = false;
      saveBtn.textContent = '保存';
      saveBtn.classList.remove('saving');
      updateSaveBtn();
      return;
    }

    console.log('实际保存字段:', JSON.stringify(writableFields));
    const result = await currentTable.setRecord(record.recordId, { fields: writableFields });
    console.log('setRecord 返回:', result);

    for (const key of Object.keys(writableFields)) {
      record.fields[key] = writableFields[key];
    }
    modifiedFields = {};
    console.log('保存成功');
  } catch (error) {
    console.error('保存失败:', error);
    alert('保存失败: ' + (error instanceof Error ? error.message : '未知错误'));
  } finally {
    isSaving = false;
    saveBtn.textContent = '保存';
    saveBtn.classList.remove('saving');
    updateSaveBtn();
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
    if (sel.recordId && records.length > 0) {
      const idx = records.findIndex(r => r.recordId === sel.recordId);
      if (idx >= 0 && idx !== currentIndex) {
        await saveIfModified();
        currentIndex = idx; modifiedFields = {};
        updateNavButtons(); renderCurrentRecord();
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