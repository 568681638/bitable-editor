import { describeError, describedError } from './errors';
import { FieldMeta, FieldOption, RecordData, esc } from './common';
import { buildPreviewHtml } from './preview-page';
import { WRITABLE_TYPES, FIELD_TYPE_NAMES, needsOptions, toFieldValue } from './field-value';

// ── 自动刷写面板：筛选记录 → 取输入字段调用后端函数 → 把输出写回字段 ──────────
// 函数由后端注册（release/server/functions/ 目录下的 .mjs / .py，热加载），这里只通过 /api/functions 读元信息、批量调用

export interface AutoFlushHost {
  /** 选择类字段的全部选项（单选、多选写入时用来把名字换成选项 ID） */
  getFieldOptions(fieldId: string): Promise<FieldOption[]>;
  /** 当前视图可见的字段（预览 / 导出 CSV 的列） */
  getFields(): FieldMeta[];
  /** 数据表的全部字段，含视图里隐藏的（各处“选择字段”的下拉用它） */
  getAllFields(): FieldMeta[];
  getTableId(): string;
  /** 取当前视图的全部记录（顺序与视图一致） */
  loadAllRecords(onProgress: (done: number, total: number) => void): Promise<RecordData[]>;
  /** 批量写回 */
  writeRecords(items: { recordId: string; fields: Record<string, any> }[]): Promise<void>;
}

interface ParamMeta { name: string; label?: string; requires?: string[] }
interface FnMeta { id: string; name: string; inputs: ParamMeta[]; outputs: ParamMeta[] }

type Cond = { kind: 'cond'; fieldId: string; op: string; value: string; sep?: string; customSep?: string };
type Group = { kind: 'group'; logic: 'and' | 'or'; negate: boolean; children: (Cond | Group)[] };
type Mapping = { param: string; fieldId: string };
interface Config { filter: Group; inputs: Mapping[]; outputs: Mapping[] }

const OPS: [string, string][] = [
  ['eq', '等于'], ['ne', '不等于'], ['contains', '包含'], ['notContains', '不包含'],
  ['in', '包含于'], ['notIn', '不包含于'], ['startsWith', '开头是'], ['endsWith', '结尾是'], ['regex', '匹配正则'],
  ['gt', '大于'], ['gte', '大于等于'], ['lt', '小于'], ['lte', '小于等于'],
  ['empty', '为空'], ['notEmpty', '不为空'],
];
const NO_VALUE_OPS = new Set(['empty', 'notEmpty']);
const LIST_OPS = new Set(['in', 'notIn']);
// 包含于/不包含于的拆分符，默认英文逗号
const SEPS: [string, string][] = [[',', '英文逗号 ,'], ['\n', '换行']];
const DEFAULT_SEP = ',';
const CUSTOM_SEP = '__custom__'; // sep 取这个值时，用 customSep 作为拆分符
const CALL_BATCH = 100; // 每批调用函数并写回的记录数（函数是批量接口，一批一次请求）

const emptyGroup = (): Group => ({ kind: 'group', logic: 'and', negate: false, children: [] });
const newConfig = (): Config => ({ filter: emptyGroup(), inputs: [], outputs: [] });

// ── 单元格值 → 文本，供筛选和函数入参使用 ─────────
function cellText(value: any): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map(v => (v && typeof v === 'object' ? (v.text ?? v.name ?? v.link ?? '') : String(v))).join(value.some(v => v && v.type) ? '' : ',');
  }
  if (typeof value === 'object') return String(value.text ?? value.name ?? value.link ?? '');
  return String(value);
}

// 多选字段按选项逐个判断，其余字段按整个文本判断
function cellItems(value: any): string[] {
  if (Array.isArray(value) && value.length && value.every(v => v && typeof v === 'object' && !v.type)) {
    return value.map(v => String(v.text ?? v.name ?? '').trim());
  }
  return [cellText(value).trim()];
}

// 值按所选拆分符拆成列表，去掉首尾空白和空项
const splitList = (v: string, sep: string) =>
  (sep === '\n' ? v.split(/\r?\n/) : sep === '' ? [v] : v.split(sep)).map(x => x.trim()).filter(Boolean);

function evalCond(c: Cond, rec: RecordData): boolean {
  if (!c.fieldId) return true; // 还没选字段的条件不参与筛选
  const text = cellText(rec.fields[c.fieldId]);
  const v = c.value;
  switch (c.op) {
    case 'eq': return text === v;
    case 'ne': return text !== v;
    case 'contains': return text.includes(v);
    case 'notContains': return !text.includes(v);
    case 'in': case 'notIn': {
      const list = new Set(splitList(v, c.sep === CUSTOM_SEP ? (c.customSep ?? '') : c.sep || DEFAULT_SEP));
      const hit = cellItems(rec.fields[c.fieldId]).some(x => list.has(x));
      return c.op === 'in' ? hit : !hit;
    }
    case 'startsWith': return text.startsWith(v);
    case 'endsWith': return text.endsWith(v);
    case 'regex': try { return new RegExp(v).test(text); } catch { return false; }
    case 'gt': case 'gte': case 'lt': case 'lte': {
      const a = Number(text), b = Number(v);
      const cmp = text.trim() !== '' && v.trim() !== '' && !isNaN(a) && !isNaN(b) ? a - b : text.localeCompare(v);
      return c.op === 'gt' ? cmp > 0 : c.op === 'gte' ? cmp >= 0 : c.op === 'lt' ? cmp < 0 : cmp <= 0;
    }
    case 'empty': return text.trim() === '';
    case 'notEmpty': return text.trim() !== '';
  }
  return true;
}

