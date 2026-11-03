import {
  FType, FieldMeta, FieldOption, RecordData,
  cleanUrl, segmentsToText, findUrlInSegments, extractUrlFromValue, hasNewlines,
  isUrl, esc, detectUrlType, renderUrlPreview, isFramebuster,
} from './common';
import { describeError } from './errors';
import { showPreviewNote } from './common';
import { autosizeTextarea, trackManualResize, installLineSelectAll } from './textarea';

const READONLY_TYPES = new Set([
  FType.URL, FType.FORMULA, FType.SINGLE_LINK, FType.DUPLEX_LINK,
  FType.ATTACHMENT, FType.AUTO_NUMBER, FType.LOCATION, FType.OBJECT,
  FType.USER, FType.GROUP_CHAT,
]);

export const FIELD_DRAG_TYPE = 'application/x-annotator-field';

export interface AnnotatorOptions {
  // URL 字段下方是否渲染预览
  urlPreview: boolean;
  // 字段标签可拖出（双栏面板里拖到预览窗格展示）
  draggableFields?: boolean;
  onNavigate(index: number): void;
  onRefresh(): void;
  saveRecord(recordId: string, fields: Record<string, any>): Promise<void>;
}

export interface ShowRecordArgs {
  fields: FieldMeta[];
  options: Record<string, FieldOption[]>;
  record: RecordData;
  index: number;
  total: number;
}

