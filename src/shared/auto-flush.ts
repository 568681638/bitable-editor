import { describeError, describedError } from './errors';
import { FieldMeta, FieldOption, RecordData, esc } from './common';
import { buildPreviewHtml } from './preview-page';
import { WRITABLE_TYPES, FIELD_TYPE_NAMES, needsOptions, toFieldValue } from './field-value';

// ── 批处理面板：筛选记录 → 取输入字段调用后端函数 → 把输出写回字段 ──────────
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

// 历史记录（类比浏览历史）：每次筛选 / 预览 / 导出 / 运行都记一条，连同当时整套配置（筛选 + 输入 + 输出），之后可以一键恢复
type HistoryKind = 'filter' | 'preview' | 'export' | 'run';
interface HistoryEntry { id: string; time: number; kind: HistoryKind; name?: string; config: Config; matched: number; total: number; result?: string; ok?: boolean }
const HISTORY_LIMIT = 50; // 超出时先丢最旧的未命名记录，命名过的优先保留
const HISTORY_NAME_MAX = 40;
const HISTORY_KINDS: Record<HistoryKind, string> = { filter: '筛选', preview: '预览', export: '导出 CSV', run: '运行' };

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

export function createAutoFlush(container: HTMLElement, host: AutoFlushHost, runBtn?: HTMLButtonElement) {
  let fns: FnMeta[] = [];
  let fnState: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
  let fnError = '';
  let config = newConfig();
  let configTable = '';
  let running = false;
  let exporting = false; // 正在读取全部记录做筛选 / 导出（期间不能运行）
  // 最近一次筛选的结果：只记条数和当时的条件签名，条件改了就判定为过期
  let filterResult: { sig: string; matched: number; total: number } | null = null;
  // 最近一次运行中失败的行（含当时送给函数的输入），供展开查看 / 复制 / 导出
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

  // ── 历史记录 ────────────────────────────────────
  const historyKey = () => `annotator-auto-flush-history:${host.getTableId()}`;
  function readHistory(): HistoryEntry[] {
    try {
      const list = JSON.parse(localStorage.getItem(historyKey()) || '[]');
      return Array.isArray(list) ? list.filter(e => e && e.config && e.config.filter) : [];
    } catch { return []; }
  }
  function writeHistory(list: HistoryEntry[]) {
    let kept = list;
    for (let i = kept.length - 1; i >= 0 && kept.length > HISTORY_LIMIT; i--) if (!kept[i].name) kept = kept.filter((_, k) => k !== i);
    try { localStorage.setItem(historyKey(), JSON.stringify(kept.slice(0, HISTORY_LIMIT))); } catch { /* ignore */ }
  }
  const cloneConfig = (): Config => JSON.parse(JSON.stringify(config));

  // 连续两次用同一套配置做同一件事（筛选 / 预览 / 导出）只留最新一条；运行每次都单独记
  function recordHistory(kind: HistoryKind, matched: number, total: number): string {
    const list = readHistory();
    const top = list[0];
    const same = kind !== 'run' && top && top.kind === kind && JSON.stringify(top.config) === JSON.stringify(config);
    const entry: HistoryEntry = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), time: Date.now(), kind, config: cloneConfig(), matched, total };
    if (same && top.name) entry.name = top.name; // 顶上那条被同配置的新记录顶替时，名字沿用
    writeHistory([entry, ...(same ? list.slice(1) : list)]);
    return entry.id;
  }
  function updateHistory(id: string, patch: Partial<HistoryEntry>) {
    const list = readHistory();
    const entry = list.find(e => e.id === id);
    if (!entry) return;
    Object.assign(entry, patch);
    writeHistory(list);
  }

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
        ${path.length ? '<button class="af-x af-x-group" data-act="del" title="删除整个条件组（包含组内所有条件）">×</button>'
          // 最外层的初始组：× 清空里面的全部条件，并把“且 / 或”“取反”恢复成初始状态
          : clearBtn('clear-filter', '筛选条件，并恢复到初始状态', node.children.length === 0 && node.logic === 'and' && !node.negate)}
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

  // 块右上角的 ×：一键清空这个块里的内容（块里本来就是空的、或正在运行时置灰）
  const clearBtn = (act: string, what: string, empty: boolean) =>
    `<button class="af-x af-x-group" data-act="${act}" title="清空全部${what}"${empty || running || exporting ? ' disabled' : ''}>×</button>`;

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
        <section class="af-sec"><h4 class="af-h"><span>筛选 <span class="af-count"></span></span><span class="af-h-actions"><button class="af-add" data-act="filter" title="读取视图记录，只计算命中数，不调用函数、不写入"${running || exporting ? ' disabled' : ''}>筛选</button><button class="af-add" data-act="preview-filtered" title="在悬浮窗口里查看符合筛选条件的记录（全部可见字段）"${running || exporting ? ' disabled' : ''}>预览</button><span class="af-menu-wrap"><button class="af-add af-more" data-act="filter-menu" title="更多：导出 CSV、导入 / 导出筛选条件">☰</button>${filterMenuOpen ? `<div class="menu af-menu"><button class="menu-item" data-act="export-filtered" title="把视图里符合筛选条件的记录（全部可见字段）导出为 CSV"${running || exporting ? ' disabled' : ''}>导出 CSV</button><button class="menu-item" data-act="filter-import" title="从文件导入筛选条件（会替换当前条件）"${running || exporting ? ' disabled' : ''}>筛选条件导入</button><button class="menu-item" data-act="filter-export" title="把当前筛选条件导出为文件，方便复用">筛选条件导出</button></div>` : ''}</span></span></h4>${renderNode(config.filter, [])}</section>
        <section class="af-sec"><h4 class="af-h"><span>输入</span>${clearBtn('clear-inputs', '输入项', config.inputs.length === 0)}</h4>${renderInputs()}<button class="af-add" data-act="add-input">＋ 输入项</button></section>
        <section class="af-sec"><h4 class="af-h"><span>输出</span>${clearBtn('clear-outputs', '输出项', config.outputs.length === 0)}</h4>${renderOutputs()}<button class="af-add" data-act="add-output">＋ 输出项</button></section>
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
      if (act === 'fail-csv') { downloadCsv(toCsv(failureTable()), '批处理失败行'); return; }
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

  // 筛选块右上角 ☰ 菜单：点菜单外面、按 Esc 收起（render 会整块重绘，所以展开状态记在这里）
  let filterMenuOpen = false;
  function closeFilterMenu() {
    if (!filterMenuOpen) return;
    filterMenuOpen = false;
    render();
  }
  document.addEventListener('click', (e) => { if (!(e.target as HTMLElement).closest('.af-menu-wrap')) closeFilterMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeFilterMenu(); });

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
      case 'clear-filter': config.filter = emptyGroup(); break;
      case 'clear-inputs': config.inputs = []; ensureInputs(); break; // 输出还在的话，它必需的输入项会重新补成空行
      case 'clear-outputs': config.outputs = []; break;
      case 'add-input': config.inputs.push({ param: '', fieldId: '' }); break;
      case 'add-output': config.outputs.push({ param: '', fieldId: '' }); break;
      case 'reload-fns': loadFunctions(); return;
      case 'filter-menu': filterMenuOpen = !filterMenuOpen; render(); return;
      case 'filter': applyFilter(); return;
      case 'preview-filtered': previewFiltered(); return;
      case 'export-filtered': closeFilterMenu(); exportFiltered(); return;
      case 'filter-export': closeFilterMenu(); exportFilterConditions(); return;
      case 'filter-import': closeFilterMenu(); importFilterConditions(); return;
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

  // ── 底部右侧的“运行（取消）”按钮（在面板外，由侧边栏页面提供）──
  function syncRunBtn() {
    if (runBtn) {
      runBtn.textContent = running ? '取消' : '运行';
      runBtn.classList.toggle('cancel', running);
      runBtn.disabled = exporting || (!running && fnState !== 'ready');
    }
  }
  runBtn?.addEventListener('click', () => {
    if (running) { cancelled = true; setStatus('正在取消…', ''); }
    else startRun();
  });

  // 筛选板块标题旁的命中数：条件改过就提示需要重新筛选
  const filterSig = () => JSON.stringify(config.filter);
  // 筛选 / 预览 / 导出读取记录时的进度，直接显示在命中数的位置，不再往状态区打印
  let readProgress = '';
  function setReadProgress(text: string) {
    readProgress = text;
    updateFilterCount();
  }
  function updateFilterCount() {
    const el = container.querySelector('.af-count') as HTMLElement | null;
    if (!el) return;
    let text = '', stale = false;
    if (exporting && !running) text = '读取记录中…' + readProgress;
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
    setReadProgress('');
    render();
    try {
      const all = await host.loadAllRecords((done, total) => setReadProgress(` ${done}/${total}`));
      const matched = all.filter(r => evalGroup(config.filter, r));
      filterResult = { sig: filterSig(), matched: matched.length, total: all.length };
      recordHistory('filter', matched.length, all.length);
      setStatus('', ''); // 结果已显示在筛选标题旁的命中数里，不再重复打印；读取进度只在读取过程中显示
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
    setReadProgress('');
    render();
    try {
      const all = await host.loadAllRecords((done, total) => setReadProgress(` ${done}/${total}`));
      const matched = all.filter(r => evalGroup(config.filter, r));
      filterResult = { sig: filterSig(), matched: matched.length, total: all.length };
      recordHistory('export', matched.length, all.length);
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
    setReadProgress('');
    render();
    let rows: string[][] | null = null;
    let total = 0;
    try {
      const all = await host.loadAllRecords((done, n) => setReadProgress(` ${done}/${n}`));
      const matched = all.filter(r => evalGroup(config.filter, r));
      filterResult = { sig: filterSig(), matched: matched.length, total: all.length };
      total = all.length;
      recordHistory('preview', matched.length, all.length);
      if (matched.length === 0) setStatus(`视图共 ${all.length} 条记录，没有符合筛选条件的记录`, ''); // 没有结果窗口弹出，需要说明原因
      else { rows = filteredRows(matched); setStatus('', ''); } // 命中数在筛选标题旁，窗口也会弹出
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

  // ── 历史记录窗口：按天分组、可搜索；恢复全部，或只恢复筛选条件 ──
  function describeFilter(g: Group): string {
    const names = new Map(host.getAllFields().map(f => [f.id, f.name]));
    const walk = (n: Cond | Group, top: boolean): string => {
      if (n.kind === 'cond') {
        if (!n.fieldId) return '';
        const op = OPS.find(([v]) => v === n.op)?.[1] || n.op;
        return `${names.get(n.fieldId) ?? '（字段已不存在）'} ${op}${NO_VALUE_OPS.has(n.op) ? '' : ` “${n.value}”`}`;
      }
      const inner = n.children.map(c => walk(c, false)).filter(Boolean).join(n.logic === 'and' ? ' 且 ' : ' 或 ');
      if (!inner) return '';
      return n.negate ? `非（${inner}）` : top || n.children.length < 2 ? inner : `（${inner}）`;
    };
    return walk(g, true) || '无（全部记录）';
  }

  function describeIo(c: Config): string {
    const names = new Map(host.getAllFields().map(f => [f.id, f.name]));
    const fieldName = (id: string) => (id ? names.get(id) ?? '（字段已不存在）' : '未选字段');
    const ins = c.inputs.map(i => `${i.param || '未选参数'} ← ${fieldName(i.fieldId)}`);
    const outs = c.outputs.map(o => `${findOutput(o.param)?.out.label || o.param || '未选参数'} → ${fieldName(o.fieldId)}`);
    return [ins.length ? `输入：${ins.join('，')}` : '', outs.length ? `输出：${outs.join('，')}` : ''].filter(Boolean).join('；') || '未配置输入 / 输出';
  }

  function restoreHistory(entry: HistoryEntry, only: 'all' | 'filter'): boolean {
    if (running || exporting) { alert('正在读取记录或运行中，完成后再恢复历史配置'); return false; }
    const hasContent = config.filter.children.length > 0 || config.inputs.length > 0 || config.outputs.length > 0;
    const cur = JSON.stringify(config);
    // 当前配置没跑过（历史里找不到一模一样的）：恢复会把它覆盖掉，先确认
    if (hasContent && !readHistory().some(h => JSON.stringify(h.config) === cur) &&
        !confirm('当前配置还没有筛选 / 运行过，恢复历史配置会覆盖它，确定吗？')) return false;
    const saved = JSON.parse(JSON.stringify(entry.config)) as Config;
    config = only === 'filter' ? { ...config, filter: saved.filter } : { ...newConfig(), ...saved };
    migrateSeps(config.filter);
    saveConfig();
    const when = new Date(entry.time);
    const pad2 = (n: number) => String(n).padStart(2, '0');
    setStatus(`已恢复 ${when.getMonth() + 1}-${when.getDate()} ${pad2(when.getHours())}:${pad2(when.getMinutes())} 的${only === 'filter' ? '筛选条件' : '整套配置'}`, 'ok');
    render();
    return true;
  }

  // ── 历史记录导出 / 导入（JSON 文件）：和筛选条件一样，字段除了 ID 还带上字段名，换一张表时按字段名重新对应 ──
  const HISTORY_FILE_TYPE = 'bitable-editor-history';

  function entryForExport(e: HistoryEntry): any {
    const byId = new Map(host.getAllFields().map(f => [f.id, f.name]));
    const io = (m: Mapping) => ({ param: m.param, fieldId: m.fieldId, fieldName: byId.get(m.fieldId) ?? '' });
    return {
      time: e.time, kind: e.kind, ...(e.name ? { name: e.name } : {}), matched: e.matched, total: e.total,
      ...(e.result ? { result: e.result } : {}), ...(e.ok !== undefined ? { ok: e.ok } : {}),
      config: { filter: filterForExport(e.config.filter), inputs: e.config.inputs.map(io), outputs: e.config.outputs.map(io) },
    };
  }

  function exportHistory(entries: HistoryEntry[]) {
    saveFile(JSON.stringify({ type: HISTORY_FILE_TYPE, version: 1, entries: entries.map(entryForExport) }, null, 2), '历史记录', 'json', 'application/json');
  }

  // 校验并清洗：只保留认识的内容；某条结构不对就跳过这一条，不影响其他条。返回新增条数、跳过条数、对不上的字段名
  function parseHistoryFile(text: string): { entries: HistoryEntry[]; skipped: number; missing: string[] } {
    let data: any;
    try { data = JSON.parse(text); } catch { throw new Error('文件不是合法的 JSON'); }
    if (!data || data.type !== HISTORY_FILE_TYPE || !Array.isArray(data.entries)) throw new Error('这不是本插件导出的历史记录文件');
    const all = host.getAllFields();
    const missing: string[] = [];
    const mapField = (id: string, name: string): string => {
      if (!id && !name) return '';
      const byId = all.find(f => f.id === id);
      if (byId && (!name || byId.name === name)) return id;
      const byName = name ? all.filter(f => f.name === name) : [];
      if (byName.length === 1) return byName[0].id;
      missing.push(name || id);
      return '';
    };
    const io = (raw: any): Mapping[] => {
      if (!Array.isArray(raw)) throw new Error('输入 / 输出的结构不对');
      return raw.map((m: any) => ({ param: String(m?.param ?? ''), fieldId: mapField(String(m?.fieldId ?? ''), String(m?.fieldName ?? '')) }));
    };
    const entries: HistoryEntry[] = [];
    let skipped = 0;
    for (const raw of data.entries) {
      try {
        if (!raw || !(raw.kind in HISTORY_KINDS) || !raw.config) throw new Error('bad');
        const filter = parseFilter(raw.config.filter);
        mapImportedFields(filter, missing);
        const time = Number(raw.time);
        entries.push({
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), // 重新生成，避免和已有的冲突
          time: Number.isFinite(time) && time > 0 ? time : Date.now(),
          kind: raw.kind, ...(typeof raw.name === 'string' && raw.name.trim() ? { name: raw.name.trim().slice(0, HISTORY_NAME_MAX) } : {}), config: { filter, inputs: io(raw.config.inputs), outputs: io(raw.config.outputs) },
          matched: Number(raw.matched) || 0, total: Number(raw.total) || 0,
          ...(typeof raw.result === 'string' ? { result: raw.result } : {}), ...(typeof raw.ok === 'boolean' ? { ok: raw.ok } : {}),
        });
      } catch { skipped++; }
    }
    return { entries, skipped, missing };
  }

  function openHistory() {
    const pad = (n: number) => String(n).padStart(2, '0');
    const dayLabel = (t: number) => {
      const d = new Date(t), today = new Date();
      const diff = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000);
      return diff === 0 ? '今天' : diff === 1 ? '昨天' : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };
    const overlay = document.createElement('div');
    overlay.className = 'af-modal';
    overlay.innerHTML = `<div class="af-modal-box af-hist-box" role="dialog" aria-modal="true">
      <div class="af-modal-head"><span>历史记录（最多 ${HISTORY_LIMIT} 条，命名过的优先保留）</span><button class="af-x" data-close title="关闭">×</button></div>
      <div class="af-hist-search"><input type="text" data-search placeholder="搜索名称、字段名、条件、函数…" /></div>
      <div class="af-hist-bar"><button type="button" class="af-hist-check" data-selall title="全选 / 取消全选（当前列表里显示的记录）"></button><span class="af-hist-selinfo" data-selinfo></span><button class="af-add" data-import title="从文件导入历史记录（和现有的合并，不会覆盖）">导入</button><button class="af-add" data-export-all disabled title="先勾选要导出的记录">导出</button><button class="af-add" data-delsel disabled title="先勾选要删除的记录">删除</button></div>
      <div class="af-hist-msg" data-msg hidden></div>
      <div class="af-modal-body af-hist-list"></div>
    </div>`;
    const listEl = overlay.querySelector('.af-hist-list') as HTMLElement;
    const searchEl = overlay.querySelector('[data-search]') as HTMLInputElement;
    const msgEl = overlay.querySelector('[data-msg]') as HTMLElement;
    const selAllEl = overlay.querySelector('[data-selall]') as HTMLElement;
    const selInfoEl = overlay.querySelector('[data-selinfo]') as HTMLElement;
    const delSelEl = overlay.querySelector('[data-delsel]') as HTMLElement;
    const exportAllEl = overlay.querySelector('[data-export-all]') as HTMLElement;
    let shownIds: string[] = []; // 当前列表里显示的记录（全选针对它们）
    const selected = new Set<string>(); // 勾选的历史记录 id（批量导出 / 删除）
    const notice = (text: string, isError = false) => { msgEl.textContent = text; msgEl.hidden = !text; msgEl.classList.toggle('error', isError); };

    const draw = () => {
      const items = readHistory().map(e => {
        const when = new Date(e.time);
        const lines = [`筛选：${describeFilter(e.config.filter)}`, describeIo(e.config)];
        const stat = e.kind === 'run' && e.result ? e.result : `命中 ${e.matched} / 共 ${e.total} 条`;
        return { e, when, lines, stat, text: [e.name || '', HISTORY_KINDS[e.kind], ...lines, stat].join('\n').toLowerCase() };
      });
      const q = searchEl.value.trim().toLowerCase();
      const shown = q ? items.filter(i => i.text.includes(q)) : items;
      shownIds = shown.map(i => i.e.id);
      const keep = listEl.scrollTop; // 重画列表不要跳回顶部
      for (const id of [...selected]) if (!items.some(i => i.e.id === id)) selected.delete(id);
      const shownSel = shown.filter(i => selected.has(i.e.id)).length;
      selAllEl.classList.toggle('on', shown.length > 0 && shownSel === shown.length);
      selAllEl.classList.toggle('part', shownSel > 0 && shownSel < shown.length);
      selInfoEl.textContent = selected.size ? `已选 ${selected.size} / 共 ${items.length} 条` : `共 ${items.length} 条`;
      (delSelEl as HTMLButtonElement).disabled = (exportAllEl as HTMLButtonElement).disabled = selected.size === 0;
      delSelEl.title = selected.size ? `删除勾选的 ${selected.size} 条历史记录` : '先勾选要删除的记录';
      exportAllEl.title = selected.size ? `把勾选的 ${selected.size} 条历史记录导出为文件，方便备份或分享给别人` : '先勾选要导出的记录';
      if (!shown.length) { listEl.innerHTML = `<div class="af-hint">${items.length ? '没有匹配的历史记录' : '还没有历史记录：筛选、预览、导出或运行之后，会自动记在这里'}</div>`; return; }
      let lastDay = '';
      listEl.innerHTML = shown.map(({ e, when, lines, stat }) => {
        const day = dayLabel(e.time);
        const head = day !== lastDay ? `<div class="af-hist-day">${esc(day)}</div>` : '';
        lastDay = day;
        return `${head}<div class="af-hist-item" data-id="${esc(e.id)}">
          <button type="button" class="af-hist-check${selected.has(e.id) ? ' on' : ''}" data-h="sel" title="选择这条记录，可批量导出 / 删除"></button>
          <button type="button" class="af-hist-x" data-h="del" title="删除这条历史记录">×</button>
          <div class="af-hist-title"><span class="af-hist-kind ${e.kind}">${HISTORY_KINDS[e.kind]}</span><span class="af-hist-name${e.name ? '' : ' empty'}" data-h="rename" title="点击给这条记录命名 / 改名，方便以后查找">${e.name ? esc(e.name) : '＋ 命名'}</span><span class="af-hist-time">${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}</span></div>
          ${lines.map(l => `<div class="af-hist-line" title="${esc(l)}">${esc(l)}</div>`).join('')}
          <div class="af-hist-line stat${e.ok === false ? ' bad' : ''}" title="${esc(stat)}">${esc(stat)}</div>
          <div class="af-hist-btns"><span class="af-hist-btns-left"><button class="af-add" data-h="all" title="把筛选、输入、输出整套换成这条记录当时的配置">恢复全部</button><button class="af-add" data-h="filter" title="只替换筛选条件，输入 / 输出保持不变">仅恢复筛选</button><button class="af-add" data-h="export" title="把这条历史记录导出为文件">导出</button></span></div>
        </div>`;
      }).join('');
      listEl.scrollTop = keep;
    };

    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    overlay.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t === overlay || t.closest('[data-close]')) { close(); return; }
      if (t.closest('[data-export-all]')) {
        const list = readHistory().filter(h => selected.has(h.id));
        if (!list.length) notice('先勾选要导出的历史记录', true);
        else { exportHistory(list); notice(`已导出 ${list.length} 条历史记录`); }
        return;
      }
      if (t.closest('[data-selall]')) { // 全选 / 取消全选：针对当前搜索结果里显示的记录
        const ids = shownIds;
        if (ids.length && ids.every(id => selected.has(id))) ids.forEach(id => selected.delete(id));
        else ids.forEach(id => selected.add(id));
        draw();
        return;
      }
      if (t.closest('[data-delsel]')) {
        if (selected.size && confirm(`删除勾选的 ${selected.size} 条历史记录，确定吗？`)) {
          writeHistory(readHistory().filter(h => !selected.has(h.id)));
          selected.clear();
          draw();
        }
        return;
      }
      if (t.closest('[data-import]')) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.addEventListener('change', async () => {
          const file = input.files && input.files[0];
          if (!file) return;
          try {
            const { entries, skipped, missing } = parseHistoryFile(await file.text());
            if (!entries.length) throw new Error(skipped ? `文件里的 ${skipped} 条记录都无法识别` : '文件里没有历史记录');
            writeHistory([...readHistory(), ...entries].sort((a, b) => b.time - a.time));
            draw();
            const uniq = [...new Set(missing)];
            notice(`已导入 ${entries.length} 条历史记录（最多保留最近 ${HISTORY_LIMIT} 条）` + (skipped ? `，跳过 ${skipped} 条无法识别的` : '') +
              (uniq.length ? `；有字段在当前表格里找不到：${uniq.join('、')}，恢复后请在对应位置重新选择` : ''), skipped > 0 || uniq.length > 0);
          } catch (err) {
            notice(`导入失败：${err instanceof Error ? err.message : String(err)}`, true);
          }
        });
        input.click();
        return;
      }
      const btn = t.closest('[data-h]') as HTMLElement | null;
      const id = (btn?.closest('.af-hist-item') as HTMLElement | null)?.dataset.id;
      if (!btn || !id) return;
      if (btn.dataset.h === 'export') {
        const one = readHistory().find(h => h.id === id);
        if (one) { exportHistory([one]); notice('已导出这条历史记录'); }
        return;
      }
      if (btn.dataset.h === 'rename') { // 原地换成输入框：回车 / 失焦保存，Esc 放弃，留空就是取消命名
        const cur = readHistory().find(h => h.id === id)?.name || '';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'af-hist-name-input';
        input.value = cur;
        input.maxLength = HISTORY_NAME_MAX;
        input.placeholder = '给这条记录起个名字';
        let done = false;
        const finish = (save: boolean) => {
          if (done) return;
          done = true;
          if (save) updateHistory(id, { name: input.value.trim() || undefined });
          draw();
        };
        input.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') finish(true); else if (ev.key === 'Escape') finish(false); });
        input.addEventListener('blur', () => finish(true));
        btn.replaceWith(input);
        input.focus();
        input.select();
        return;
      }
      if (btn.dataset.h === 'sel') { if (!selected.delete(id)) selected.add(id); draw(); return; }
      if (btn.dataset.h === 'del') { selected.delete(id); writeHistory(readHistory().filter(h => h.id !== id)); draw(); return; }
      const entry = readHistory().find(h => h.id === id);
      if (entry && restoreHistory(entry, btn.dataset.h === 'filter' ? 'filter' : 'all')) close();
    });
    searchEl.addEventListener('input', draw);
    document.addEventListener('keydown', onKey);
    draw();
    document.body.appendChild(overlay); // 挂在 body 上，不受面板缩放影响
    searchEl.focus();
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
    let historyId = '';
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
      historyId = recordHistory('run', matched.length, all.length);

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
      if (historyId) updateHistory(historyId, { result: summary, ok: !(failed || cancelled) });
    } catch (e) {
      setStatus(`中断：${describeError(e, 'write')}\n已写入 ${written} 条，其余记录未处理`, 'error');
      if (historyId) updateHistory(historyId, { result: `中断：已写入 ${written} 条，其余记录未处理`, ok: false });
    } finally {
      running = false;
      const keep = { text: statusText, kind: statusKind };
      render();
      setStatus(keep.text, keep.kind);
    }
  }

  return {
    /** 切到批处理时调用：首次加载函数列表，之后只刷新字段下拉 */
    show() {
      if (fnState === 'idle' || fnState === 'error') loadFunctions();
      else { render(); loadFunctions(true); }
    },
    /** 打开历史记录窗口（入口是侧边栏标题行里的「历史」按钮，只在批处理模式显示） */
    openHistory,
    /** 只按最新字段重画，不重新读函数列表 */
    rerender() { if (!running && !exporting) render(); },
  };
}