function evalGroup(g: Group, rec: RecordData): boolean {
  let result = true;
  if (g.children.length > 0) {
    const results = g.children.map(ch => (ch.kind === 'group' ? evalGroup(ch, rec) : evalCond(ch, rec)));
    result = g.logic === 'and' ? results.every(Boolean) : results.some(Boolean);
  }
  return g.negate ? !result : result;
}

function checkRegexes(g: Group): string | null {
  for (const ch of g.children) {
    if (ch.kind === 'group') { const e = checkRegexes(ch); if (e) return e; }
    else if (ch.op === 'regex') { try { new RegExp(ch.value); } catch { return `正则表达式无效：${ch.value}`; } }
  }
  return null;
}

function apiUrl(path: string) {
  return new URL(path, location.href).href;
}

// 后端出错时返回 { error: '原因' }，优先把原因带给用户；读不出来再退回状态码
async function serverMessage(res: Response): Promise<string> {
  try {
    const data = await res.json();
    if (data && typeof data.error === 'string' && data.error) return data.error;
  } catch { /* 不是 JSON */ }
  if (res.status === 404) return '后端没有这个接口（服务可能还没更新到最新版本）';
  return `HTTP ${res.status}`;
}

export function createAutoFlush(container: HTMLElement, host: AutoFlushHost, runBtn?: HTMLButtonElement, filterBtn?: HTMLButtonElement) {
  let fns: FnMeta[] = [];
  let fnState: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
  let fnError = '';
  let config = newConfig();
  let configTable = '';
  let running = false;
  let exporting = false; // 正在读取全部记录做筛选 / 导出（期间不能刷写）
  // 最近一次筛选的结果：只记条数和当时的条件签名，条件改了就判定为过期
  let filterResult: { sig: string; matched: number; total: number } | null = null;
  // 最近一次刷写中失败的行（含当时送给函数的输入），供展开查看 / 复制 / 导出
  let failures: { index: number; recordId: string; inputs: string[]; error: string }[] = [];
  let failureHeaders: string[] = [];
  let failOpen = false;
  let cancelled = false;
  let statusText = '';
  let statusKind: '' | 'error' | 'ok' = '';

  // ── 配置按表格存取 ──────────────────────────────
  const storeKey = () => `annotator-auto-flush:${host.getTableId()}`;
  function loadConfig() {
    const tableId = host.getTableId();
    if (tableId === configTable) return;
    configTable = tableId;
    try { config = { ...newConfig(), ...JSON.parse(localStorage.getItem(storeKey()) || '{}') }; } catch { config = newConfig(); }
    migrateSeps(config.filter);
  }

  // 以前内置过的其他拆分符（中文逗号、顿号、分号）已改为自定义，保留旧条件的行为
  function migrateSeps(g: Group) {
    for (const ch of g.children) {
      if (ch.kind === 'group') migrateSeps(ch);
      else if (ch.sep && ch.sep !== CUSTOM_SEP && !SEPS.some(([v]) => v === ch.sep)) { ch.customSep = ch.sep; ch.sep = CUSTOM_SEP; }
    }
  }
  const saveConfig = () => { try { localStorage.setItem(storeKey(), JSON.stringify(config)); } catch { /* ignore */ } };

  // ── 函数元信息 ──────────────────────────────────
  // silent：已经有函数列表时静默重读（后端热加载了新函数），不闪“加载中”
  async function loadFunctions(silent = false) {
    if (!silent) { fnState = 'loading'; render(); }
    try {
      const res = await fetch(apiUrl('api/functions'));
      if (!res.ok) throw new Error(`后端服务返回错误：${await serverMessage(res)}`);
      fns = await res.json();
      fnState = 'ready';
    } catch (e) {
      if (silent) return; // 静默刷新失败就沿用旧列表
      fnState = 'error';
      fnError = describeError(e, 'read');
    }
    if (!running) render();
  }

  const outputKey = (fn: FnMeta, o: ParamMeta) => `${fn.id}.${o.name}`;
  function findOutput(key: string): { fn: FnMeta; out: ParamMeta } | null {
    for (const fn of fns) for (const out of fn.outputs) if (outputKey(fn, out) === key) return { fn, out };
    return null;
  }
  function requiredInputs(key: string): string[] {
    const hit = findOutput(key);
    return hit ? (hit.out.requires || hit.fn.inputs.map(i => i.name)) : [];
  }
  function inputLabel(name: string): string {
    for (const fn of fns) { const p = fn.inputs.find(i => i.name === name); if (p) return p.label || p.name; }
    return name;
  }
  // 选了出参后，把它需要、但输入区还没有的入参自动补上
  function ensureInputs() {
    for (const o of config.outputs) {
      for (const name of requiredInputs(o.param)) {
        if (!config.inputs.some(i => i.param === name)) config.inputs.push({ param: name, fieldId: '' });
      }
    }
  }
  const lockedInputs = () => new Set(config.outputs.flatMap(o => requiredInputs(o.param)));

  // ── 渲染 ────────────────────────────────────────
  function fieldOptions(selected: string, only?: (f: FieldMeta) => boolean) {
    // 列出数据表的全部字段（含视图里隐藏的），平铺不分组。
    // 顺序：先按视图里显示的从左到右（和表格里看到的一致），再接上视图里隐藏的（数据表原始顺序）
    const visible = host.getFields();
    const visibleIds = new Set(visible.map(f => f.id));
    const ordered = [...visible, ...host.getAllFields().filter(f => !visibleIds.has(f.id))];
    const list = ordered.filter(f => !only || only(f));
    const stale = selected && !list.some(f => f.id === selected);
    const body = list.map(f => `<option value="${esc(f.id)}"${f.id === selected ? ' selected' : ''}>${esc(f.name)}</option>`).join('');
    return `<option value="">选择字段</option>` +
      (stale ? `<option value="${esc(selected)}" selected>（字段已不存在）</option>` : '') + body;
  }

  function renderNode(node: Cond | Group, path: number[]): string {
    const p = path.join('.');
    if (node.kind === 'cond') {
      return `<div class="af-cond" data-path="${p}">
        <select data-act="cond-field">${fieldOptions(node.fieldId)}</select>
        <select data-act="cond-op">${OPS.map(([v, l]) => `<option value="${v}"${v === node.op ? ' selected' : ''}>${l}</option>`).join('')}</select>
        ${NO_VALUE_OPS.has(node.op) ? ''
          : LIST_OPS.has(node.op) ? `<textarea data-act="cond-value" rows="1" placeholder="多个值用所选拆分符分隔">${esc(node.value)}</textarea>`
          : `<input data-act="cond-value" type="text" value="${esc(node.value)}" placeholder="值" />`}
        <button class="af-x" data-act="del" title="删除条件">×</button>
        ${LIST_OPS.has(node.op) ? `<div class="af-seps"><span>拆分符</span>${SEPS.map(([v, l]) =>
          `<label><input type="radio" name="sep-${p}" data-act="cond-sep" value="${esc(v)}"${v === (node.sep || DEFAULT_SEP) ? ' checked' : ''} />${l}</label>`).join('')}
          <label><input type="radio" name="sep-${p}" data-act="cond-sep" value="${CUSTOM_SEP}"${node.sep === CUSTOM_SEP ? ' checked' : ''} />自定义<input type="text" class="af-sep-custom" data-act="cond-sep-custom" value="${esc(node.customSep ?? '')}" placeholder="如 、" /></label></div>` : ''}
      </div>`;
    }
    return `<div class="af-group" data-path="${p}">
      <div class="af-group-head">
        <select data-act="logic"><option value="and"${node.logic === 'and' ? ' selected' : ''}>满足全部（且）</option><option value="or"${node.logic === 'or' ? ' selected' : ''}>满足任一（或）</option></select>
        <label class="af-neg"><input type="checkbox" data-act="negate"${node.negate ? ' checked' : ''} />取反</label>
        ${path.length ? '<button class="af-x af-x-group" data-act="del" title="删除整个条件组（包含组内所有条件）">×</button>' : ''}
      </div>
      <div class="af-children">${node.children.map((ch, i) => renderNode(ch, [...path, i])).join('')}</div>
      <div class="af-group-add">
        <button class="af-add" data-act="add-cond">＋ 条件</button>
        <button class="af-add" data-act="add-group">＋ 条件组</button>
      </div>
    </div>`;
  }

  function renderInputs() {
    const locked = lockedInputs();
    const names = [...new Set(fns.flatMap(f => f.inputs.map(i => i.name)))];
    return config.inputs.map((m, i) => `<div class="af-row" data-list="inputs" data-idx="${i}">
      <select data-act="param">
        <option value="">选择参数</option>
        ${names.map(n => `<option value="${esc(n)}"${n === m.param ? ' selected' : ''}>${esc(inputLabel(n))}（${esc(n)}）</option>`).join('')}
      </select>
      <span class="af-arrow">←</span>
      <select data-act="field">${fieldOptions(m.fieldId)}</select>
      ${locked.has(m.param) ? '<span class="af-lock" title="已选的输出需要这个输入">必需</span>' : '<button class="af-x" data-act="del" title="删除">×</button>'}
    </div>`).join('');
  }

  function renderOutputs() {
    return config.outputs.map((m, i) => `<div class="af-row" data-list="outputs" data-idx="${i}">
      <select data-act="param">
        <option value="">选择参数</option>
        ${fns.map(fn => `<optgroup label="${esc(fn.name)}">${fn.outputs.map(o => `<option value="${esc(outputKey(fn, o))}"${outputKey(fn, o) === m.param ? ' selected' : ''}>${esc(o.label || o.name)}</option>`).join('')}</optgroup>`).join('')}
      </select>
      <span class="af-arrow">→</span>
      <select data-act="field">${fieldOptions(m.fieldId)}</select>
      <button class="af-x" data-act="del" title="删除">×</button>
    </div>`).join('');
  }

  function render() {
    loadConfig();
    const keepScroll = container.scrollTop;
    let body: string;
    if (fnState === 'loading' || fnState === 'idle') {
      body = '<div class="af-hint">正在加载函数列表…</div>';
    } else if (fnState === 'error') {
      body = `<div class="af-hint af-err">函数列表加载失败：${esc(fnError)}<br /><button class="af-add" data-act="reload-fns">重试</button></div>`;
    } else if (fns.length === 0) {
      body = '<div class="af-hint">后端还没有注册任何函数（在服务器的 release/server/functions/ 目录里添加）</div>';
    } else {
      body = `
        <section class="af-sec"><h4 class="af-h"><span>筛选 <span class="af-count"></span></span><span class="af-h-actions"><button class="af-add" data-act="preview-filtered" title="在悬浮窗口里查看符合筛选条件的记录（全部可见字段）"${running || exporting ? ' disabled' : ''}>预览结果</button><button class="af-add" data-act="export-filtered" title="把视图里符合筛选条件的记录（全部可见字段）导出为 CSV"${running || exporting ? ' disabled' : ''}>导出 CSV</button></span></h4>${renderNode(config.filter, [])}<div class="af-filter-io"><button class="af-link" data-act="filter-import" title="从文件导入筛选条件（会替换当前条件）"${running || exporting ? ' disabled' : ''}>导入条件</button><span>·</span><button class="af-link" data-act="filter-export" title="把当前筛选条件导出为文件，方便复用">导出条件</button></div></section>
        <section class="af-sec"><h4>输入</h4>${renderInputs()}<button class="af-add" data-act="add-input">＋ 输入项</button></section>
        <section class="af-sec"><h4>输出</h4>${renderOutputs()}<button class="af-add" data-act="add-output">＋ 输出项</button></section>
        <div class="af-status${statusKind ? ' ' + statusKind : ''}">${esc(statusText).replace(/\n/g, '<br />')}</div>
        ${renderFailures()}`;
    }
    container.innerHTML = body;
    syncRunBtn();
    updateFilterCount();
    container.scrollTop = keepScroll;
  }

  // ── 失败明细：展开查看、复制、导出 CSV ───────────
  const FAIL_SHOW_LIMIT = 500; // 面板里最多渲染的行数，复制/导出始终包含全部
  function renderFailures(): string {
    if (failures.length === 0) return '';
    const list = failures.slice(0, FAIL_SHOW_LIMIT).map(f =>
      `<div class="af-fail-item">第 ${f.index} 条 <span class="af-fail-id">${esc(f.recordId)}</span><div class="af-fail-err">${esc(f.error)}</div></div>`).join('');
    const more = failures.length > FAIL_SHOW_LIMIT ? `<div class="af-hint">仅显示前 ${FAIL_SHOW_LIMIT} 条，复制 / 导出包含全部 ${failures.length} 条</div>` : '';
    return `<details class="af-fail"${failOpen ? ' open' : ''}>
      <summary>失败明细（${failures.length} 条）</summary>
      <div class="af-fail-actions">
        <button class="af-add" data-act="fail-copy">复制全部</button>
        <button class="af-add" data-act="fail-csv">导出 CSV</button>
        <button class="af-add" data-act="fail-ids">仅复制记录 ID</button>
      </div>
      <div class="af-fail-list">${list}${more}</div>
    </details>`;
  }

  // 表头：序号、记录ID、各输入参数（参数名(字段名)）、失败原因
  function failureTable(): string[][] {
    return [
      ['序号', '记录ID', ...failureHeaders, '失败原因'],
      ...failures.map(f => [String(f.index), f.recordId, ...f.inputs, f.error]),
    ];
  }
  const toTsv = (rows: string[][]) => rows.map(r => r.map(c => c.replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n');
  const toCsv = (rows: string[][]) => rows.map(r => r.map(c => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\r\n');

  async function copyText(text: string) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* 侧边栏 iframe 里可能没有剪贴板权限，走下面的兜底 */ }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) throw new Error('复制失败，请改用“导出 CSV”');
  }

  function saveFile(content: string, prefix: string, ext: string, mime: string, bom = false) {
    const pad = (n: number) => String(n).padStart(2, '0');
    const d = new Date();
    const name = `${prefix}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${ext}`;
    const url = URL.createObjectURL(new Blob([bom ? '\uFEFF' + content : content], { type: `${mime};charset=utf-8` }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // CSV 开头加 BOM，Excel 才不会把中文打开成乱码
  const downloadCsv = (text: string, prefix: string) => saveFile(text, prefix, 'csv', 'text/csv', true);

  async function onFailAction(act: string, btn: HTMLElement) {
    try {
      if (act === 'fail-csv') { downloadCsv(toCsv(failureTable()), '刷写失败行'); return; }
      await copyText(act === 'fail-ids' ? failures.map(f => f.recordId).join('\n') : toTsv(failureTable()));
      const old = btn.textContent;
      btn.textContent = '已复制';
      setTimeout(() => { btn.textContent = old; }, 1500);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  }

  container.addEventListener('toggle', (e) => {
    const el = e.target as HTMLDetailsElement;
    if (el.classList && el.classList.contains('af-fail')) failOpen = el.open;
  }, true);

  // ── 事件 ────────────────────────────────────────
  function nodeAt(path: string): { node: Cond | Group; parent: Group | null; index: number } {
    const idx = path === '' ? [] : path.split('.').map(Number);
    let parent: Group | null = null;
    let node: Cond | Group = config.filter;
    let index = -1;
    for (const i of idx) { parent = node as Group; node = parent.children[i]; index = i; }
    return { node, parent, index };
  }

  container.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button[data-act]') as HTMLElement | null;
    if (!btn) return;
    const act = btn.dataset.act!;
    if (act.startsWith('fail-')) { onFailAction(act, btn); return; }
    const nodeEl = btn.closest('[data-path]') as HTMLElement | null;
    const rowEl = btn.closest('[data-list]') as HTMLElement | null;
    switch (act) {
      case 'add-cond': (nodeAt(nodeEl!.dataset.path!).node as Group).children.push({ kind: 'cond', fieldId: '', op: 'contains', value: '' }); break;
      case 'add-group': (nodeAt(nodeEl!.dataset.path!).node as Group).children.push(emptyGroup()); break;
      case 'del':
        if (rowEl) { config[rowEl.dataset.list as 'inputs' | 'outputs'].splice(Number(rowEl.dataset.idx), 1); }
        else if (nodeEl) { const { parent, index } = nodeAt(nodeEl.dataset.path!); parent?.children.splice(index, 1); }
        break;
      case 'add-input': config.inputs.push({ param: '', fieldId: '' }); break;
      case 'add-output': config.outputs.push({ param: '', fieldId: '' }); break;
      case 'reload-fns': loadFunctions(); return;
      case 'export-filtered': exportFiltered(); return;
      case 'preview-filtered': previewFiltered(); return;
      case 'filter-export': exportFilterConditions(); return;
      case 'filter-import': importFilterConditions(); return;
    }
    saveConfig();
    render();
  });

  container.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement | HTMLTextAreaElement;
    const nodeEl = el.closest('[data-path]') as HTMLElement | null;
    if (!nodeEl) return;
    if (el.dataset.act === 'cond-value') {
      (nodeAt(nodeEl.dataset.path!).node as Cond).value = el.value;
    } else if (el.dataset.act === 'cond-sep-custom') {
      // 往自定义框里输入时，自动选中它前面的单选框
      const cond = nodeAt(nodeEl.dataset.path!).node as Cond;
      cond.customSep = el.value;
      cond.sep = CUSTOM_SEP;
      const radio = el.closest('label')?.querySelector('input[type="radio"]') as HTMLInputElement | null;
      if (radio) radio.checked = true;
    } else return;
    saveConfig();
    updateFilterCount();
  });

  container.addEventListener('change', (e) => {
    const el = e.target as HTMLSelectElement | HTMLInputElement;
    const act = el.dataset.act;
    if (!act || act === 'cond-sep-custom') return;
    const nodeEl = el.closest('[data-path]') as HTMLElement | null;
    const rowEl = el.closest('[data-list]') as HTMLElement | null;
    if (rowEl) {
      const m = config[rowEl.dataset.list as 'inputs' | 'outputs'][Number(rowEl.dataset.idx)];
      if (act === 'param') {
        m.param = el.value;
        if (rowEl.dataset.list === 'outputs') ensureInputs();
      } else if (act === 'field') m.fieldId = el.value;
    } else if (nodeEl) {
      const node = nodeAt(nodeEl.dataset.path!).node;
      if (node.kind === 'cond') {
        if (act === 'cond-field') node.fieldId = el.value;
        else if (act === 'cond-op') node.op = el.value;
        else if (act === 'cond-sep') node.sep = el.value;
      } else if (act === 'logic') node.logic = el.value as 'and' | 'or';
      else if (act === 'negate') node.negate = (el as HTMLInputElement).checked;
    }
    saveConfig();
    render();
  });

  // ── 运行 ────────────────────────────────────────
  function setStatus(text: string, kind: '' | 'error' | 'ok') {
    statusText = text;
    statusKind = kind;
    const el = container.querySelector('.af-status');
    if (el) { el.className = 'af-status' + (kind ? ' ' + kind : ''); el.innerHTML = esc(text).replace(/\n/g, '<br />'); }
  }

  function validate(): string | null {
    const regexErr = checkRegexes(config.filter);
    if (regexErr) return regexErr;
    if (config.outputs.length === 0) return '请至少添加一个输出项';
    for (const o of config.outputs) {
      if (!o.param || !o.fieldId) return '输出项里有未选完整的参数或字段';
      if (!findOutput(o.param)) return `输出参数“${o.param}”已不存在（函数可能被删除），请重新选择`;
      const field = host.getAllFields().find(f => f.id === o.fieldId);
      if (!field) return '输出项里有字段已不存在，请重新选择（可点右上角 ↻ 刷新字段）';
      if (!WRITABLE_TYPES.has(field.type)) {
        return `输出字段“${field.name}”是${FIELD_TYPE_NAMES[field.type] || '当前'}类型，暂不支持写入，目前支持：文本、数字、货币、进度、评分、单选、多选、日期、复选框、电话、邮箱、超链接、人员，请换一个字段`;
      }
    }
    const outFields = config.outputs.map(o => o.fieldId);
    if (new Set(outFields).size !== outFields.length) return '多个输出项写入了同一个字段';
    for (const i of config.inputs) if (!i.param || !i.fieldId) return '输入项里有未选完整的参数或字段';
    const inParams = config.inputs.map(i => i.param);
    if (new Set(inParams).size !== inParams.length) return '同一个输入参数被映射了多次';
    for (const o of config.outputs) {
      for (const name of requiredInputs(o.param)) {
        if (!inParams.includes(name)) return `输出“${findOutput(o.param)?.out.label || o.param}”缺少输入参数“${inputLabel(name)}”`;
      }
    }
    return null;
  }

  // 这里抛出的错误都是已经带上函数名的中文说明，用 describedError 标记，避免被通用翻译二次改写
  async function callFunction(fn: FnMeta, rows: Record<string, any>[]): Promise<{ ok: boolean; outputs?: Record<string, any>; error?: string }[]> {
    const prefix = `函数“${fn.name}”调用失败：`;
    let res: Response;
    try {
      res = await fetch(apiUrl(`api/functions/${encodeURIComponent(fn.id)}/run`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows }),
      });
    } catch (e) {
      throw describedError(prefix + describeError(e, 'read'));
    }
    if (!res.ok) throw describedError(prefix + await serverMessage(res));
    let data: any;
    try { data = await res.json(); } catch { throw describedError(prefix + '后端返回的不是合法数据'); }
    if (!data || !Array.isArray(data.results) || data.results.length !== rows.length) throw describedError(prefix + '返回的结果条数与请求不一致');
    return data.results;
  }

  // ── 底部右侧的“筛选 / 刷写（取消）”按钮（在面板外，由侧边栏页面提供）──
  function syncRunBtn() {
    if (runBtn) {
      runBtn.textContent = running ? '取消' : '刷写';
      runBtn.classList.toggle('cancel', running);
      runBtn.disabled = exporting || (!running && fnState !== 'ready');
    }
    if (filterBtn) filterBtn.disabled = running || exporting || fnState !== 'ready';
  }
  runBtn?.addEventListener('click', () => {
    if (running) { cancelled = true; setStatus('正在取消…', ''); }
    else startRun();
  });
  filterBtn?.addEventListener('click', () => { applyFilter(); });

  // 筛选板块标题旁的命中数：条件改过就提示需要重新筛选
  const filterSig = () => JSON.stringify(config.filter);
  function updateFilterCount() {
    const el = container.querySelector('.af-count') as HTMLElement | null;
    if (!el) return;
    let text = '', stale = false;
    if (exporting && !running) text = '读取记录中…';
    else if (filterResult && filterResult.sig === filterSig()) text = `命中 ${filterResult.matched} / 共 ${filterResult.total} 条`;
    else if (filterResult) { text = '条件已修改，需重新筛选'; stale = true; }
    el.textContent = text;
    el.classList.toggle('stale', stale);
  }

  // ── 筛选：只读取记录并计算命中数，不调用函数、不写入 ──
  async function applyFilter() {
    if (running || exporting) return;
    const regexErr = checkRegexes(config.filter);
    if (regexErr) { setStatus(regexErr, 'error'); return; }
    exporting = true;
    setStatus('正在读取视图记录…', '');
    render();
    try {
      const all = await host.loadAllRecords((done, total) => setStatus(`正在读取视图记录… ${done}/${total}`, ''));
      const matched = all.filter(r => evalGroup(config.filter, r));
      filterResult = { sig: filterSig(), matched: matched.length, total: all.length };
      setStatus(`筛选完成：视图共 ${all.length} 条记录，命中 ${matched.length} 条`, 'ok');
    } catch (e) {
      setStatus(`筛选失败：${describeError(e, 'read')}`, 'error');
    } finally {
      exporting = false;
      const keep = { text: statusText, kind: statusKind };
      render();
      setStatus(keep.text, keep.kind);
    }
  }

  syncRunBtn();

  // ── 导出筛选结果：视图里符合筛选条件的记录，全部可见字段 ──
  async function exportFiltered() {
    if (running || exporting) return;
    const regexErr = checkRegexes(config.filter);
    if (regexErr) { setStatus(regexErr, 'error'); return; }
    exporting = true;
    setStatus('正在读取视图记录…', '');
    render();
    try {
      const all = await host.loadAllRecords((done, total) => setStatus(`正在读取视图记录… ${done}/${total}`, ''));
      const matched = all.filter(r => evalGroup(config.filter, r));
      filterResult = { sig: filterSig(), matched: matched.length, total: all.length };
      if (matched.length === 0) { setStatus(`视图共 ${all.length} 条记录，没有符合筛选条件的记录，未导出`, ''); return; }
      downloadCsv(toCsv(filteredRows(matched)), '筛选结果');
      setStatus(`已导出 ${matched.length} 条符合筛选条件的记录（视图共 ${all.length} 条）`, 'ok');
    } catch (e) {
      setStatus(`导出失败：${describeError(e, 'read')}`, 'error');
    } finally {
      exporting = false;
      const keep = { text: statusText, kind: statusKind };
      render();
      setStatus(keep.text, keep.kind);
    }
  }

  // ── 导出 / 导入筛选条件（JSON 文件），方便跨表格、跨人复用 ──
  // 文件里每个条件除了字段 ID，还带上字段名：换一张表时字段 ID 对不上，就按字段名重新匹配
  const FILTER_FILE_TYPE = 'bitable-editor-filter';
  const FILTER_MAX_DEPTH = 8;

  function filterForExport(g: Group): any {
    const byId = new Map(host.getAllFields().map(f => [f.id, f]));
    const conv = (n: Cond | Group): any => n.kind === 'group'
      ? { kind: 'group', logic: n.logic, negate: n.negate, children: n.children.map(conv) }
      : { kind: 'cond', fieldId: n.fieldId, fieldName: byId.get(n.fieldId)?.name ?? '', op: n.op, value: n.value, ...(n.sep ? { sep: n.sep } : {}), ...(n.customSep ? { customSep: n.customSep } : {}) };
    return conv(g);
  }

  function exportFilterConditions() {
    saveFile(JSON.stringify({ type: FILTER_FILE_TYPE, version: 1, filter: filterForExport(config.filter) }, null, 2), '筛选条件', 'json', 'application/json');
    setStatus('已导出筛选条件', 'ok');
  }

  // 校验并清洗导入的内容：只保留认识的属性，结构不对直接报错
  function parseFilter(raw: any, depth = 0): Group {
    if (depth > FILTER_MAX_DEPTH) throw new Error(`条件组嵌套超过 ${FILTER_MAX_DEPTH} 层`);
    if (!raw || raw.kind !== 'group' || !Array.isArray(raw.children)) throw new Error('筛选条件的结构不对');
    if (raw.logic !== 'and' && raw.logic !== 'or') throw new Error('条件组的逻辑只能是“且”或“或”');
    const children = raw.children.map((c: any): Cond | Group => {
      if (c && c.kind === 'group') return parseFilter(c, depth + 1);
      if (!c || c.kind !== 'cond') throw new Error('筛选条件里有无法识别的内容');
      if (!OPS.some(([v]) => v === c.op)) throw new Error(`不认识的匹配条件：${String(c.op)}`);
      const cond: Cond = { kind: 'cond', fieldId: String(c.fieldId ?? ''), op: c.op, value: String(c.value ?? '') };
      if (typeof c.sep === 'string') cond.sep = c.sep;
      if (typeof c.customSep === 'string') cond.customSep = c.customSep;
      (cond as any).fieldName = String(c.fieldName ?? '');
      return cond;
    });
    return { kind: 'group', logic: raw.logic, negate: !!raw.negate, children };
  }

  // 字段对应：ID 和名字都对得上就用 ID；否则按字段名找（名字唯一才算）；都找不到的清空，由用户重新选
  function mapImportedFields(g: Group, missing: string[]) {
    const all = host.getAllFields();
    for (const c of g.children) {
      if (c.kind === 'group') { mapImportedFields(c, missing); continue; }
      const name = (c as any).fieldName as string;
      delete (c as any).fieldName;
      if (!c.fieldId && !name) continue;
      const byId = all.find(f => f.id === c.fieldId);
      if (byId && (!name || byId.name === name)) continue;
      const byName = name ? all.filter(f => f.name === name) : [];
      if (byName.length === 1) { c.fieldId = byName[0].id; continue; }
      missing.push(name || c.fieldId);
      c.fieldId = '';
    }
  }

  function importFilterConditions() {
    if (running || exporting) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        let data: any;
        try { data = JSON.parse(await file.text()); } catch { throw new Error('文件不是合法的 JSON'); }
        if (!data || data.type !== FILTER_FILE_TYPE) throw new Error('这不是本插件导出的筛选条件文件');
        const filter = parseFilter(data.filter);
        const missing: string[] = [];
        mapImportedFields(filter, missing);
        if (config.filter.children.length > 0 && !confirm('导入会替换当前的筛选条件，确定吗？')) return;
        config.filter = filter;
        saveConfig();
        render();
        const uniq = [...new Set(missing)];
        setStatus(uniq.length
          ? `已导入筛选条件，但有 ${missing.length} 个条件的字段在当前表格里找不到：${uniq.join('、')}。请在对应条件里重新选择字段`
          : '已导入筛选条件', uniq.length ? 'error' : 'ok');
      } catch (e) {
        setStatus(`导入失败：${e instanceof Error ? e.message : String(e)}`, 'error');
      }
    });
    input.click();
  }

  // ── 预览筛选结果：悬浮窗口里看符合条件的记录（和导出 CSV 同样的列），不下载、不写表 ──
  const PREVIEW_LIMIT = 200; // 预览最多渲染的行数，导出始终是全部
  const PREVIEW_CELL_MAX = 200; // 单元格文本最多显示的字符数，完整内容放在悬停提示里

  function filteredRows(matched: RecordData[]): string[][] {
    const fields = host.getFields();
    return [
      ['记录ID', ...fields.map(f => f.name)],
      ...matched.map(r => [r.recordId, ...fields.map(f => cellText(r.fields[f.id]))]),
    ];
  }

  // 在新标签页里打开完整预览：点击当下直接打开，数据已经在手，页面是个自带脚本的快照。
  // 用带 target=_blank 的链接点击来打开，而不是判断 window.open 的返回值：
  // 在飞书的 iframe 等环境里，新标签页明明打开了，window.open 也可能返回 null，据此提示“被拦截”会误报
  function openPreviewTab(rows: string[][], total: number) {
    const url = URL.createObjectURL(new Blob([buildPreviewHtml(rows, total)], { type: 'text/html;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function openPreview(rows: string[][], total: number) {
    const [head, ...body] = rows;
    const shown = body.slice(0, PREVIEW_LIMIT);
    const cell = (c: string) => `<td title="${esc(c)}">${esc(c.length > PREVIEW_CELL_MAX ? c.slice(0, PREVIEW_CELL_MAX) + '…' : c)}</td>`;
    const overlay = document.createElement('div');
    overlay.className = 'af-modal';
    overlay.innerHTML = `<div class="af-modal-box" role="dialog" aria-modal="true">
      <div class="af-modal-head"><span>筛选结果预览：命中 ${body.length} / 共 ${total} 条</span><button class="af-x" data-close title="关闭">×</button></div>
      <div class="af-modal-body"><table class="af-table">
        <thead><tr><th>#</th>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
        <tbody>${shown.map((r, i) => `<tr><td>${i + 1}</td>${r.map(cell).join('')}</tr>`).join('')}</tbody>
      </table></div>
      <div class="af-modal-foot"><span>${body.length > shown.length ? `仅显示前 ${shown.length} 条，导出 CSV 包含全部 ${body.length} 条` : `共 ${body.length} 条`}</span><span class="af-modal-actions"><button class="af-add" data-newtab title="在新标签页里打开，能用上整个浏览器窗口，并支持排序、调整列宽">在新标签页打开</button><button class="af-add" data-export>导出 CSV</button></span></div>
    </div>`;
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    overlay.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t === overlay || t.closest('[data-close]')) close();
      else if (t.closest('[data-export]')) downloadCsv(toCsv(rows), '筛选结果');
      else if (t.closest('[data-newtab]')) openPreviewTab(rows, total);
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay); // 挂在 body 上，不受面板缩放影响
  }

  async function previewFiltered() {
    if (running || exporting) return;
    const regexErr = checkRegexes(config.filter);
    if (regexErr) { setStatus(regexErr, 'error'); return; }
    exporting = true;
    setStatus('正在读取视图记录…', '');
    render();
    let rows: string[][] | null = null;
    let total = 0;
    try {
      const all = await host.loadAllRecords((done, n) => setStatus(`正在读取视图记录… ${done}/${n}`, ''));
      const matched = all.filter(r => evalGroup(config.filter, r));
      filterResult = { sig: filterSig(), matched: matched.length, total: all.length };
      total = all.length;
      if (matched.length === 0) setStatus(`视图共 ${all.length} 条记录，没有符合筛选条件的记录`, '');
      else { rows = filteredRows(matched); setStatus(`预览：命中 ${matched.length} / 共 ${all.length} 条`, 'ok'); }
    } catch (e) {
      setStatus(`预览失败：${describeError(e, 'read')}`, 'error');
    } finally {
      exporting = false;
      const keep = { text: statusText, kind: statusKind };
      render();
      setStatus(keep.text, keep.kind);
    }
    if (rows) openPreview(rows, total);
  }

  async function startRun() {
    if (running || exporting) return;
    const err = validate();
    if (err) { setStatus(err, 'error'); return; }
    running = true;
    cancelled = false;
    setStatus('正在读取视图记录…', '');
    render();
    const fieldById = new Map(host.getAllFields().map(f => [f.id, f]));
    let written = 0, failed = 0, skipped = 0, matchedCount = 0;
    failures = [];
    failureHeaders = config.inputs.map(i => `${i.param}(${fieldById.get(i.fieldId)?.name ?? i.fieldId})`);
    const inputCols = config.inputs.map(i => i.fieldId);
    const optionsOf = new Map<string, FieldOption[]>(); // 单选/多选输出字段的选项
    try {
      const all = await host.loadAllRecords((done, total) => setStatus(`正在读取视图记录… ${done}/${total}`, ''));
      const matched = all.filter(r => evalGroup(config.filter, r));
      matchedCount = matched.length;
      filterResult = { sig: filterSig(), matched: matched.length, total: all.length };
      if (matched.length === 0) { setStatus(`视图共 ${all.length} 条记录，没有符合筛选条件的记录`, ''); return; }
      const outNames = config.outputs.map(o => findOutput(o.param)?.out.label || o.param).join('、');
      if (!confirm(`视图共 ${all.length} 条记录，${matched.length} 条符合筛选条件。\n将调用函数并覆盖写入：${outNames}\n\n确定开始吗？`)) {
        setStatus('已取消', '');
        return;
      }

      // 按函数分组：同一个函数的多个输出，一次调用拿齐
      const byFn = new Map<string, { fn: FnMeta; outs: { name: string; fieldId: string }[] }>();
      for (const o of config.outputs) {
        const hit = findOutput(o.param)!;
        if (!byFn.has(hit.fn.id)) byFn.set(hit.fn.id, { fn: hit.fn, outs: [] });
        byFn.get(hit.fn.id)!.outs.push({ name: hit.out.name, fieldId: o.fieldId });
      }
      const fieldOf = new Map(config.inputs.map(i => [i.param, i.fieldId]));
      for (const o of config.outputs) {
        const f = fieldById.get(o.fieldId);
        if (f && needsOptions(f.type) && !optionsOf.has(o.fieldId)) optionsOf.set(o.fieldId, await host.getFieldOptions(o.fieldId));
      }
      const indexOf = new Map(all.map((r, i) => [r.recordId, i + 1]));

      for (let start = 0; start < matched.length; start += CALL_BATCH) {
        if (cancelled) break;
        const chunk = matched.slice(start, start + CALL_BATCH);
        const values = chunk.map(() => ({} as Record<string, any>));
        const bad = chunk.map(() => '');
        for (const { fn, outs } of byFn.values()) {
          const rows = chunk.map(rec => {
            const row: Record<string, any> = {};
            for (const inp of fn.inputs) {
              const fid = fieldOf.get(inp.name);
              if (fid) row[inp.name] = cellText(rec.fields[fid]);
            }
            return row;
          });
          const results = await callFunction(fn, rows);
          results.forEach((r, i) => {
            if (bad[i]) return;
            if (!r.ok) { bad[i] = r.error || '函数执行失败'; return; }
            try {
              for (const o of outs) {
                if (!r.outputs || !(o.name in r.outputs)) throw new Error(`函数“${fn.name}”没有返回“${o.name}”`);
                if (r.outputs[o.name] === null) continue; // 函数返回 null：这个字段不写入，保留原值
                values[i][o.fieldId] = toFieldValue(fieldById.get(o.fieldId)!, r.outputs[o.name], optionsOf.get(o.fieldId));
              }
            } catch (e) { bad[i] = e instanceof Error ? e.message : String(e); }
          });
        }
        const items: { recordId: string; fields: Record<string, any> }[] = [];
        chunk.forEach((rec, i) => {
          if (bad[i]) {
            failed++;
            failures.push({ index: indexOf.get(rec.recordId) || 0, recordId: rec.recordId, inputs: inputCols.map(fid => cellText(rec.fields[fid])), error: bad[i] });
          } else if (Object.keys(values[i]).length === 0) skipped++; // 所有输出都是 null，没有可写的内容
          else items.push({ recordId: rec.recordId, fields: values[i] });
        });
        if (items.length) { await host.writeRecords(items); written += items.length; }
        setStatus(`进度 ${Math.min(start + CALL_BATCH, matched.length)}/${matched.length}（已写入 ${written}，失败 ${failed}）`, '');
      }
      const summary = `${cancelled ? '已取消' : '完成'}：符合筛选 ${matchedCount} 条，已写入 ${written} 条，失败 ${failed} 条` +
        (skipped ? `，跳过 ${skipped} 条（函数没有返回内容，未写入）` : '') +
        (failed ? '（详见下方失败明细）' : '');
      setStatus(summary, failed || cancelled ? 'error' : 'ok');
    } catch (e) {
      setStatus(`中断：${describeError(e, 'write')}\n已写入 ${written} 条，其余记录未处理`, 'error');
    } finally {
      running = false;
      const keep = { text: statusText, kind: statusKind };
      render();
      setStatus(keep.text, keep.kind);
    }
  }

  return {
    /** 切到自动刷写时调用：首次加载函数列表，之后只刷新字段下拉 */
    show() {
      if (fnState === 'idle' || fnState === 'error') loadFunctions();
      else { render(); loadFunctions(true); }
    },
    /** 只按最新字段重画，不重新读函数列表 */
    rerender() { if (!running && !exporting) render(); },
  };
}