// 编辑区（页头导航 + 字段编辑 + 保存/撤销）。
// 依赖页面里已有的 #recordContent / #prevBtn / #nextBtn / #recordJump / #totalCount /
// #saveBtn / #undoBtn / #refreshBtn；数据读写全部交给 options 里的回调。
export function createAnnotatorUI(opts: AnnotatorOptions) {
  const recordContent = document.getElementById('recordContent')!;
  const prevBtn = document.getElementById('prevBtn') as HTMLButtonElement;
  const nextBtn = document.getElementById('nextBtn') as HTMLButtonElement;
  const recordIndex = document.getElementById('recordJump') as HTMLInputElement;
  const totalCount = document.getElementById('totalCount') as HTMLSpanElement;
  const saveBtn = document.getElementById('saveBtn') as HTMLButtonElement;
  const undoBtn = document.getElementById('undoBtn') as HTMLButtonElement;
  const refreshBtn = document.getElementById('refreshBtn') as HTMLButtonElement;

  let fields: FieldMeta[] = [];
  let options: Record<string, FieldOption[]> = {};
  let record: RecordData | null = null;
  let currentIndex = 0;
  let total = 0;
  let modifiedFields: Record<string, any> = {};
  let isSaving = false;
  let hiddenFields = new Set<string>();
  // 上一次渲染到 DOM 的数据指纹：数据没变就不重建 DOM，避免预览的视频 / iframe 被重载、未保存输入被清掉
  let renderedSignature = '';

  function signatureOf(rec: RecordData): string {
    return JSON.stringify([rec.recordId, rec.fields, fields, options]);
  }

  // ── 只读判断 ────────────────────────────────────
  function isFieldReadonly(field: FieldMeta, rawValue: any): boolean {
    if (fields.length > 0 && field.id === fields[0].id) return true;
    if (READONLY_TYPES.has(field.type)) return true;
    if (field.type === FType.TEXT && Array.isArray(rawValue)) {
      return rawValue.some((seg: any) => seg && seg.type === 'url');
    }
    return false;
  }

  // ── 渲染 ────────────────────────────────────────
  function showMessage(kind: 'loading' | 'empty' | 'error', text: string) {
    record = null;
    modifiedFields = {};
    renderedSignature = '';
    if (kind === 'loading') recordContent.innerHTML = `<div class="loading">${esc(text || '加载中...')}</div>`;
    else if (kind === 'empty') recordContent.innerHTML = `<div class="empty-state"><p>${esc(text)}</p></div>`;
    else recordContent.innerHTML = `<div class="error-message">${esc(text)}</div>`;
    prevBtn.disabled = nextBtn.disabled = saveBtn.disabled = undoBtn.disabled = true;
  }

  function showRecord(args: ShowRecordArgs) {
    fields = args.fields;
    options = args.options;
    record = args.record;
    currentIndex = args.index;
    total = args.total;
    updateNavButtons();
    const signature = signatureOf(args.record);
    if (signature === renderedSignature) return;
    renderedSignature = signature;
    modifiedFields = {};
    renderCurrentRecord();
  }

  function updateNavButtons() {
    prevBtn.disabled = currentIndex <= 0;
    nextBtn.disabled = currentIndex >= total - 1;
    recordIndex.disabled = total === 0;
    recordIndex.max = String(total);
    recordIndex.value = total > 0 ? String(currentIndex + 1) : '0';
    totalCount.textContent = `/ ${total}`;
  }

  function renderCurrentRecord() {
    if (!record) return;
    const current = record;
    const fieldsHtml = fields.map(field => {
      const value = current.fields[field.id];
      const ctrl = renderFieldControl(field, value);
      return `<div class="field-row" data-field-id="${field.id}">
      <div class="field-label"${opts.draggableFields ? ' draggable="true" title="拖到预览窗格展示"' : ''}>${esc(field.name)}</div>
      <div class="field-value">${ctrl}</div>
    </div>`;
    }).join('');

    recordContent.innerHTML = `<div class="record-fields">${fieldsHtml}</div>`;
    hydrateFramePreviews();
    applyHiddenFields();
    attachFieldListeners();
    setupTextareas();
    updateSaveBtn();
  }

  // 多行文本框：高度随内容撑开、分两步的 Ctrl+A、手动拖拽后不再自动撑开
  function setupTextareas() {
    recordContent.querySelectorAll('textarea').forEach(el => {
      const ta = el as HTMLTextAreaElement;
      installLineSelectAll(ta);
      trackManualResize(ta);
      ta.addEventListener('input', () => autosizeTextarea(ta));
    });
    autosizeAllTextareas();
  }

  function autosizeAllTextareas() {
    recordContent.querySelectorAll('textarea').forEach(el => autosizeTextarea(el as HTMLTextAreaElement));
  }

  // 隐藏的字段（已被拖到预览窗格展示）只切换可见性，不重渲染，保留其他字段里未保存的输入
  function applyHiddenFields() {
    recordContent.querySelectorAll<HTMLElement>('.field-row').forEach(row => {
      row.hidden = hiddenFields.has(row.dataset.fieldId || '');
    });
  }

  function setHiddenFields(ids: Set<string>) {
    hiddenFields = ids;
    applyHiddenFields();
    autosizeAllTextareas(); // 刚显示出来的字段此前是隐藏的，量不出高度
  }

  // 容器尺寸变化（拖分隔条、缩放、改窗口大小）会改变折行和高度上限，需要重新计算
  new ResizeObserver(() => autosizeAllTextareas()).observe(recordContent);

  // ── 字段控件分发 ────────────────────────────────
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

  function urlPreviewHtml(url: string): string {
    if (!opts.urlPreview) return '';
    const type = detectUrlType(url);
    if (type === 'webpage') {
      // 已知会破框的网站：不渲染预览区，改在字段块右上角写一句说明（占位元素，渲染后由 hydrateFramePreviews 处理）
      if (isFramebuster(url)) return `<span hidden data-preview-note="该站点不支持嵌入，无法预览" data-preview-title="这个站点嵌入后会反复触发登录重载，所以不渲染预览，可以直接点开链接查看"></span>`;
      // 先隐藏，等服务端检查完“能不能被嵌入”再决定显示还是移除（见 hydrateFramePreviews）
      return `<div class="url-preview" hidden data-frame-url="${esc(url)}"></div>`;
    }
    const inner = renderUrlPreview(url, type);
    return inner ? `<div class="url-preview">${inner}</div>` : '';
  }

  // 网页预览：向服务端询问这个网页是否禁止被嵌入（X-Frame-Options / CSP frame-ancestors）。
  // 确定禁止的就不显示；查不出来（服务端连不上、没有这个接口）按“可以嵌入”处理，不影响原有行为
  const embeddableCache = new Map<string, Promise<{ ok: boolean; reason: string }>>();
  function checkEmbeddable(url: string): Promise<{ ok: boolean; reason: string }> {
    let p = embeddableCache.get(url);
    if (!p) {
      p = fetch(new URL('api/frame-check?url=' + encodeURIComponent(url), location.href).href)
        .then(r => (r.ok ? r.json() : null))
        .then(d => ({ ok: !(d && d.embeddable === false), reason: (d && d.reason) || '' }))
        .catch(() => ({ ok: true, reason: '' }));
      embeddableCache.set(url, p);
    }
    return p;
  }

  function hydrateFramePreviews() {
    recordContent.querySelectorAll<HTMLElement>('.url-preview[data-frame-url]').forEach(box => {
      const url = box.dataset.frameUrl || '';
      checkEmbeddable(url).then(({ ok, reason }) => {
        if (!box.isConnected) return; // 已经切到别的记录
        if (ok) {
          box.innerHTML = renderUrlPreview(url, 'webpage');
          box.hidden = false;
        } else {
          showPreviewNote(box, '该网页禁止被嵌入，无法预览', `网页的响应头禁止被嵌入（${reason}），所以不渲染预览，可以直接点开链接查看`);
        }
      });
    });
    // 已知不渲染的站点：把说明写到字段块右上角
    recordContent.querySelectorAll<HTMLElement>('span[data-preview-note]').forEach(el => {
      showPreviewNote(el, el.dataset.previewNote || '', el.dataset.previewTitle || '');
    });
  }

  // ── 控件渲染 ────────────────────────────────────
  function renderSingleSelect(field: FieldMeta, rawValue: any): string {
    const fieldOptions = options[field.id] || [];
    let sid = '';
    if (rawValue && typeof rawValue === 'object') sid = (rawValue as any).id || '';
    const ro = isFieldReadonly(field, rawValue);
    let h = `<select class="field-select${ro ? '' : ' field-input'}" data-field-id="${field.id}"${ro ? ' disabled' : ''}>`;
    h += `<option value="">— 请选择 —</option>`;
    for (const o of fieldOptions) {
      h += `<option value="${esc(o.id)}"${o.id === sid ? ' selected' : ''}>${esc(o.name)}</option>`;
    }
    h += '</select>';
    return h;
  }

  function renderMultiSelect(field: FieldMeta, rawValue: any): string {
    const fieldOptions = options[field.id] || [];
    const sids = new Set<string>();
    if (Array.isArray(rawValue)) rawValue.forEach((v: any) => { if (v && v.id) sids.add(v.id); });
    const ro = isFieldReadonly(field, rawValue);
    let h = `<div class="field-checkbox-group${ro ? '' : ' field-input'}" data-field-id="${field.id}" data-field-type="multiSelect">`;
    for (const o of fieldOptions) {
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
    const prev = isUrl(url) ? urlPreviewHtml(url) : '';
    return `<input type="url" data-field-id="${field.id}" value="${esc(url)}" readonly />${prev}`;
  }

  function renderFormulaField(field: FieldMeta, rawValue: any): string {
    const text = segmentsToText(rawValue);
    const prev = isUrl(text) ? urlPreviewHtml(text) : '';
    return `<input type="text" data-field-id="${field.id}" value="${esc(text)}" readonly />${prev}`;
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
      return `<input type="text" data-field-id="${field.id}" value="${esc(urlToRender)}" readonly />${urlPreviewHtml(urlToRender)}`;
    }

    // 飞书“文本”类型一律用多行输入框：没有换行时高度与单行输入框一致，值里有换行（或输入了换行）才撑高，见 shared/textarea.ts。
    // 其他类型（电话、邮箱等）没有换行时仍用单行输入框
    if (field.type === FType.TEXT || hasNewlines(rawValue)) {
      // 飞书文本末尾自带换行，去掉它，否则会多出一个空行、单行文本也会被当成两行
      const shown = textVal.replace(/[\r\n]+$/, '');
      return `<textarea class="${ro ? '' : 'field-input'}" data-field-id="${field.id}" data-field-type="text" rows="1" wrap="off"${ro ? ' readonly' : ''}>${esc(shown)}</textarea>`;
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
      if (!fid || !record) return;
      const field = fields.find(f => f.id === fid);
      if (!field) return;
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
        const opt = options[fid]?.find(o => o.id === t.value);
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
              const opt = options[fid]?.find(o => o.id === inp.value);
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

  // ── 保存 ────────────────────────────────────────
  async function saveIfModified() {
    if (!record || Object.keys(modifiedFields).length === 0 || isSaving) return;
    const target = record;

    isSaving = true;
    saveBtn.textContent = '保存中...';
    saveBtn.classList.add('saving');

    try {
      const writableFields: Record<string, any> = {};
      for (const fid of Object.keys(modifiedFields)) {
        const field = fields.find(f => f.id === fid);
        if (!field) continue;
        if (!isFieldReadonly(field, target.fields[fid])) writableFields[fid] = modifiedFields[fid];
      }

      if (Object.keys(writableFields).length > 0) {
        await opts.saveRecord(target.recordId, writableFields);
        Object.assign(target.fields, writableFields);
        // 界面上已经是用户改好的内容，随后同步回来的相同数据不必重画
        if (record && record.recordId === target.recordId) renderedSignature = signatureOf(record);
      }
      modifiedFields = {};
    } catch (error) {
      console.error('保存失败:', error);
      alert('保存失败：' + describeError(error, 'write'));
    } finally {
      isSaving = false;
      saveBtn.textContent = '保存';
      saveBtn.classList.remove('saving');
      updateSaveBtn();
    }
  }

  // ── 字段标签拖出 ────────────────────────────────
  recordContent.addEventListener('dragstart', (e) => {
    const label = (e.target as HTMLElement).closest?.('.field-label[draggable]');
    const fid = (label?.closest('.field-row') as HTMLElement | null)?.dataset.fieldId;
    if (!fid || !e.dataTransfer) return;
    e.dataTransfer.setData(FIELD_DRAG_TYPE, fid);
    e.dataTransfer.effectAllowed = 'copyMove';
    document.body.classList.add('dragging-field');
  });
  recordContent.addEventListener('dragend', () => document.body.classList.remove('dragging-field'));

  // ── 页头 / 页脚按钮 ─────────────────────────────
  undoBtn.addEventListener('click', () => {
    if (Object.keys(modifiedFields).length === 0) return;
    modifiedFields = {};
    renderCurrentRecord();
  });

  refreshBtn.addEventListener('click', () => {
    if (!isSaving) opts.onRefresh();
  });

  prevBtn.addEventListener('click', async () => {
    if (currentIndex > 0) { await saveIfModified(); opts.onNavigate(currentIndex - 1); }
  });
  nextBtn.addEventListener('click', async () => {
    if (currentIndex < total - 1) { await saveIfModified(); opts.onNavigate(currentIndex + 1); }
  });
  recordIndex.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const target = parseInt(recordIndex.value);
    if (!isNaN(target) && target >= 1 && target <= total && target !== currentIndex + 1) {
      await saveIfModified();
      opts.onNavigate(target - 1);
    } else {
      // 无效输入恢复原值
      recordIndex.value = String(currentIndex + 1);
    }
  });
  saveBtn.addEventListener('click', () => { saveIfModified(); });

  return {
    showMessage,
    showRecord,
    saveIfModified,
    setHiddenFields,
    isSaving: () => isSaving,
  };
}
