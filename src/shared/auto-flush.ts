import { describeError, describedError } from './errors';
import { FType, FieldMeta, FieldOption, RecordData, esc } from './common';
import { buildPreviewHtml } from './preview-page';
import { renderStatsView } from './stats-view';
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
  /** 异步任务的归属（多维表格 ID / 数据表 ID），没选中表格时为空串 */
  getScope(): string;
  /** 取当前视图的全部记录（顺序与视图一致）。默认可能用短时缓存；fresh 为 true 时一定重新读取（并刷新缓存） */
  loadAllRecords(onProgress: (done: number, total: number) => void, opts?: { fresh?: boolean }): Promise<RecordData[]>;
  /** 最近一次 loadAllRecords 返回的数据是什么时候从表格里读的（毫秒时间戳） */
  loadedAt(): number;
  /** 批量写回 */
  writeRecords(items: { recordId: string; fields: Record<string, any> }[]): Promise<void>;
}

interface ParamMeta {
  name: string; label?: string; requires?: string[];
  // 以下只有入参有：type 不写 = 来自字段（每行取那一格的文本）；select / multiSelect / text 不来自字段，在卡片里直接填，整次运行每行都是同一个值
  // 出参的 type 只有 'detail'（执行详情，旧名 message）：不写进字段，面板收集并展示；loadFunctions 会把它从 outputs 里拆出来放进 FnMeta.noteOut
  type?: 'select' | 'multiSelect' | 'text' | 'detail' | 'message'; options?: { value: string; label: string }[]; default?: string | string[]; description?: string;
}
interface FnMeta { id: string; name: string; inputs: ParamMeta[]; outputs: ParamMeta[]; noteOut?: string /* 执行详情出参的名字（type: 'message'）；没有声明则为空 */; batchSize?: number; async?: boolean /* 异步函数：下发后由服务端后台执行，完成后插件取回结果写回 */; serializeCalls?: boolean /* 串行执行：同一时间最多一个 run 在跑，按到达先后排队 */; serializeRuns?: boolean /* serializeCalls 的旧名字（旧版服务端只返回它） */; path?: string[] /* 函数所在目录的各级目录名（后端 functions/ 的目录结构） */ }

type Cond = { kind: 'cond'; fieldId: string; op: string; value: string; sep?: string; customSep?: string };
type Group = { kind: 'group'; logic: 'and' | 'or'; negate: boolean; children: (Cond | Group)[] };
type Mapping = {
  param: string; fieldId: string; fn?: string /* 输入映射属于哪个函数（输出行没有）；旧版输入没有这一项，见 migrateLegacyInputs */;
  value?: string | string[] /* 不来自字段的入参（select / multiSelect / text）在卡片里填的值，这时 fieldId 为空 */;
};
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
const SEPS: [string, string][] = [[',', '英文逗号 ,'], ['\n', '换行 ↵']]; // 名字后面的符号和下拉框上显示的一致（见 sepLabel）
const DEFAULT_SEP = ',';
const CUSTOM_SEP = '__custom__'; // sep 取这个值时，用 customSep 作为拆分符
const WRITE_BATCH = 100; // 写回表格每次提交的记录数（不足 100 也算一批），和函数的批大小无关
const DEFAULT_BATCH = 100; // 函数没有声明 batchSize 时，每次调用传给它的行数
type FnResult = { ok: boolean; outputs?: Record<string, any>; error?: string };
// 历史记录里的两种记录（都只存在面板本地，按表格存进 localStorage；异步任务本身在服务端，见下面的 JobSummary）：
// CallRec：同步函数的一次调用（一批）；ExecNote：这次调用（或异步任务回写时）收集到的执行详情——batch 是这一批的整体说明，rows 是各行的说明（index 是记录在视图里的序号）
// runId / runAt：属于哪次点「运行」（批次）；part / parts：函数在这个批次里的第几次调用（共几次）
interface CallRec { uid: number; runId: string; runAt: number; fnId: string; fnName: string; part: number; parts: number; from: number; to: number; time: number; ok: number; failed: number; ms: number; error?: string }
interface ExecNote { uid: number; runId: string; runAt: number; fnId: string; part: number; parts: number; time: number; fnName: string; from: number; to: number; batch?: string; rows: { index: number; text: string }[]; more?: number /* 超出保存上限、没存下的行数 */; async: boolean }
const NOTE_ROWS_MAX = 200; // 一条详情最多保存多少行的详情
const NOTE_ROW_CHARS = 2000; // 保存到本地时，每行详情最多多少字

// 异步函数的任务（服务端见 release/server/jobs.mjs）。下发时把回写需要的信息放进 meta，之后不管页面刷没刷新都能照着写回
// 批次：一次点「运行」是一个批次，被函数的 batchSize 拆成多个任务；同一批次的任务共用 id，part / parts 是第几个 / 共几个，from–to 是对应批次里的第几到第几条
interface RunInfo { id: string; at: number; total: number; part: number; parts: number; from: number; to: number }
interface JobSummary {
  id: string; fnId: string; fnName: string; count: number; claimed: boolean; run?: RunInfo;
  status: 'queued' | 'running' | 'done' | 'failed' | 'applied' | 'cancelled';
  createdAt: number; startedAt?: number; finishedAt?: number; appliedAt?: number; error?: string; result?: string;
}
interface JobMeta { recordIds: string[]; indexes: number[]; outs: { name: string; fieldId: string }[]; run?: RunInfo }
interface AsyncFail { jobId: string; runId?: string; fnId: string; index: number; recordId: string; fnName: string; error: string; time: number }
// 声明了 serializeCalls 的函数的标记：同一时间只执行一批
const SERIAL_TAG = '<span class="af-serial-tag" title="串行函数：同一时间只执行一批（一次函数调用），不管来自哪次运行、哪个人。多个人 / 多次同时运行这个函数时，各批按到达先后逐个执行，轮不到的在状态栏提示排队">串行</span>';
const SS_MIN = 7; // 下拉的选项多于这个数，才换成带搜索框的弹层（选项少的用原生下拉更快）
const RUNS_SHOWN = 4; // 弹层里默认显示最近几个批次
const ASYNC_FAIL_LIMIT = 2000; // 异步任务的失败行最多保留多少条（存在浏览器本地）
const JOB_POLL_ACTIVE = 3000; // 有任务在跑 / 等回写时的轮询间隔
const JOB_POLL_IDLE = 30000; // 平时的轮询间隔（只在后端有异步函数时才轮询）
const JOB_RETRY_BACKOFF = 60000; // 回写失败后多久再试
// 函数分组标记行用这个前缀：param 形如 fn:<函数 id>（让没有输出参数、只调用的函数也有自己的分组，见 renderOutputs）
const FN_PREFIX = 'fn:';
const ALL_PREFIX = 'all:'; // 选择器里函数右侧“全选”图标的值（只在点选时用，不会存进配置）
const batchOf = (fn: FnMeta) => (fn.batchSize && fn.batchSize > 0 ? fn.batchSize : DEFAULT_BATCH);
const isSerial = (fn: FnMeta) => !!(fn.serializeCalls ?? fn.serializeRuns); // 旧版服务端只返回 serializeRuns

// 历史记录（类比浏览历史）：每次筛选 / 预览 / 导出 / 运行都记一条，连同当时整套配置（筛选 + 输入 + 输出），之后可以一键恢复
type HistoryKind = 'filter' | 'preview' | 'stats' | 'export' | 'run';
interface HistoryEntry { id: string; time: number; kind: HistoryKind; runId?: string /* 运行记录对应的批次 ID（函数块的历史靠它找到当时的配置） */; name?: string; config: Config; matched: number; total: number; result?: string; ok?: boolean }
const HISTORY_LIMIT = 50; // 筛选类记录（筛选 / 预览 / 统计 / 导出）和运行记录各自最多这么多条；超出时先丢最旧的未命名记录，命名过的优先保留
const HISTORY_NAME_MAX = 40;
const HISTORY_KINDS: Record<HistoryKind, string> = { filter: '筛选', preview: '预览', stats: '统计', export: '导出 CSV', run: '运行' };

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
  // 异步任务：当前这张表的任务列表、失败行、轮询状态
  let jobList: JobSummary[] = [];
  let jobScope = '';
  let jobTimer: ReturnType<typeof setTimeout> | undefined;
  let jobBusy = false; // 正在轮询 / 回写
  let jobNote = ''; // 最近一次轮询或回写出错的原因
  // 「有新结果」的提示点：历史按钮和每个批次块右上角各一个，颜色是对应的执行结果（失败红 / 执行中橙 / 完成绿）；出现新的活动才亮，点开（按钮 / 批次）就消失
  const NOTE_SEEN_KEY = () => `annotator-auto-flush-hist-seen:${host.getTableId()}`;
  const RUN_SEEN_KEY = () => `annotator-auto-flush-run-seen:${host.getTableId()}`;
  const readSeen = (): Record<string, number> => { try { return JSON.parse(localStorage.getItem(RUN_SEEN_KEY()) || '{}') || {}; } catch { return {}; } };
  function markRunSeen(runKey: string) {
    const m = readSeen(); m[runKey] = Date.now();
    const keys = Object.keys(m); if (keys.length > 200) keys.sort((a, b) => m[a] - m[b]).slice(0, keys.length - 200).forEach(k => delete m[k]);
    try { localStorage.setItem(RUN_SEEN_KEY(), JSON.stringify(m)); } catch { /* ignore */ }
  }
  const jobTime = (j: JobSummary) => Math.max(j.createdAt || 0, j.startedAt || 0, j.finishedAt || 0, j.appliedAt || 0);
  const dotState = (failed: boolean, busy: boolean) => (failed ? (busy ? 'bad live' : 'bad') : busy ? 'busy' : 'ok');
  let histQuery = ''; // 历史窗口里的搜索词
  const histSel = new Set<string>(); // 历史窗口里勾选的批次（runId）
  let notePop: HTMLElement | null = null; // 执行详情悬浮窗，打开着才有
  let notePopList: ExecNote[] = []; // 悬浮窗里正在显示的详情
  let jobShowAllRuns = false; // 弹层里是否显示全部批次（默认只显示最近几个）
  const foldOpen = new Map<string, boolean>(); // 历史里用户手动展开 / 折叠过的块（批次 r|<批次>、函数 f|<批次>|<函数>）；没动过的按默认：有没完成的任务或失败就展开
  let foldKeys: { key: string; def: boolean }[] = []; // 最近一次渲染出来的全部可折叠块，「全部展开 / 折叠」用
  let jobWin: HTMLElement | null = null; // 历史窗口，打开着才有
  let jobApplying = ''; // 正在回写的任务 ID
  const jobRetryAt = new Map<string, number>(); // 任务 ID → 回写失败后最早什么时候再试
  let asyncFails: AsyncFail[] = [];
  const afailOpenKeys = new Set<string>(); // 展开着的异步失败明细（key = failKey：函数 id）
  let statusText = '';
  let statusKind: '' | 'error' | 'ok' = '';
  // 执行详情：函数声明了 type: 'message' 的出参，或 run 返回了批级 message 时收集到这里（只在内存里，刷新页面就没了）
  const noteLog: ExecNote[] = [];
  const callLog: CallRec[] = []; // 同步函数的调用记录
  let histTable = ''; // callLog / noteLog 当前对应哪张表
  let histUid = 0;
  let runNames: Record<string, string> = {}; // 批次（runId）的名字：命名过的批次超出保留上限时优先保留
  let renamingRun = false; // 正在给批次改名：此时历史窗口列表不重画，免得把输入框刷掉
  const hiddenJobs = new Set<string>(); // 在历史里点了「删除」的已写回任务（任务本身在服务端，这里只是不再显示）

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
    // 运行记录和筛选类记录分开计数，互不挤占
    let kept = list;
    for (const grp of [true, false]) {
      const inGrp = (e: HistoryEntry) => (e.kind === 'run') === grp;
      for (let i = kept.length - 1; i >= 0 && kept.filter(inGrp).length > HISTORY_LIMIT; i--) if (inGrp(kept[i]) && !kept[i].name) kept = kept.filter((_, k) => k !== i);
      let n = 0;
      kept = kept.filter(e => !inGrp(e) || ++n <= HISTORY_LIMIT);
    }
    try { localStorage.setItem(historyKey(), JSON.stringify(kept)); } catch { /* ignore */ }
  }
  // 每个批次运行时的配置单独存一份（不依赖运行历史：历史条目被删了、挤掉了，函数块的历史照样能复现）
  const runCfgKey = () => `annotator-auto-flush-runcfg:${host.getTableId()}`;
  function readRunCfgs(): Record<string, { at: number; config: Config }> { try { return JSON.parse(localStorage.getItem(runCfgKey()) || '{}') || {}; } catch { return {}; } }
  function saveRunCfg(runId: string, at: number) {
    const m = readRunCfgs(); m[runId] = { at, config: cloneConfig() };
    loadHist();
    const keys = Object.keys(m).sort((a, b) => Number(!!runNames[b]) - Number(!!runNames[a]) || m[b].at - m[a].at);
    keys.slice(HISTORY_LIMIT * 2).forEach(k => delete m[k]);
    try { localStorage.setItem(runCfgKey(), JSON.stringify(m)); } catch { /* ignore */ }
  }
  const readSeenAt = (runId: string) => readRunCfgs()[runId]?.at ?? 0;
  const runConfigOf = (runId: string): Config | null => readRunCfgs()[runId]?.config ?? readHistory().find(e => e.runId === runId)?.config ?? null;
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
      for (const f of fns) { // 执行详情出参不是写进字段的值：从 outputs 里拆出来，其余逻辑（选输出、必需入参）不用知道它
        f.noteOut = f.outputs.find(o => o.type === 'detail' || o.type === 'message')?.name;
        f.outputs = f.outputs.filter(o => o.type !== 'detail' && o.type !== 'message');
      }
      fnState = 'ready';
    } catch (e) {
      if (silent) return; // 静默刷新失败就沿用旧列表
      fnState = 'error';
      fnError = describeError(e, 'read');
    }
    if (!running) render();
    refreshJobs();
  }

  const outputKey = (fn: FnMeta, o: ParamMeta) => `${fn.id}.${o.name}`;
  function findOutput(key: string): { fn: FnMeta; out: ParamMeta } | null {
    for (const fn of fns) for (const out of fn.outputs) if (outputKey(fn, out) === key) return { fn, out };
    return null;
  }
  // 函数分组标记行（fn:<id>）→ 那个函数；不是这种行返回 null
  function findCall(key: string): FnMeta | null {
    return key.startsWith(FN_PREFIX) ? fns.find(f => FN_PREFIX + f.id === key) ?? null : null;
  }
  const outLabel = (key: string) => findCall(key)?.name || findOutput(key)?.out.label || key;
  // ── 输入映射：每个函数各管各的（config.inputs 的每一项带 fn = 函数 id）──
  // 一个函数分组当前需要的入参名：分组里有输出参数就是它们 requires 的并集（缺省为全部入参），没有输出参数（纯调用）就是全部入参；
  // 不在其中的入参在卡片里标“可选”：映射了就传给函数，不映射就不传
  function groupRequired(fn: FnMeta): Set<string> {
    const rows = config.outputs.filter(o => !o.param.startsWith(FN_PREFIX) && findOutput(o.param)?.fn.id === fn.id);
    if (!rows.length) return new Set(fn.inputs.map(i => i.name));
    return new Set(rows.flatMap(o => findOutput(o.param)!.out.requires || fn.inputs.map(i => i.name)));
  }
  const inputField = (fnId: string, param: string) => config.inputs.find(i => i.fn === fnId && i.param === param)?.fieldId ?? '';
  // 入参不来自字段（select / multiSelect / text）：值在卡片里直接填，整次运行每一行都传同一个值
  const isManual = (inp?: ParamMeta) => !!inp?.type;
  // 新建一行输入：字段入参的字段留空等用户选；其他取值方式先填上函数声明的默认值
  function newInput(fn: FnMeta, inp: ParamMeta): Mapping {
    if (!isManual(inp)) return { fn: fn.id, param: inp.name, fieldId: '' };
    const d = inp.default;
    return { fn: fn.id, param: inp.name, fieldId: '', value: inp.type === 'multiSelect' ? (Array.isArray(d) ? [...d] : []) : typeof d === 'string' ? d : '' };
  }
  // 填写的值有什么问题（没填、已经不是可选值），没问题返回空串
  function manualProblem(inp: ParamMeta, v: Mapping['value']): string {
    const allowed = new Set((inp.options || []).map(o => o.value));
    if (inp.type === 'text') return typeof v === 'string' && v.trim() ? '' : '还没有填写';
    if (inp.type === 'select') return typeof v !== 'string' || !v ? '还没有选择值' : allowed.has(v) ? '' : `的值“${v}”已不是可选值，请重新选择`;
    if (!Array.isArray(v) || !v.length) return '至少要勾选一个值';
    const stale = v.filter(x => !allowed.has(x));
    return stale.length ? `里有已不是可选值的项：${stale.join('、')}，请取消勾选` : '';
  }
  // 旧版输入是全局的（同名入参只映射一次，没有 fn）：函数列表加载好后，拆成各函数各自的映射
  function migrateLegacyInputs(c: Config): boolean {
    const legacy = c.inputs.filter(i => !i.fn);
    if (!legacy.length) return false;
    const used = new Set<string>();
    for (const o of c.outputs) { const fn = fnOfKey(o.param); if (fn) used.add(fn.id); }
    const migrated: Mapping[] = [];
    for (const fn of fns) {
      if (!used.has(fn.id)) continue;
      for (const inp of fn.inputs) {
        if (isManual(inp)) continue; // 旧版只有字段映射；现在不来自字段的入参由 ensureAllInputs 按默认值补
        const old = legacy.find(l => l.param === inp.name && l.fieldId);
        if (old) migrated.push({ fn: fn.id, param: inp.name, fieldId: old.fieldId });
      }
    }
    c.inputs = [...c.inputs.filter(i => i.fn), ...migrated];
    return true;
  }
  // 新加函数时：必需的入参里，在别的函数里配过同名参数的，直接沿用那个字段（各函数的映射仍然各自独立，之后可以单独改）。
  // 不来自字段的入参不沿用，由 ensureAllInputs 填上这个函数自己声明的默认值
  function prefillInputs(fn: FnMeta) {
    for (const name of groupRequired(fn)) {
      if (isManual(fn.inputs.find(i => i.name === name))) continue;
      if (config.inputs.some(i => i.fn === fn.id && i.param === name)) continue;
      const other = config.inputs.find(i => i.fn !== fn.id && i.param === name && i.fieldId);
      if (other) config.inputs.push({ fn: fn.id, param: name, fieldId: other.fieldId });
    }
  }
  // 每个用到的函数，把它必需的入参自动补成输入行（字段留空等用户选，不来自字段的填上默认值）；输入行本身和手动加的一样可以改参数、改字段
  function ensureAllInputs(): boolean {
    let changed = false;
    const done = new Set<string>();
    for (const o of config.outputs) {
      const fn = fnOfKey(o.param);
      if (!fn || done.has(fn.id)) continue;
      done.add(fn.id);
      for (const name of groupRequired(fn)) {
        const inp = fn.inputs.find(i => i.name === name);
        if (inp && !config.inputs.some(i => i.fn === fn.id && i.param === name)) { config.inputs.push(newInput(fn, inp)); changed = true; }
      }
    }
    return changed;
  }

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

  // 包含于 / 不包含于的拆分符：放在匹配条件和值之间的小下拉，点开是单选列表，最后一项“自定义”带输入框
  // 下拉框上直接显示拆分符本身：换行显示成 ↵，空格 / 制表符换成看得见的符号；自定义还没填时显示 ?
  function sepLabel(node: Cond): string {
    const v = node.sep === CUSTOM_SEP ? node.customSep ?? '' : node.sep || DEFAULT_SEP;
    return v ? v.replace(/\r?\n/g, '↵').replace(/\t/g, '⇥').replace(/ /g, '␣') : '?';
  }
  function sepPickerHtml(node: Cond, p: string): string {
    const open = sepOpen === p;
    const cur = node.sep || DEFAULT_SEP;
    const radio = (v: string, label: string, extra = '') => `<label class="af-ss-item af-in-chk"><input type="radio" name="sep-${p}" data-act="cond-sep" value="${esc(v)}"${v === cur ? ' checked' : ''} />${label}${extra}</label>`;
    return `<span class="af-ms af-sep${open ? ' open' : ''}"><button type="button" class="af-ms-btn af-sep-btn" data-act="sep-toggle" title="拆分符：值按它拆成多个，逐个比较（当前：${esc(sepLabel(node) === '?' ? '自定义，还没填' : sepLabel(node))}）"><span class="af-ms-text">${esc(sepLabel(node))}</span><span class="af-ms-caret">▾</span></button>` +
      (open ? `<div class="af-ss-pop af-ms-pop"><div class="af-ss-list">${SEPS.map(([v, l]) => radio(v, esc(l))).join('')}` +
        radio(CUSTOM_SEP, '自定义', `<input type="text" class="af-sep-custom" data-act="cond-sep-custom" value="${esc(node.customSep ?? '')}" placeholder="如 、" />`) + '</div></div>' : '') + '</span>';
  }

  function renderNode(node: Cond | Group, path: number[]): string {
    const p = path.join('.');
    if (node.kind === 'cond') {
      return `<div class="af-cond" data-path="${p}">
        <select data-act="cond-field" data-ss>${fieldOptions(node.fieldId)}</select>
        <select data-act="cond-op">${OPS.map(([v, l]) => `<option value="${v}"${v === node.op ? ' selected' : ''}>${l}</option>`).join('')}</select>
        ${LIST_OPS.has(node.op) ? sepPickerHtml(node, p) : ''}
        ${NO_VALUE_OPS.has(node.op) ? ''
          : LIST_OPS.has(node.op) ? `<textarea data-act="cond-value" rows="1" placeholder="多个值用所选拆分符分隔">${esc(node.value)}</textarea>`
          : `<input data-act="cond-value" type="text" value="${esc(node.value)}" placeholder="值" />`}
        <button class="af-x" data-act="del" title="删除条件">×</button>
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

  // ── 输出：按函数分组 ──
  // 选了某个函数的输出参数，就自动出现这个函数的分组，输出参数归到分组里；点函数右侧的 ＋ 就是手动建一个没有输出参数的分组（只调用函数）。
  // 配置仍是一维列表：param 是“函数 id.输出名”的是输出行；是“fn:函数 id”的是分组标记（让没有输出参数的分组也存在），显示时按函数归并。
  // 选择器的层级跟后端 functions/ 的目录结构一致：目录 → 函数 → 选项，所有目录和函数默认折叠，展开状态在本次会话里记住
  let pickerQuery = ''; // 选择器里的搜索词（选了一项后面板会重绘，搜索词要带过去）
  let pickerScope: string | null = null; // 展开中的选择器：'' = 整块底部的“＋函数”；函数 id = 该函数分组里的“＋ 输出参数”
  const pickerOpen = new Set<string>(); // 展开的目录 / 函数节点
  let msOpen: number | null = null; // 展开着勾选列表的多选输入行（config.inputs 的下标）
  let sepOpen: string | null = null; // 展开着拆分符列表的筛选条件（条件的 data-path）

  const fnOfKey = (key: string): FnMeta | null => findCall(key) ?? findOutput(key)?.fn ?? null;
  // 函数右侧的两个图标按钮：＋ / －（把这个函数加进来——没有输出参数的分组就是只调用；加了之后变成 －，点一下把它连同输出参数移除）、
  // 全选（加上全部输出参数；已经全加了就变成取消全选）。真正调用函数是在点“运行”的时候。withCall：是否带 ＋ / －（分组里的“＋ 输出参数”不需要）
  function fnTools(fn: FnMeta, present: Set<string>, withCall: boolean): string {
    const keys = fn.outputs.map(o => outputKey(fn, o));
    const allOn = keys.length > 0 && keys.every(k => present.has(k));
    const hasGroup = config.outputs.some(o => fnOfKey(o.param)?.id === fn.id);
    return '<span class="af-tn-tools">' +
      (withCall ? `<span class="af-ico${hasGroup ? ' on' : ''}" data-pick="${esc(FN_PREFIX + fn.id)}" title="${hasGroup ? '移除这个函数（连同已添加的输出参数）' : '添加这个函数：不选输出参数就是只调用、不写入字段；真正调用在点「运行」时'}">${hasGroup ? '－' : '＋'}</span>` : '') +
      (keys.length ? `<span class="af-ico${allOn ? ' on' : ''}" data-pick="${esc(ALL_PREFIX + fn.id)}" title="${allOn ? '取消全选：把这个函数已添加的输出参数全部移除' : '全选：一次加上这个函数的全部输出参数'}">${allOn ? '☑' : '☐'}</span>` : '') +
      '</span>';
  }

  // 输出参数的勾选列表：已添加的打勾，再点一下移除
  function renderOutputList(fn: FnMeta, present: Set<string>): string {
    return fn.outputs.map(o => {
      const k = outputKey(fn, o);
      return `<div class="af-opt${present.has(k) ? ' on' : ''}" data-pick="${esc(k)}"><span class="af-box"></span>${esc(o.label || o.name)}</div>`;
    }).join('') || '<div class="af-hint">这个函数没有输出参数</div>';
  }

  // 选择器顶部的搜索框（见 filterPicker）
  const PICK_SEARCH = '<div class="af-pick-search"><input type="text" class="af-pick-q" placeholder="搜索函数 / 输出参数…" /></div>';

  interface TreeNode { name: string; folders: Map<string, TreeNode>; fns: FnMeta[] }

  function renderPickerTree(present: Set<string>): string {
    const top: TreeNode = { name: '', folders: new Map(), fns: [] };
    for (const fn of fns) {
      let cur = top;
      for (const dir of fn.path || []) {
        if (!cur.folders.has(dir)) cur.folders.set(dir, { name: dir, folders: new Map(), fns: [] });
        cur = cur.folders.get(dir)!;
      }
      cur.fns.push(fn);
    }
    const open = (key: string) => (pickerOpen.has(key) ? ' open' : '');
    // 一行：左边是展开 / 折叠的标题，右边是（函数才有的）图标按钮——图标不在 data-tog 里，点它不会触发展开 / 折叠
    const head = (key: string, text: string, tools = '', tag = '') => `<div class="af-tn-row"><div class="af-tn-head" data-tog="${esc(key)}"><span class="af-tn-arrow"></span><span class="af-tn-name">${esc(text)}</span>${tag}</div>${tools}</div>`;
    const fnNode = (fn: FnMeta) => {
      const key = `f:${fn.id}`;
      return `<div class="af-tn af-tn-fn${open(key)}">${head(key, fn.name, fnTools(fn, present, true), (isSerial(fn) ? SERIAL_TAG : '') + (fn.async ? '<span class="af-async-tag" title="异步函数：下发后在服务端后台执行，完成后自动写回">异步</span>' : ''))}<div class="af-tn-kids">${renderOutputList(fn, present)}</div></div>`;
    };
    const walk = (n: TreeNode, prefix: string): string =>
      [...n.folders.values()].sort((x, y) => x.name.localeCompare(y.name, 'zh')).map(f => {
        const key = `d:${prefix}/${f.name}`;
        return `<div class="af-tn af-tn-dir${open(key)}">${head(key, f.name)}<div class="af-tn-kids">${walk(f, prefix + '/' + f.name)}</div></div>`;
      }).join('') + n.fns.map(fnNode).join('');
    return PICK_SEARCH + (walk(top, '') || '<div class="af-hint">没有可选的函数</div>');
  }

  // 分组里的“＋ 输出参数”：函数名一行（右侧只有全选），下面是输出参数的勾选列表
  function renderScopedPicker(fn: FnMeta, present: Set<string>): string {
    return `<div class="af-tn-row af-scope-head"><span class="af-tn-name">${esc(fn.name)}</span>${fnTools(fn, present, false)}</div>${fn.outputs.length > SS_MIN ? PICK_SEARCH : ''}${renderOutputList(fn, present)}`;
  }

  // 去掉一个输出参数行；它是分组里最后一个就把分组标记放回原位（分组留着变成纯调用，按首次出现的位置排序，所以不能放到末尾）
  function removeOutputAt(idx: number) {
    const removed = config.outputs.splice(idx, 1)[0];
    const fn = findOutput(removed.param)?.fn;
    if (fn && !config.outputs.some(o => fnOfKey(o.param)?.id === fn.id)) config.outputs.splice(idx, 0, { param: FN_PREFIX + fn.id, fieldId: '' });
  }

  // 在选择器里点了一项：
  //   ＋ / － → 把函数加进来（建一个没有输出参数的分组）；已经加过就把整个函数连同输出参数移除；
  //   输出参数全选 / 取消全选 → 加上它所有还没加的输出参数（已全加了就全部移除）；
  //   单个输出参数 → 没加就加上，加了就移除（勾选列表）。
  // 输出参数加进来后，自动归到所属函数的分组里（没有分组就自动建）。这些操作都不收起选择器，可以接着选
  function applyPick(pick: string) {
    const target = pick.startsWith(ALL_PREFIX) ? fns.find(f => ALL_PREFIX + f.id === pick) : pick.startsWith(FN_PREFIX) ? findCall(pick) : findOutput(pick)?.fn;
    const existed = !!target && config.outputs.some(o => fnOfKey(o.param)?.id === target.id);
    const have = new Set(config.outputs.map(o => o.param));
    const add = (param: string) => { if (!have.has(param)) { config.outputs.push({ param, fieldId: '' }); have.add(param); } };
    const remove = (param: string) => { const i = config.outputs.findIndex(o => o.param === param); if (i >= 0) removeOutputAt(i); };
    if (pick.startsWith(ALL_PREFIX)) {
      const fn = fns.find(f => ALL_PREFIX + f.id === pick);
      if (fn) {
        const keys = fn.outputs.map(o => outputKey(fn, o));
        if (keys.every(k => have.has(k))) keys.forEach(remove); else keys.forEach(add);
      }
    } else if (pick.startsWith(FN_PREFIX)) {
      const fn = findCall(pick);
      if (fn && config.outputs.some(o => fnOfKey(o.param)?.id === fn.id)) config.outputs = config.outputs.filter(o => fnOfKey(o.param)?.id !== fn.id); // 已加过：移除整个函数
      else add(pick);
    } else if (have.has(pick)) remove(pick);
    else add(pick);
    if (target && !existed && config.outputs.some(o => fnOfKey(o.param)?.id === target.id)) prefillInputs(target); // 刚建出的分组：沿用别处配过的同名入参
    // 在选择器里操作时，视野以选择器为主：加 / 删输出参数会让面板里的卡片变多变少、整体变高变矮，
    // 重绘后把面板滚到让选择器回到原来在屏幕上的位置，选择器自己的滚动位置也保持，操作的人看到的画面不动
    const before = container.querySelector('.af-pick-pop') as HTMLElement | null;
    const topBefore = before?.getBoundingClientRect().top ?? 0;
    const innerScroll = before?.scrollTop ?? 0;
    saveConfig();
    render();
    const pop = container.querySelector('.af-pick-pop') as HTMLElement | null;
    if (pop && before) {
      pop.scrollTop = innerScroll;
      for (let i = 0; i < 3; i++) { // 面板有缩放，滚动量和屏幕像素不完全 1:1，多校正两次
        const diff = pop.getBoundingClientRect().top - topBefore;
        if (Math.abs(diff) < 1) break;
        container.scrollTop += diff;
      }
    }
  }

  // 输入行右侧（箭头都是 ←）：字段入参是字段下拉；不来自字段的按声明是：单选下拉 / 多选下拉（点开是勾选列表）/ 文本框
  function inputValueHtml(inp: ParamMeta | undefined, m: Mapping, idx: number): string {
    if (!inp || !isManual(inp)) return `<span class="af-arrow">←</span><select data-act="in-field" data-ss>${fieldOptions(m.fieldId)}</select>`;
    const arrow = '<span class="af-arrow" title="这个入参不来自字段：在这里填的值会原样传给每一行">←</span>';
    if (inp.type === 'text') return `${arrow}<input type="text" class="af-in-text" data-act="in-text" value="${esc(typeof m.value === 'string' ? m.value : '')}" placeholder="输入值" />`;
    const opts = inp.options || [];
    if (inp.type === 'select') {
      const cur = typeof m.value === 'string' ? m.value : '';
      const stale = cur && !opts.some(o => o.value === cur);
      return `${arrow}<select data-act="in-value" data-ss><option value="">选择值</option>` +
        (stale ? `<option value="${esc(cur)}" selected>${esc(cur)}（已不是可选值）</option>` : '') +
        opts.map(o => `<option value="${esc(o.value)}"${o.value === cur ? ' selected' : ''}>${esc(o.label)}</option>`).join('') + '</select>';
    }
    const cur = Array.isArray(m.value) ? m.value : [];
    const stale = cur.filter(v => !opts.some(o => o.value === v)); // 函数改了可选值：旧值还勾着，让用户自己取消
    const box = (value: string, label: string, on: boolean, cls = '') => `<label class="af-ss-item af-in-chk${cls}"><input type="checkbox" data-act="in-multi" value="${esc(value)}"${on ? ' checked' : ''} />${esc(label)}</label>`;
    const open = msOpen === idx;
    return `${arrow}<span class="af-ms${open ? ' open' : ''}"><button type="button" class="af-ms-btn" data-act="ms-toggle" data-in="${idx}">${msSummary(inp, cur)}<span class="af-ms-caret">▾</span></button>` +
      (open ? `<div class="af-ss-pop af-ms-pop">${opts.length > SS_MIN ? '<input type="text" class="af-ss-input af-ms-q" placeholder="搜索…" />' : ''}<div class="af-ss-list">` +
        opts.map(o => box(o.value, o.label, cur.includes(o.value))).join('') + stale.map(v => box(v, `${v}（已不是可选值）`, true, ' stale')).join('') + '</div></div>' : '') + '</span>';
  }

  // 多选下拉框上显示的内容：已选的值（按可选值的顺序，不认识的旧值原样显示），没选显示占位提示
  function msSummary(inp: ParamMeta, values: string[]): string {
    const labelOf = new Map((inp.options || []).map(o => [o.value, o.label]));
    const text = values.map(v => labelOf.get(v) ?? v).join('、');
    return text ? `<span class="af-ms-text" title="${esc(text)}">${esc(text)}</span>` : '<span class="af-ms-text af-ms-ph">选择值（可多选）</span>';
  }

  // 卡片里的输入：这个函数的每个入参映射到哪个字段 / 填什么值（只属于这个函数）；当前输出参数不需要的入参标“可选”
  function renderCardInputs(fn: FnMeta): string {
    if (!fn.inputs.length) return '';
    const req = groupRequired(fn);
    const mine = config.inputs.map((m, i) => ({ m, i })).filter(x => x.m.fn === fn.id);
    const used = new Set(mine.map(x => x.m.param));
    const rows = mine.map(({ m, i }) => {
      const inp = fn.inputs.find(x => x.name === m.param);
      const locked = req.has(m.param); // 必需的入参：下拉可以展开看，但其他选项都置灰，不能换成别的参数
      return `<div class="af-row" data-in="${i}">
      <select data-act="in-param" class="af-fg-param" title="${esc((inp?.description ? inp.description + '\n' : '') + (locked ? '必需的入参，不能换成别的参数' : '这个函数的入参'))}">
        <option value=""${locked ? ' disabled' : ''}>选择参数</option>
        ${fn.inputs.map(x => `<option value="${esc(x.name)}"${x.name === m.param ? ' selected' : ''}${x.name !== m.param && (locked || used.has(x.name)) ? ' disabled' : ''}>${esc(x.label || x.name)}（${esc(x.name)}）</option>`).join('')}
      </select>
      ${inputValueHtml(inp, m, i)}
      ${req.has(m.param) ? '<span class="af-lock" title="必需：这个函数要运行就必须提供这个入参。选了输出参数时，是这些输出参数需要的入参；没选输出参数时，函数的全部入参都必需">必需</span>' : `<button class="af-x" data-act="del-in" data-in="${i}" title="删除这个输入">×</button>`}
      ${inp?.description ? `<div class="af-in-desc">${esc(inp.description)}</div>` : ''}
    </div>`;
    }).join('');
    return rows ? `<div class="af-iog in" title="输入：入参 ← 字段，或 入参 ← 填写的值"><span class="af-iog-label">输入</span><div class="af-iog-body">${rows}</div></div>` : '';
  }

  // 输出字段是可选的：选了，函数返回的结果就顺带写进这个字段；不选，就只调用、不写入
  function renderOutputs() {
    const groups = new Map<string, { name: string; fn: FnMeta | null; rows: number[] }>();
    config.outputs.forEach((m, i) => {
      const fn = fnOfKey(m.param);
      const key = fn ? fn.id : `missing:${m.param}`;
      if (!groups.has(key)) groups.set(key, { name: fn ? fn.name : '（函数已不存在）', fn, rows: [] });
      if (!findCall(m.param)) groups.get(key)!.rows.push(i); // 分组标记本身不显示成一行
    });
    const present = new Set(config.outputs.map(o => o.param));
    const rowHtml = (i: number) => {
      const m = config.outputs[i];
      const hit = findOutput(m.param);
      return `<div class="af-row" data-list="outputs" data-idx="${i}">
        <select data-act="out-param" class="af-fg-param" title="换成这个函数的另一个输出参数">
          ${hit ? '' : `<option value="${esc(m.param)}" selected>${esc(m.param)}（已不存在）</option>`}
          ${(hit?.fn.outputs ?? []).map(o => { const k = outputKey(hit!.fn, o); return `<option value="${esc(k)}"${k === m.param ? ' selected' : ''}${k !== m.param && present.has(k) ? ' disabled' : ''}>${esc(o.label || o.name)}</option>`; }).join('')}
        </select>
        <span class="af-arrow">→</span>
        <select data-act="field" data-ss title="输出字段是可选的：选了，函数返回的结果会顺带写入这个字段；不选，就只调用函数、不写入任何字段">${fieldOptions(m.fieldId)}</select>
        <button class="af-x" data-act="del" title="删除这个输出参数">×</button>
      </div>`;
    };
    const cards = [...groups.entries()].map(([key, g]) => `<div class="af-fg" data-fn="${esc(key)}">
      <div class="af-fg-head" title="${esc([...(g.fn?.path || []), g.name].join(' / '))}">
        <span class="af-fg-title"><span class="af-fg-name">${esc(g.name)}</span>${g.fn && isSerial(g.fn) ? SERIAL_TAG : ''}${g.fn?.async ? '<span class="af-async-tag" title="异步函数：点运行只下发数据，函数在服务端后台执行，完成后插件自动取回结果并写回字段（需要保持这张表的插件页面开着）">异步</span>' : ''}</span>
        <span class="af-fg-actions">
          ${g.fn ? `<button type="button" class="af-add" data-act="add-in" data-fn="${esc(g.fn.id)}" title="${g.fn.inputs.every(inp => config.inputs.some(i => i.fn === g.fn!.id && i.param === inp.name)) ? '这个函数的入参都已添加' : '给这个函数添加一个输入（入参 ← 字段）'}"${g.fn.inputs.every(inp => config.inputs.some(i => i.fn === g.fn!.id && i.param === inp.name)) ? ' disabled' : ''}>＋输入</button><span class="af-pick"><button type="button" class="af-add" data-act="pick-toggle" data-scope="${esc(g.fn.id)}" title="给这个函数添加输出参数" ${g.fn.outputs.length ? '' : 'disabled'}>＋输出</button>${pickerScope === g.fn.id ? `<div class="af-pick-pop">${renderScopedPicker(g.fn, present)}</div>` : ''}</span>` : ''}
          <button class="af-x af-x-group" data-act="del-group" data-fn="${esc(key)}" title="移除这个函数（连同它的全部输出参数）">×</button>
        </span>
      </div>
      ${g.fn ? renderCardInputs(g.fn) : ''}
      ${g.rows.length ? `<div class="af-iog out" title="输出：输出参数 → 字段（字段可选）"><span class="af-iog-label">输出</span><div class="af-iog-body">${g.rows.map(rowHtml).join('')}</div></div>` : ''}
    </div>`).join('');
    return `<div class="af-jobs-note">${jobNoteHtml()}</div>` + cards + `<span class="af-pick"><button type="button" class="af-add" data-act="pick-toggle" data-scope="" title="选一个函数或它的输出参数；选了输出参数会自动归到对应的函数分组，选「纯调用函数」就是手动建一个没有输出参数的分组">＋函数</button>${pickerScope === '' ? `<div class="af-pick-pop">${renderPickerTree(present)}</div>` : ''}</span>`;
  }

  // 块右上角的 ×：一键清空这个块里的内容（块里本来就是空的、或正在运行时置灰）
  const clearBtn = (act: string, what: string, empty: boolean) =>
    `<button class="af-x af-x-group" data-act="${act}" title="清空全部${what}"${empty || running || exporting ? ' disabled' : ''}>×</button>`;

  function render() {
    closeSS();
    loadConfig();
    if (fnState === 'ready') {
      const migrated = migrateLegacyInputs(config);
      if (ensureAllInputs() || migrated) saveConfig();
    }
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
        <section class="af-sec"><h4 class="af-h"><span>筛选 <span class="af-count"></span></span><span class="af-h-actions"><button class="af-pill" data-act="filter" title="读取视图记录，只计算命中数，不调用函数、不写入"${running || exporting ? ' disabled' : ''}>筛选</button><button class="af-pill" data-act="preview-filtered" title="在悬浮窗口里查看符合筛选条件的记录（全部可见字段）"${running || exporting ? ' disabled' : ''}>预览</button><button class="af-pill" data-act="filter-history" title="筛选历史：之前筛选 / 预览 / 统计 / 导出时用过的筛选条件，点一下即可恢复">历史</button><span class="af-menu-wrap"><button class="af-pill af-more" data-act="filter-menu" title="更多：统计、导出 CSV、导入 / 导出筛选条件">☰</button>${filterMenuOpen ? `<div class="menu af-menu"><button class="menu-item" data-act="stats-filtered" title="读取视图记录，对符合筛选条件的记录做统计（取值分布等），在新标签页里查看"${running || exporting ? ' disabled' : ''}>统计</button><button class="menu-item" data-act="export-filtered" title="把视图里符合筛选条件的记录（全部可见字段）导出为 CSV"${running || exporting ? ' disabled' : ''}>导出 CSV</button><button class="menu-item" data-act="filter-import" title="从文件导入筛选条件（会替换当前条件）"${running || exporting ? ' disabled' : ''}>筛选条件导入</button><button class="menu-item" data-act="filter-export" title="把当前筛选条件导出为文件，方便复用">筛选条件导出</button></div>` : ''}</span></span></h4>${renderNode(config.filter, [])}</section>
        <section class="af-sec af-sec-fn"><h4 class="af-h"><span>函数</span><span class="af-h-actions"><span class="af-jobs-badge-wrap" data-jobs-badge>${jobBadgeHtml()}</span>${clearBtn('clear-outputs', '函数', config.outputs.length === 0)}</span></h4>${renderOutputs()}</section>
        <div class="af-status${statusKind ? ' ' + statusKind : ''}">${esc(statusText).replace(/\n/g, '<br />')}</div>
        ${renderFailures()}`;
    }
    container.innerHTML = body;
    if (pickerScope !== null) {
      const qi = container.querySelector('.af-pick-q') as HTMLInputElement | null;
      if (qi) { qi.value = pickerQuery; filterPicker(); }
    }
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
    if (el.classList && el.classList.contains('af-afail')) { const k = el.dataset.fn || ''; if (el.open) afailOpenKeys.add(k); else afailOpenKeys.delete(k); }
    else if (el.classList && el.classList.contains('af-fail')) failOpen = el.open;
  }, true);

  // ── 带搜索的下拉：字段下拉（筛选条件的字段、函数输入 / 输出的字段）选项多于 SS_MIN 时，点开换成“搜索框 + 选项列表”的弹层。──
  // 底层仍是原来的 <select>：选中后改它的 value 再派发 change，原有的事件处理一行都不用动。
  // 弹层挂在 select 的父元素里（绝对定位），所以不受面板缩放影响
  let ssPop: HTMLElement | null = null;
  let ssSel: HTMLSelectElement | null = null;
  function closeSS() {
    if (ssPop) { ssPop.remove(); ssPop = null; ssSel = null; }
  }
  // 把命中的部分标出来
  function highlight(text: string, q: string): string {
    const i = q ? text.toLowerCase().indexOf(q) : -1;
    return i < 0 ? esc(text) : `${esc(text.slice(0, i))}<mark>${esc(text.slice(i, i + q.length))}</mark>${esc(text.slice(i + q.length))}`;
  }
  function openSS(sel: HTMLSelectElement) {
    closeSS();
    const opts = [...sel.options].map(o => ({ value: o.value, text: o.textContent || '', disabled: o.disabled }));
    const parent = sel.parentElement as HTMLElement;
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    const pop = document.createElement('div');
    pop.className = 'af-ss-pop';
    pop.innerHTML = '<input type="text" class="af-ss-input" placeholder="搜索…" /><div class="af-ss-list"></div>';
    pop.style.left = `${sel.offsetLeft}px`;
    pop.style.top = `${sel.offsetTop + sel.offsetHeight + 2}px`;
    pop.style.minWidth = `${Math.max(sel.offsetWidth, 180)}px`;
    parent.appendChild(pop);
    ssPop = pop;
    ssSel = sel;
    const input = pop.querySelector('.af-ss-input') as HTMLInputElement;
    const list = pop.querySelector('.af-ss-list') as HTMLElement;
    let shown = opts;
    let active = Math.max(0, opts.findIndex(o => o.value === sel.value));
    const draw = () => {
      const q = input.value.trim().toLowerCase();
      shown = q ? opts.filter(o => o.text.toLowerCase().includes(q)) : opts;
      if (active >= shown.length) active = shown.length - 1;
      if (active < 0) active = 0;
      list.innerHTML = shown.length
        ? shown.map((o, i) => `<div class="af-ss-item${o.value === sel.value ? ' sel' : ''}${o.disabled ? ' dis' : ''}${i === active ? ' on' : ''}" data-i="${i}">${highlight(o.text || '（未选择）', q)}</div>`).join('')
        : '<div class="af-ss-empty">没有匹配的选项</div>';
      const cur = list.querySelector('.on') as HTMLElement | null; // 键盘移动时，让高亮项留在列表可见范围内（只滚列表自己，不带动整个面板）
      if (cur) {
        if (cur.offsetTop < list.scrollTop) list.scrollTop = cur.offsetTop;
        else if (cur.offsetTop + cur.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = cur.offsetTop + cur.offsetHeight - list.clientHeight;
      }
    };
    const choose = (i: number) => {
      const o = shown[i];
      if (!o || o.disabled) return;
      sel.value = o.value;
      closeSS();
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    };
    list.addEventListener('mousedown', (e) => {
      e.preventDefault(); // 不让搜索框失焦
      const item = (e.target as HTMLElement).closest('.af-ss-item') as HTMLElement | null;
      if (item) choose(Number(item.dataset.i));
    });
    input.addEventListener('input', () => { active = 0; draw(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, shown.length - 1); draw(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); draw(); }
      else if (e.key === 'Enter') { e.preventDefault(); choose(active); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSS(); sel.focus(); }
      else if (e.key === 'Tab') closeSS();
    });
    draw();
    input.focus({ preventScroll: true });
    pop.scrollIntoView({ block: 'nearest' }); // 弹层在面板底部时，只在被挡住的情况下滚一点，让它完整出现在视野里
  }
  const searchable = (el: EventTarget | null): HTMLSelectElement | null => {
    const sel = (el as HTMLElement | null)?.closest?.('select[data-ss]') as HTMLSelectElement | null;
    return sel && !sel.disabled && sel.options.length > SS_MIN ? sel : null;
  };
  container.addEventListener('mousedown', (e) => {
    const sel = searchable(e.target);
    if (!sel) return;
    e.preventDefault(); // 不弹原生下拉
    sel.focus();
    if (ssSel === sel) closeSS(); else openSS(sel);
  });
  container.addEventListener('keydown', (e) => { // 键盘聚焦在下拉上时，Enter / 空格 / ↓ 也打开搜索弹层
    if (e.key === 'Enter' && (e.target as HTMLElement).classList?.contains('af-sep-custom')) { e.preventDefault(); closeMs(); return; } // 自定义拆分符填完回车：收起列表
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'ArrowDown') return;
    const sel = searchable(e.target);
    if (sel) { e.preventDefault(); openSS(sel); }
  });
  document.addEventListener('mousedown', (e) => { if (ssPop && !ssPop.contains(e.target as Node) && e.target !== ssSel) closeSS(); });

  // ── 函数选择器里的搜索：按目录 / 函数 / 输出参数的名字过滤；不匹配的隐藏，命中的目录和函数自动展开；
  // 目录名或函数名命中时，它下面的全部内容都保留。只改样式类，不重绘，所以输入时不会丢焦点 ──
  function filterPicker() {
    const pop = container.querySelector('.af-pick-pop') as HTMLElement | null;
    if (!pop) return;
    pop.querySelectorAll('.ss-hide, .ss-open').forEach(el => el.classList.remove('ss-hide', 'ss-open'));
    pop.querySelector('.af-pick-none')?.remove();
    const q = pickerQuery.trim().toLowerCase();
    if (!q) return;
    const has = (el: Element | null, force: boolean) => force || (el?.textContent || '').toLowerCase().includes(q);
    const visit = (n: HTMLElement, force: boolean): boolean => {
      const self = has(n.querySelector(':scope > .af-tn-row .af-tn-name'), force);
      let any = false;
      if (n.classList.contains('af-tn-fn')) {
        n.querySelectorAll<HTMLElement>(':scope > .af-tn-kids .af-opt').forEach(o => {
          const m = self || has(o, false);
          o.classList.toggle('ss-hide', !m);
          if (m) any = true;
        });
      } else {
        n.querySelectorAll<HTMLElement>(':scope > .af-tn-kids > .af-tn').forEach(c => { if (visit(c, self)) any = true; });
      }
      const show = self || any;
      n.classList.toggle('ss-hide', !show);
      n.classList.toggle('ss-open', any && !self); // 靠里面的内容命中的才自动展开；自己的名字命中，保持原来的折叠状态
      return show;
    };
    let hits = 0;
    pop.querySelectorAll<HTMLElement>(':scope > .af-tn').forEach(n => { if (visit(n, false)) hits++; });
    pop.querySelectorAll<HTMLElement>(':scope > .af-opt').forEach(o => { // 分组里的“＋输出参数”选择器没有树，直接过滤勾选项
      const m = has(o, false);
      o.classList.toggle('ss-hide', !m);
      if (m) hits++;
    });
    if (!hits) pop.insertAdjacentHTML('beforeend', '<div class="af-hint af-pick-none">没有匹配的函数或输出参数</div>');
  }
  function focusPickerQuery() {
    (container.querySelector('.af-pick-q') as HTMLInputElement | null)?.focus({ preventScroll: true });
  }

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
  // 历史窗口 / 执行详情悬浮窗：按 Esc 关闭（先关说明悬浮窗）
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (notePop) closeNotePop(); else if (jobWin) closeJobWin(); } });

  // 输出选择器：展开 / 折叠目录和函数（不重绘，只切样式）；点选一项
  document.addEventListener('click', (e) => {
    if (pickerScope !== null && !(e.target as HTMLElement).closest('.af-pick')) { pickerScope = null; render(); }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pickerScope !== null) { pickerScope = null; render(); } });
  // 多选输入的勾选列表、筛选条件的拆分符列表：点列表外面 / 按 Esc 收起（收起时重绘，已取消勾选的旧值随之消失）
  function closeMs() { if (msOpen !== null || sepOpen !== null) { msOpen = null; sepOpen = null; render(); } }
  document.addEventListener('click', (e) => { if ((msOpen !== null || sepOpen !== null) && !(e.target as HTMLElement).closest('.af-ms')) closeMs(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMs(); });

  container.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const tog = target.closest('[data-tog]') as HTMLElement | null;
    if (tog) {
      const node = tog.closest('.af-tn') as HTMLElement; // 标题外面还包着一行（放图标按钮），要找整个节点
      const key = tog.dataset.tog!;
      node.classList.toggle('open');
      if (node.classList.contains('open')) pickerOpen.add(key); else pickerOpen.delete(key);
      (container.querySelector('.af-pick-pop') as HTMLElement | null)?.scrollIntoView({ block: 'nearest' }); // 展开后选择器变高了：只在被挡住时才滚一点，保证它完整在视野里
      return;
    }
    const pick = target.closest('[data-pick]') as HTMLElement | null;
    if (pick) { applyPick(pick.dataset.pick!); focusPickerQuery(); return; }
    const btn = target.closest('button[data-act]') as HTMLElement | null;
    if (!btn) return;
    if (btn.dataset.act === 'pick-toggle') {
      const scope = btn.dataset.scope || '';
      pickerScope = pickerScope === scope ? null : scope;
      pickerQuery = '';
      render();
      focusPickerQuery();
      (container.querySelector('.af-pick-pop') as HTMLElement | null)?.scrollIntoView({ block: 'nearest' }); // 刚展开：保证选择器完整出现在视野里
      return;
    }
    pickerScope = null;
    const act = btn.dataset.act!;
    if (handleJobAct(act, btn)) return;
    if (act === 'ms-toggle') {
      const idx = Number(btn.dataset.in);
      msOpen = msOpen === idx ? null : idx;
      sepOpen = null;
      render();
      const pop = container.querySelector('.af-ms-pop') as HTMLElement | null;
      if (pop) { (pop.querySelector('.af-ms-q') as HTMLInputElement | null)?.focus({ preventScroll: true }); pop.scrollIntoView({ block: 'nearest' }); }
      return;
    }
    if (act === 'sep-toggle') {
      const p = (btn.closest('[data-path]') as HTMLElement).dataset.path!;
      sepOpen = sepOpen === p ? null : p;
      msOpen = null;
      render();
      (container.querySelector('.af-ms-pop') as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
      return;
    }
    msOpen = null; // 其他操作（增删条件 / 输入行）会让下标、路径错位：先收起展开着的列表
    sepOpen = null;
    if (act.startsWith('fail-')) { onFailAction(act, btn); return; }
    if (act.startsWith('afail-')) { onAsyncFailAction(act, btn); return; }
    const nodeEl = btn.closest('[data-path]') as HTMLElement | null;
    const rowEl = btn.closest('[data-list]') as HTMLElement | null;
    switch (act) {
      case 'add-cond': (nodeAt(nodeEl!.dataset.path!).node as Group).children.push({ kind: 'cond', fieldId: '', op: 'contains', value: '' }); break;
      case 'add-group': (nodeAt(nodeEl!.dataset.path!).node as Group).children.push(emptyGroup()); break;
      case 'del':
        if (rowEl) {
          const idx = Number(rowEl.dataset.idx);
          removeOutputAt(idx); // 删掉分组里最后一个输出参数，分组留着变成纯调用；要移除整个函数点分组右上角的 ×
        }
        else if (nodeEl) { const { parent, index } = nodeAt(nodeEl.dataset.path!); parent?.children.splice(index, 1); }
        break;
      case 'clear-filter': config.filter = emptyGroup(); break;
      case 'clear-outputs': config.outputs = []; config.inputs = []; break;
      case 'add-in': { // 新加一行输入：默认选这个函数里第一个还没用的入参（可以再改）
        const fn = fns.find(f => f.id === btn.dataset.fn);
        const free = fn?.inputs.find(inp => !config.inputs.some(i => i.fn === fn.id && i.param === inp.name));
        if (fn && free) config.inputs.push(newInput(fn, free));
        break;
      }
      case 'del-in': config.inputs.splice(Number(btn.dataset.in), 1); break;
      case 'del-group': { // 移除整个函数分组：它的全部输出参数一起删
        const key = btn.dataset.fn!;
        config.outputs = config.outputs.filter(o => (fnOfKey(o.param)?.id ?? `missing:${o.param}`) !== key);
        break;
      }
      case 'reload-fns': loadFunctions(); return;
      case 'filter-menu': filterMenuOpen = !filterMenuOpen; render(); return;
      case 'filter': applyFilter(); return;
      case 'preview-filtered': previewFiltered(); return;
      case 'stats-filtered': closeFilterMenu(); statsFiltered(); return;
      case 'filter-history': closeFilterMenu(); openHistory('filter'); return;
      case 'export-filtered': closeFilterMenu(); exportFiltered(); return;
      case 'filter-export': closeFilterMenu(); exportFilterConditions(); return;
      case 'filter-import': closeFilterMenu(); importFilterConditions(); return;
    }
    saveConfig();
    render();
  });

  container.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement | HTMLTextAreaElement;
    if (el.classList && el.classList.contains('af-pick-q')) { pickerQuery = el.value; filterPicker(); return; }
    if (el.classList && el.classList.contains('af-ms-q')) { // 多选勾选列表里的搜索：只隐藏不匹配的项，不重绘
      const q = el.value.trim().toLowerCase();
      el.closest('.af-ms-pop')?.querySelectorAll<HTMLElement>('.af-in-chk').forEach(x => x.classList.toggle('ss-hide', !!q && !(x.textContent || '').toLowerCase().includes(q)));
      return;
    }
    if (el.dataset.act === 'in-text') { // 输入行的文本值：边输入边存，不重绘（重绘会丢焦点）
      const m = config.inputs[Number((el.closest('[data-in]') as HTMLElement | null)?.dataset.in)];
      if (m) { m.value = el.value; saveConfig(); }
      return;
    }
    const nodeEl = el.closest('[data-path]') as HTMLElement | null;
    if (!nodeEl) return;
    if (el.dataset.act === 'cond-value') {
      (nodeAt(nodeEl.dataset.path!).node as Cond).value = el.value;
    } else if (el.dataset.act === 'cond-sep-custom') {
      // 往自定义框里输入时，自动选中它前面的单选框，下拉框上显示的拆分符跟着变
      const cond = nodeAt(nodeEl.dataset.path!).node as Cond;
      cond.customSep = el.value;
      cond.sep = CUSTOM_SEP;
      const radio = el.closest('label')?.querySelector('input[type="radio"]') as HTMLInputElement | null;
      if (radio) radio.checked = true;
      const text = nodeEl.querySelector(':scope > .af-sep .af-ms-text');
      if (text) text.textContent = sepLabel(cond);
    } else return;
    saveConfig();
    updateFilterCount();
  });

  container.addEventListener('change', (e) => {
    const el = e.target as HTMLSelectElement | HTMLInputElement;
    const act = el.dataset.act;
    if (!act || act === 'cond-sep-custom' || act === 'in-text') return;
    const inRow = el.closest('[data-in]') as HTMLElement | null;
    if (inRow && act.startsWith('in-')) { // 卡片里的输入行：入参 / 字段 / 填写的值
      const idx = Number(inRow.dataset.in);
      const m = config.inputs[idx];
      if (m && act === 'in-param') {
        const fn = fns.find(f => f.id === m.fn);
        if (fn && groupRequired(fn).has(m.param)) { render(); return; } // 必需的入参不能换（选项已置灰，这里兜底），重绘恢复原来的选择
        // 换参数：字段入参之间换，字段保留；只要涉及不来自字段的入参，就按新参数重建这一行（填上它的默认值）
        const next = fn?.inputs.find(i => i.name === el.value);
        if (fn && next && (isManual(next) || isManual(fn.inputs.find(i => i.name === m.param)))) config.inputs[idx] = newInput(fn, next);
        else m.param = el.value;
      } else if (m && act === 'in-field') m.fieldId = el.value;
      else if (m && act === 'in-value') m.value = el.value;
      else if (m && act === 'in-multi') {
        // 勾选列表开着时不重绘（保住列表的滚动位置和搜索词），只更新下拉框上显示的已选值
        m.value = [...inRow.querySelectorAll<HTMLInputElement>('input[data-act="in-multi"]:checked')].map(x => x.value); // 按可选值的顺序
        saveConfig();
        const inp = fns.find(f => f.id === m.fn)?.inputs.find(i => i.name === m.param);
        const text = inRow.querySelector('.af-ms-text');
        if (inp && text) text.outerHTML = msSummary(inp, m.value);
        return;
      }
      saveConfig();
      render();
      return;
    }
    const nodeEl = el.closest('[data-path]') as HTMLElement | null;
    const rowEl = el.closest('[data-list]') as HTMLElement | null;
    if (rowEl) {
      const m = config.outputs[Number(rowEl.dataset.idx)];
      if (act === 'out-param') m.param = el.value; // 输出行：换成同一个函数的另一个输出参数（已被别的行用了的置灰）
      else if (act === 'field') m.fieldId = el.value;
    } else if (nodeEl) {
      const node = nodeAt(nodeEl.dataset.path!).node;
      if (node.kind === 'cond') {
        if (act === 'cond-field') node.fieldId = el.value;
        else if (act === 'cond-op') node.op = el.value;
        else if (act === 'cond-sep') {
          node.sep = el.value;
          if (el.value !== CUSTOM_SEP) sepOpen = null; // 选了固定的拆分符就收起；选自定义留着，接着在框里输入
        }
      } else if (act === 'logic') node.logic = el.value as 'and' | 'or';
      else if (act === 'negate') node.negate = (el as HTMLInputElement).checked;
    }
    saveConfig();
    render();
    if (act === 'cond-sep' && el.value === CUSTOM_SEP) (container.querySelector(`[data-path="${nodeEl!.dataset.path}"] .af-sep-custom`) as HTMLInputElement | null)?.focus({ preventScroll: true });
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
    if (config.outputs.length === 0) return '请至少添加一个函数';
    for (const o of config.outputs) {
      if (o.param.startsWith(FN_PREFIX)) { // 只调用的函数：不需要字段
        if (!findCall(o.param)) return '函数已不存在（可能被删除），请重新选择';
        continue;
      }
      if (!o.param) return '函数里有未选择的输出参数';
      if (!findOutput(o.param)) return `输出参数“${o.param}”已不存在（函数可能被删除），请重新选择`;
      if (!o.fieldId) continue; // 没选字段：只取结果、不写入
      const field = host.getAllFields().find(f => f.id === o.fieldId);
      if (!field) return '函数的输出字段已不存在，请重新选择（可点右上角 ↻ 刷新字段）';
      if (!WRITABLE_TYPES.has(field.type)) {
        return `输出字段“${field.name}”是${FIELD_TYPE_NAMES[field.type] || '当前'}类型，暂不支持写入，目前支持：文本、数字、货币、进度、评分、单选、多选、日期、复选框、电话、邮箱、超链接、人员，请换一个字段`;
      }
    }
    const outFields = config.outputs.filter(o => !o.param.startsWith(FN_PREFIX) && o.fieldId).map(o => o.fieldId);
    if (new Set(outFields).size !== outFields.length) return '多个输出参数写入了同一个字段';
    const calls = config.outputs.filter(o => o.param.startsWith(FN_PREFIX)).map(o => o.param);
    if (new Set(calls).size !== calls.length) return '同一个函数被选了多次';
    // 每个函数需要的入参都要映射到字段（不来自字段的入参要填好值）
    const fieldIds = new Set(host.getAllFields().map(f => f.id));
    const checked = new Set<string>();
    for (const o of config.outputs) {
      const fn = fnOfKey(o.param);
      if (!fn || checked.has(fn.id)) continue;
      checked.add(fn.id);
      for (const name of groupRequired(fn)) {
        const inp = fn.inputs.find(i => i.name === name);
        if (isManual(inp)) continue; // 输入行由 ensureAllInputs 保证存在，值在下面逐行检查
        if (!inputField(fn.id, name)) return `函数“${fn.name}”缺少输入参数“${inp?.label || name}”的字段`;
      }
      for (const m of config.inputs.filter(i => i.fn === fn.id)) {
        if (!m.param) return `函数“${fn.name}”的输入项里有未选完整的参数或字段`;
        const inp = fn.inputs.find(i => i.name === m.param);
        if (!inp) return `函数“${fn.name}”已经没有入参“${m.param}”，请删掉这一行输入或换一个参数`;
        if (isManual(inp)) {
          const why = manualProblem(inp, m.value);
          if (why) return `函数“${fn.name}”的输入“${inp.label || inp.name}”${why}`;
          continue;
        }
        if (!m.fieldId) return `函数“${fn.name}”的输入项里有未选完整的参数或字段`;
        if (!fieldIds.has(m.fieldId)) return `函数“${fn.name}”的输入字段已不存在，请重新选择（可点右上角 ↻ 刷新字段）`;
      }
    }
    return null;
  }

  // 这里抛出的错误都是已经带上函数名的中文说明，用 describedError 标记，避免被通用翻译二次改写
  async function callFunction(fn: FnMeta, rows: Record<string, any>[]): Promise<{ results: FnResult[]; message?: string }> {
    const prefix = `函数“${fn.name}”调用失败：`;
    const waitStart = Date.now();
    let res: Response;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch(apiUrl(`api/functions/${encodeURIComponent(fn.id)}/run`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rows, wait: attempt === 0 ? 1500 : undefined }), // 第一次请求只等 1.5 秒，轮不到就马上回“排队中”让状态栏及时提示；之后的重试才等满
        });
      } catch (e) {
        throw describedError(prefix + describeError(e, 'read'));
      }
      // 声明了 serializeCalls 的函数同一时间只执行一批：轮不到时服务端过一会儿回 202（还在排队），这里自动重试，状态栏提示在排队
      if (res.status !== 202) break;
      if (cancelled) throw describedError(`已取消，函数“${fn.name}”还在排队等待其他调用，未执行`);
      setStatus(`函数“${fn.name}”同一时间只执行一批，正在排队等待其他调用完成…（已等 ${fmtDuration(Date.now() - waitStart)}，可点取消）`, '');
    }
    if (!res.ok) throw describedError(prefix + await serverMessage(res));
    let data: any;
    try { data = await res.json(); } catch { throw describedError(prefix + '后端返回的不是合法数据'); }
    if (!data || !Array.isArray(data.results) || data.results.length !== rows.length) throw describedError(prefix + '返回的结果条数与请求不一致');
    return { results: data.results, message: typeof (data.detail ?? data.message) === 'string' ? (data.detail ?? data.message) : undefined };
  }

  // ── 异步函数：下发任务、取回结果并用前端 SDK 写回 ──────────
  // 只有声明了 async: true 的函数走这条路；普通函数完全不涉及（不调用任务接口、服务端也不存任何东西）。
  // 流程：下发一批行 → 服务端后台执行并落盘 → 插件开着时取回结果（认领）→ 用 SDK 写回表格 → 确认。
  // 回写所需的信息（记录 ID、输出字段）随任务一起存在服务端，所以下发后刷新页面、甚至关掉再开，都能接着写回。
  async function jobApi(path: string, body?: any): Promise<any> {
    const res = await fetch(apiUrl(path), body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(await serverMessage(res));
    return res.json();
  }

  async function dispatchJob(fn: FnMeta, rows: Record<string, any>[], meta: JobMeta): Promise<void> {
    const prefix = `函数“${fn.name}”下发失败：`;
    try {
      await jobApi(`api/functions/${encodeURIComponent(fn.id)}/jobs`, { rows, scope: host.getScope(), meta });
    } catch (e) {
      throw describedError(prefix + describeError(e, 'read'));
    }
  }

  const asyncFailKey = () => `annotator-auto-flush-async-fail:${host.getTableId()}`;
  function loadAsyncFails(): AsyncFail[] {
    try { const list = JSON.parse(localStorage.getItem(asyncFailKey()) || '[]'); return Array.isArray(list) ? list : []; } catch { return []; }
  }
  function saveAsyncFails(add: AsyncFail[]) {
    if (add.length === 0) return;
    const ids = new Set(add.map(f => f.jobId));
    asyncFails = [...add, ...asyncFails.filter(f => !ids.has(f.jobId))].slice(0, ASYNC_FAIL_LIMIT); // 同一个任务重复回写时，只留最新一份
    try { localStorage.setItem(asyncFailKey(), JSON.stringify(asyncFails)); } catch { /* ignore */ }
  }

  // 把一个已完成任务的结果写回表格；返回一句摘要（会随确认一起存到服务端）。出错就抛异常，任务会被放开认领、稍后重试
  async function writeBackJob(job: any): Promise<string> {
    const meta: JobMeta | null = job.meta;
    const results: FnResult[] | null = job.results;
    if (!meta || !Array.isArray(meta.recordIds)) throw new Error('任务缺少回写信息');
    const fieldById = new Map(host.getAllFields().map(f => [f.id, f]));
    const fails: AsyncFail[] = [];
    const addFail = (i: number, error: string) => fails.push({ jobId: job.id, runId: meta.run?.id, fnId: job.fnId, index: meta.indexes[i] || 0, recordId: meta.recordIds[i], fnName: job.fnName, error, time: Date.now() });
    if (job.status === 'failed' || !results) {
      const why = job.error || '函数执行失败';
      meta.recordIds.forEach((_, i) => addFail(i, why));
      saveAsyncFails(fails);
      return `整批失败：${why}（${meta.recordIds.length} 条）`;
    }
    if (results.length !== meta.recordIds.length) throw new Error('结果条数与下发的记录数不一致');
    const noteFn = fns.find(f => f.id === job.fnId) ?? { id: job.fnId, name: job.fnName, inputs: [], outputs: [] } as FnMeta;
    pushNote(makeNote(noteFn, results, typeof (job.detail ?? job.message) === 'string' ? (job.detail ?? job.message) : undefined, meta.indexes, true, meta.run ? { id: meta.run.id, at: meta.run.at, part: meta.run.part, parts: meta.run.parts } : undefined));
    const optionsOf = new Map<string, FieldOption[]>();
    for (const o of meta.outs) {
      const f = fieldById.get(o.fieldId);
      if (f && needsOptions(f.type) && !optionsOf.has(o.fieldId)) optionsOf.set(o.fieldId, await host.getFieldOptions(o.fieldId));
    }
    const items: { i: number; recordId: string; fields: Record<string, any> }[] = [];
    let skipped = 0, called = 0;
    results.forEach((r, i) => {
      if (!r.ok) { addFail(i, r.error || '函数执行失败'); return; }
      const values: Record<string, any> = {};
      try {
        for (const o of meta.outs) {
          const f = fieldById.get(o.fieldId);
          if (!f) throw new Error('输出字段已不存在');
          if (!r.outputs || !(o.name in r.outputs)) throw new Error(`函数“${job.fnName}”没有返回“${o.name}”`);
          if (r.outputs[o.name] === null) continue; // 函数返回 null：这个字段不写入，保留原值
          values[o.fieldId] = toFieldValue(f, r.outputs[o.name], optionsOf.get(o.fieldId));
        }
      } catch (e) { addFail(i, e instanceof Error ? e.message : String(e)); return; }
      if (meta.outs.length === 0) called++; // 只调用的函数：没有要写的内容
      else if (Object.keys(values).length === 0) skipped++;
      else items.push({ i, recordId: meta.recordIds[i], fields: values });
    });
    let written = 0;
    for (let s = 0; s < items.length; s += WRITE_BATCH) {
      const part = items.slice(s, s + WRITE_BATCH);
      try {
        await host.writeRecords(part.map(x => ({ recordId: x.recordId, fields: x.fields })));
        written += part.length;
      } catch (batchErr) {
        // 整批失败：可能只是其中某条记录已被删除，逐条写，只让真正有问题的行失败；
        // 逐条也全失败，说明是网络 / 权限这类整体问题，抛出去让任务稍后重试，不要当成这些行失败
        let ok = 0;
        for (const x of part) {
          try { await host.writeRecords([{ recordId: x.recordId, fields: x.fields }]); ok++; }
          catch (e) { addFail(x.i, describeError(e, 'write')); }
        }
        if (ok === 0) throw batchErr;
        written += ok;
      }
    }
    saveAsyncFails(fails);
    return (meta.outs.length ? `写入 ${written} 条` : `已调用 ${called} 条`) + (fails.length ? `，失败 ${fails.length} 条` : '') + (skipped ? `，跳过 ${skipped} 条` : '');
  }

  async function applyJob(s: JobSummary, scope: string) {
    let claim: any;
    try { claim = await jobApi(`api/jobs/${s.id}/claim`, { scope }); }
    catch { return; } // 被别的页面认领了 / 状态变了：下次轮询再看
    const job = claim.job;
    const token = String(claim.token);
    jobApplying = job.id;
    updateJobsView();
    try {
      const result = await writeBackJob(job);
      await jobApi(`api/jobs/${job.id}/ack`, { token, result });
      s.status = 'applied'; s.result = result; s.appliedAt = Date.now();
      jobRetryAt.delete(job.id);
    } catch (e) {
      jobRetryAt.set(job.id, Date.now() + JOB_RETRY_BACKOFF);
      jobNote = `异步任务“${job.fnName}”回写失败：${describeError(e, 'write')}，稍后会自动重试`;
      try { await jobApi(`api/jobs/${job.id}/release`, { token }); } catch { /* 认领过一会儿自己会失效 */ }
    } finally {
      jobApplying = '';
    }
  }

  // 刷新任务列表，并回写已经完成的任务。批处理正在运行（同步函数在写表）时只刷新列表，回写等它结束后的下一次轮询
  async function refreshJobs() {
    clearTimeout(jobTimer);
    const scope = host.getScope();
    if (!scope) return;
    if (jobBusy) { scheduleJobPoll(); return; }
    jobBusy = true;
    try {
      if (scope !== jobScope) { jobScope = scope; jobList = []; asyncFails = loadAsyncFails(); jobRetryAt.clear(); }
      if (fns.some(f => f.async) || jobList.length > 0) {
        jobList = (await jobApi(`api/jobs?scope=${encodeURIComponent(scope)}`)).jobs;
        jobNote = '';
        updateJobsView();
        if (!running) {
          for (const j of jobList) {
            if ((j.status === 'done' || j.status === 'failed') && !j.claimed && (jobRetryAt.get(j.id) || 0) <= Date.now()) await applyJob(j, scope);
          }
        }
      }
    } catch (e) {
      jobNote = `异步任务状态获取失败：${describeError(e, 'read')}`;
    } finally {
      jobBusy = false;
      updateJobsView();
      scheduleJobPoll();
    }
  }

  function scheduleJobPoll() {
    clearTimeout(jobTimer);
    // 没有异步函数、也没有未完成的任务（已回写 / 已取消的不用再盯）：不轮询
    if (!fns.some(f => f.async) && !jobList.some(j => j.status !== 'applied' && j.status !== 'cancelled')) return;
    const active = jobList.some(j => j.status === 'queued' || j.status === 'running'
      || ((j.status === 'done' || j.status === 'failed') && (jobRetryAt.get(j.id) || 0) <= Date.now()));
    jobTimer = setTimeout(refreshJobs, active ? JOB_POLL_ACTIVE : JOB_POLL_IDLE);
  }

  async function cancelJob(id: string) {
    const j = jobList.find(x => x.id === id);
    if (!j) return;
    if (!confirm(`取消“${j.fnName}”的这个任务（${j.count} 条）？\n已经在运行的任务无法中断，但它的结果不会再写回表格。`)) return;
    try { await jobApi(`api/jobs/${id}/cancel`, { scope: host.getScope() }); }
    catch (e) { jobNote = `取消失败：${describeError(e, 'read')}`; }
    refreshJobs();
  }

  const fmtDuration = (ms: number) => {
    const sec = Math.max(0, Math.round(ms / 1000));
    return sec < 60 ? `${sec} 秒` : sec < 3600 ? `${Math.floor(sec / 60)} 分钟` : `${Math.floor(sec / 3600)} 小时 ${Math.floor(sec % 3600 / 60)} 分钟`;
  };

  // 图标（线条风格，颜色跟随文字色）：转圈 = 正在进行，钟 = 等待，对勾 = 完成，叹号 = 出错，列表 = 任务
  type IcoKind = 'spin' | 'clock' | 'check' | 'alert' | 'refresh' | 'list' | 'expand' | 'collapse' | 'chevron' | 'down1' | 'down2' | 'restore' | 'copy' | 'trash';
  function ico(kind: IcoKind): string {
    const paths: Record<IcoKind, string> = {
      copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
      trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>',
      expand: '<path d="m7 7 5 5 5-5"/><path d="m7 13 5 5 5-5"/>',
      collapse: '<path d="m7 11 5-5 5 5"/><path d="m7 18 5-5 5 5"/>',
      chevron: '<path d="m9 6 6 6-6 6"/>',
      restore: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>',
      down1: '<path d="m6 9 6 6 6-6"/>',
      down2: '<path d="m6 5 6 6 6-6"/><path d="m6 12 6 6 6-6"/>',
      spin: '<path d="M21 12a9 9 0 1 1-6.2-8.56"/>',
      clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
      check: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>',
      alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><path d="M12 16.2v.3"/>',
      refresh: '<path d="M20 11a8 8 0 0 0-14.3-4.3L4 8.5"/><path d="M4 4v4.5h4.5"/><path d="M4 13a8 8 0 0 0 14.3 4.3L20 15.5"/><path d="M20 20v-4.5h-4.5"/>',
      list: '<path d="M9 6h11"/><path d="M9 12h11"/><path d="M9 18h11"/><path d="M4.5 6h.01"/><path d="M4.5 12h.01"/><path d="M4.5 18h.01"/>',
    };
    return `<svg class="af-svg${kind === 'spin' ? ' af-spin' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[kind]}</svg>`;
  }

  // ── 历史记录的数据 ──────────────────────────────
  // 函数除了返回值，还可以返回执行详情（出参 type: 'message'，或 run 返回的批级 message），面板每调用一批就收集一份。
  // 同步函数的每次调用也记一条（CallRec），和异步任务、说明一起放进「函数」块右上角的「历史」里，按「批次 → 函数 → 每次调用」分层。
  const histKey = () => `annotator-auto-flush-hist:${host.getTableId()}`;
  function loadHist() {
    const t = host.getTableId();
    if (t === histTable) return;
    histTable = t;
    callLog.length = 0;
    noteLog.length = 0;
    hiddenJobs.clear();
    runNames = {};
    try {
      const d = JSON.parse(localStorage.getItem(histKey()) || '{}');
      if (Array.isArray(d.calls)) callLog.push(...d.calls);
      if (Array.isArray(d.notes)) noteLog.push(...d.notes);
      if (Array.isArray(d.hidden)) d.hidden.forEach((id: any) => hiddenJobs.add(String(id)));
      if (d.names && typeof d.names === 'object') for (const k of Object.keys(d.names)) if (typeof d.names[k] === 'string' && d.names[k]) runNames[k] = d.names[k];
    } catch { /* 存档坏了就当没有 */ }
    histUid = Math.max(histUid, ...callLog.map(c => c.uid), ...noteLog.map(n => n.uid));
  }
  function saveHist() {
    for (let i = 0; i < 3; i++) {
      try { localStorage.setItem(histKey(), JSON.stringify({ calls: callLog, notes: noteLog, hidden: [...hiddenJobs].slice(-500), names: runNames })); return; }
      catch { callLog.splice(0, Math.ceil(callLog.length / 2)); noteLog.splice(0, Math.ceil(noteLog.length / 2)); } // 超出配额：丢掉较早的一半再试
    }
  }
  // 历史最多保留 HISTORY_LIMIT 个批次：命名过的优先保留（即使比较旧），其余按最近的保留；超出的批次连同它的调用记录和详情一起丢掉
  function trimHist() {
    const at = new Map<string, number>();
    [...callLog, ...noteLog].forEach(x => at.set(x.runId, Math.max(at.get(x.runId) || 0, x.runAt || x.time)));
    if (at.size <= HISTORY_LIMIT) return;
    const keep = new Set([...at.keys()].sort((a, b) => Number(!!runNames[b]) - Number(!!runNames[a]) || at.get(b)! - at.get(a)!).slice(0, HISTORY_LIMIT));
    const calls = callLog.filter(x => keep.has(x.runId)), notes = noteLog.filter(x => keep.has(x.runId));
    callLog.length = 0; callLog.push(...calls);
    noteLog.length = 0; noteLog.push(...notes);
    for (const k of Object.keys(runNames)) if (!keep.has(k) && at.has(k)) delete runNames[k];
  }
  const idxRange = (indexes: number[]) => { const nums = indexes.filter(n => n > 0); return { from: nums.length ? Math.min(...nums) : 0, to: nums.length ? Math.max(...nums) : 0 }; };
  type RunRef = { id: string; at: number; part: number; parts: number };

  function makeCall(fn: FnMeta, indexes: number[], run: RunRef, results: FnResult[], ms: number, error?: string): CallRec {
    const ok = results.filter(r => r.ok).length;
    return { uid: ++histUid, runId: run.id, runAt: run.at, fnId: fn.id, fnName: fn.name, part: run.part, parts: run.parts, ...idxRange(indexes), time: Date.now(), ok, failed: error ? 0 : results.length - ok, ms, ...(error ? { error } : {}) };
  }
  function makeNote(fn: FnMeta, results: FnResult[], batch: string | undefined, indexes: number[], isAsync: boolean, run?: RunRef): ExecNote | null {
    const all: { index: number; text: string }[] = [];
    if (fn.noteOut) {
      results.forEach((r, i) => {
        const t = r.ok ? r.outputs?.[fn.noteOut!] : undefined;
        if (typeof t === 'string' && t.trim()) all.push({ index: indexes[i] || 0, text: t.length > NOTE_ROW_CHARS ? t.slice(0, NOTE_ROW_CHARS) + '…' : t });
      });
    }
    if (!batch && all.length === 0) return null;
    const rows = all.slice(0, NOTE_ROWS_MAX);
    return { uid: ++histUid, runId: run?.id ?? '', runAt: run?.at ?? 0, fnId: fn.id, part: run?.part ?? 0, parts: run?.parts ?? 0, time: Date.now(), fnName: fn.name, ...idxRange(indexes),
      batch: batch && batch.length > NOTE_ROW_CHARS * 4 ? batch.slice(0, NOTE_ROW_CHARS * 4) + '…' : batch, rows, ...(all.length > rows.length ? { more: all.length - rows.length } : {}), async: isAsync };
  }

  function pushCall(c: CallRec) {
    loadHist();
    callLog.push(c);
    trimHist();
    saveHist();
    updateJobsView();
  }
  function pushNote(note: ExecNote | null) {
    if (!note) return;
    loadHist();
    noteLog.push(note);
    trimHist();
    saveHist();
    updateJobsView();
  }

  function noteInnerHtml(n: ExecNote): string {
    const same = n.rows.length > 1 && n.rows.every(r => r.text === n.rows[0].text); // 每行详情都一样：只列一次
    const rowsHtml = same
      ? `<div class="af-note-row"><span class="af-note-idx">全部 ${n.rows.length} 行</span><pre>${esc(n.rows[0].text)}</pre></div>`
      : n.rows.map(r => `<div class="af-note-row"><span class="af-note-idx">${r.index ? `第 ${r.index} 条` : '—'}</span><pre>${esc(r.text)}</pre></div>`).join('');
    return (n.batch ? `<div class="af-note-batch"><pre>${esc(n.batch)}</pre></div>` : '') + rowsHtml + (n.more ? `<div class="af-note-row"><span class="af-note-idx"></span><span class="af-jobs-more">…另有 ${n.more} 行详情未保存</span></div>` : '');
  }
  // 下发时间：今天只显示时:分，其他天带上月-日
  function fmtClock(ms: number, seconds = false): string {
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, '0');
    const t = `${p(d.getHours())}:${p(d.getMinutes())}${seconds ? ':' + p(d.getSeconds()) : ''}`;
    return d.toDateString() === new Date().toDateString() ? t : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${t}`;
  }

  // 一个任务当前的样子：图标、样式类、一句话状态
  function jobView(j: JobSummary): { ico: IcoKind; cls: string; text: string } {
    const working = j.claimed || jobApplying === j.id; // 已经被取走（正在写回 / 汇报）
    switch (j.status) {
      case 'queued': return { ico: 'clock', cls: 'st-queued', text: '排队中，等待执行' };
      case 'running': return { ico: 'spin', cls: 'st-running', text: `运行中，已 ${fmtDuration(Date.now() - (j.startedAt || j.createdAt))}` };
      case 'done': return working ? { ico: 'spin', cls: 'st-running', text: '正在写回表格…' } : { ico: 'clock', cls: 'st-done', text: '已完成，等待写回' };
      case 'failed': return working ? { ico: 'spin', cls: 'st-running', text: '正在汇报失败原因…' } : { ico: 'alert', cls: 'st-failed', text: `执行失败：${j.error || '函数执行失败'}` };
      case 'applied': {
        const took = j.startedAt && j.finishedAt ? `，用时 ${fmtDuration(j.finishedAt - j.startedAt)}` : '';
        return { ico: 'check', cls: 'st-applied', text: `已写回：${j.result || '完成'}${took}` };
      }
      default: return { ico: 'clock', cls: '', text: j.status };
    }
  }

  // 异步失败行的分组 key：批次 + 函数。复制 / 导出 / 删除都按它来
  function failKey(f: AsyncFail): string { return `${f.runId || ''}|${f.fnId || 'name:' + f.fnName}`; }

  // 历史里的一行（一次调用 / 一个任务）：状态色竖线、图标、标题（第几个任务 · 第几–几条）、一句话状态（太长截断，悬停看全文；独立窗口里不截断）、尾部按钮
  function histLine(cls: string, icon: IcoKind, title: string, state: string, tail: string): string {
    return `<div class="af-job ${cls}"><span class="af-job-ico">${ico(icon)}</span><span class="af-job-title">${title}</span><span class="af-job-state" title="${esc(state)}">${esc(state)}</span>${tail}</div>`;
  }
  // 这次调用有说明时，行尾放一个「说明」按钮，点击弹出悬浮窗专门查看（不在列表里向下展开）
  function noteToggle(n: ExecNote | undefined, _def: boolean): { chip: string; body: string } {
    if (!n) return { chip: '', body: '' };
    return { chip: `<button type="button" class="af-note-chip" data-act="note-view" data-uid="${n.uid}" title="查看这次调用的执行详情">详情</button>`, body: '' };
  }
  const rangeText = (from: number, to: number) => (from ? (from === to ? `第 ${from} 条` : `第 ${from}–${to} 条`) : '');

  // 异步任务
  function jobLineHtml(j: JobSummary, note?: ExecNote, def = false): string {
    const v = jobView(j);
    const cancelable = j.status === 'queued' || j.status === 'running' || ((j.status === 'done' || j.status === 'failed') && !j.claimed && jobApplying !== j.id);
    const title = j.run ? `任务 ${j.run.part}/${j.run.parts}<span class="af-job-range">第 ${j.run.from}–${j.run.to} 条</span>` : `${j.count} 条`;
    const nt = noteToggle(note, def);
    return histLine(v.cls, v.ico, title, v.text, nt.chip + (cancelable ? `<button class="af-x" data-act="job-cancel" data-id="${esc(j.id)}" title="取消这个任务">×</button>` : '')) + nt.body;
  }
  // 同步函数的一次调用
  function callLineHtml(c: CallRec, note?: ExecNote, def = false): string {
    const took = c.ms < 1000 ? `${c.ms} 毫秒` : fmtDuration(c.ms);
    const text = c.error ? `调用失败：${c.error}` : `成功 ${c.ok} 条${c.failed ? `，失败 ${c.failed} 条` : ''}，用时 ${took}`;
    const title = `${c.part ? `调用 ${c.part}/${c.parts}` : '调用'}<span class="af-job-range">${esc(rangeText(c.from, c.to))}</span>`;
    const nt = noteToggle(note, def);
    return histLine(c.error ? 'st-failed' : c.failed ? 'st-queued' : 'st-applied', c.error ? 'alert' : 'check', title, text, nt.chip) + nt.body;
  }
  // 只有说明、找不到对应调用记录的（比如调用记录被清掉了）
  function noteLineHtml(n: ExecNote, def: boolean): string {
    const nt = noteToggle(n, def);
    return histLine('st-applied', 'check', `${n.part ? `${n.async ? '任务' : '调用'} ${n.part}/${n.parts}` : '详情'}<span class="af-job-range">${esc(rangeText(n.from, n.to))}</span>`, fmtClock(n.time, true), nt.chip) + nt.body;
  }

  // 失败明细：key 是（批次 + 函数）的分组 key，复制 / 导出 / 删除只针对这一组
  function failDetailsHtml(fails: AsyncFail[], key: string): string {
    if (fails.length === 0) return '';
    return `<details class="af-fail af-afail" data-fn="${esc(key)}"${afailOpenKeys.has(key) ? ' open' : ''}>
      <summary>${ico('alert')}<span>失败明细 · ${fails.length} 条</span></summary>
      <div class="af-fail-actions">
        <button class="af-add" data-act="afail-copy" data-fn="${esc(key)}">复制全部</button>
        <button class="af-add" data-act="afail-csv" data-fn="${esc(key)}">导出 CSV</button>
        <button class="af-add" data-act="afail-ids" data-fn="${esc(key)}">仅复制记录 ID</button>
        <button class="af-add" data-act="afail-clear" data-fn="${esc(key)}">删除</button>
      </div>
      <div class="af-fail-list">${fails.slice(0, FAIL_SHOW_LIMIT).map(f =>
        `<div class="af-fail-item">第 ${f.index} 条 <span class="af-fail-id">${esc(f.recordId)}</span><div class="af-fail-err">${esc(f.error)}</div></div>`).join('')}</div>
    </details>`;
  }

  // 历史的外观和「批处理历史记录」统一：每个批次是一张 .af-hist-item 卡片（勾选圆、类型标签、时间、× 删除、摘要行、结果行、底部文字按钮）；
  // 批次里的每个函数只占一行（函数名、结果、「复现」「详情」），函数被拆成多批执行时，行尾的「N 批」可以展开成逐批的执行情况
  const isFold = (key: string, def: boolean) => (foldOpen.has(key) ? foldOpen.get(key)! : def);
  // 一组任务的状态标签：运行中 / 待写回 / 失败行数
  function statChips(jobs: JobSummary[], failN: number): string {
    const busy = jobs.filter(j => j.status === 'queued' || j.status === 'running').length;
    const wait = jobs.filter(j => j.status === 'done' || j.status === 'failed').length;
    return (busy ? `<span class="af-chip busy">运行中 ${busy}</span>` : '') + (wait ? `<span class="af-chip wait">待写回 ${wait}</span>` : '') + (failN ? `<span class="af-chip bad">${failN} 条失败</span>` : '');
  }
  const callFailN = (c: CallRec) => c.failed + (c.error ? 1 : 0);
  const visibleJobs = () => jobList.filter(j => j.status !== 'cancelled' && !hiddenJobs.has(j.id));

  type FnGroup = { name: string; jobs: JobSummary[]; fails: AsyncFail[]; calls: CallRec[]; notes: ExecNote[] /* 没有对应调用 / 任务的详情 */ };
  type RunGroup = { at: number; total: number; fns: Map<string, FnGroup> };
  const noteKey = (runId: string, fnId: string, part: number) => `${runId}|${fnId}|${part}`;
  // 分组：批次（runId，没有批次信息的归到“更早的记录”）→ 函数；最新的批次在前，没有批次信息的放最后
  function groupHistory(): { runs: [string, RunGroup][]; noteOf: Map<string, ExecNote> } {
    loadHist();
    const runs = new Map<string, RunGroup>();
    const runOf = (id: string) => { if (!runs.has(id)) runs.set(id, { at: 0, total: 0, fns: new Map() }); return runs.get(id)!; };
    const fnOf2 = (r: RunGroup, id: string, name: string) => { if (!r.fns.has(id)) r.fns.set(id, { name, jobs: [], fails: [], calls: [], notes: [] }); return r.fns.get(id)!; };
    const bump = (r: RunGroup, at: number) => { if (at && !r.at) r.at = at; };
    visibleJobs().forEach(j => { const r = runOf(j.run?.id || ''); if (j.run) { r.at = j.run.at; r.total = j.run.total; } fnOf2(r, j.fnId, j.fnName).jobs.push(j); });
    asyncFails.forEach(f => { const r = runOf(f.runId || ''); if (f.runId) bump(r, f.time); fnOf2(r, f.fnId || 'name:' + f.fnName, f.fnName).fails.push(f); });
    callLog.forEach(c => { const r = runOf(c.runId); bump(r, c.runAt || c.time); fnOf2(r, c.fnId, c.fnName).calls.push(c); });
    // 说明挂到同一批次、同一函数、同一序号的调用 / 任务下面；对不上的单列
    const noteOf = new Map<string, ExecNote>();
    const matched = new Set<string>();
    for (const g of runs.entries()) for (const [fid, fg] of g[1].fns) {
      fg.jobs.forEach(j => matched.add(noteKey(g[0], fid, j.run?.part ?? 0)));
      fg.calls.forEach(c => matched.add(noteKey(g[0], fid, c.part)));
    }
    noteLog.forEach(n => {
      const k = noteKey(n.runId, n.fnId, n.part);
      if (n.part && matched.has(k)) { noteOf.set(k, n); return; }
      const r = runOf(n.runId);
      bump(r, n.runAt || n.time);
      fnOf2(r, n.fnId, n.fnName).notes.push(n);
    });
    return { runs: [...runs.entries()].sort((a, b) => (a[0] === '' ? 1 : 0) - (b[0] === '' ? 1 : 0) || b[1].at - a[1].at), noteOf };
  }

  // 复制用的文本：不传参数是全部，传了批次（和函数）就只复制那些
  function noteLines(n?: ExecNote): string[] {
    return n ? [...(n.batch ? [`    详情：${n.batch}`] : []), ...n.rows.map(r => `    ${r.index ? `第 ${r.index} 条：` : ''}${r.text}`)] : [];
  }
  function histText(runKeys?: string[], fnId?: string): string {
    const { runs, noteOf } = groupHistory();
    const out: string[] = [];
    for (const [rk, r] of runs) {
      if (runKeys !== undefined && !runKeys.includes(rk)) continue;
      out.push(rk === '' ? '【更早的记录】' : `【批次 ${fmtClock(r.at, true)}${runNames[rk] ? ` ${runNames[rk]}` : ''}${r.total ? `，${r.total} 条` : ''}】`);
      for (const [fid, g] of r.fns) {
        if (fnId !== undefined && fid !== fnId) continue;
        out.push(`  ${g.name}`);
        g.jobs.slice().sort((a, b) => (a.run?.part ?? 0) - (b.run?.part ?? 0)).forEach(j => {
          out.push(`  - 任务 ${j.run ? `${j.run.part}/${j.run.parts} ${rangeText(j.run.from, j.run.to)}` : `${j.count} 条`}：${jobView(j).text}`, ...noteLines(noteOf.get(noteKey(rk, fid, j.run?.part ?? 0))));
        });
        g.calls.slice().sort((a, b) => a.part - b.part).forEach(c => {
          out.push(`  - 调用 ${c.part}/${c.parts} ${rangeText(c.from, c.to)}：${c.error ? `调用失败：${c.error}` : `成功 ${c.ok} 条${c.failed ? `，失败 ${c.failed} 条` : ''}`}`, ...noteLines(noteOf.get(noteKey(rk, fid, c.part))));
        });
        g.notes.forEach(n => out.push(`  - ${n.part ? `${n.async ? '任务' : '调用'} ${n.part}/${n.parts} ` : ''}${rangeText(n.from, n.to)}`, ...noteLines(n)));
      }
    }
    return out.join('\n');
  }
  // 删除：不传参数是全部，传了批次（和函数）就只清那些。本地的调用记录、说明、异步失败明细直接删；
  // 已写回的异步任务在服务端，只是不再显示；还没跑完 / 没写回的任务保留（要停用「取消」）
  function clearHist(runKeys?: string[], fnId?: string) {
    const what = runKeys === undefined ? '全部历史' : fnId !== undefined ? '这个函数在该批次里的记录' : runKeys.length > 1 ? `所选的 ${runKeys.length} 个批次` : '这个批次的记录';
    if (!confirm(`删除${what}？\n未完成的异步任务会保留；清掉后无法恢复。`)) return;
    loadHist();
    const inScope = (rid: string, fid: string) => (runKeys === undefined || runKeys.includes(rid)) && (fnId === undefined || fid === fnId);
    const keepCalls = callLog.filter(c => !inScope(c.runId, c.fnId));
    callLog.length = 0; callLog.push(...keepCalls);
    const keepNotes = noteLog.filter(n => !inScope(n.runId, n.fnId));
    noteLog.length = 0; noteLog.push(...keepNotes);
    jobList.forEach(j => { if (j.status === 'applied' && inScope(j.run?.id || '', j.fnId)) hiddenJobs.add(j.id); });
    asyncFails = asyncFails.filter(f => !inScope(f.runId || '', f.fnId || 'name:' + f.fnName));
    try { localStorage.setItem(asyncFailKey(), JSON.stringify(asyncFails)); } catch { /* ignore */ }
    if (runKeys) runKeys.forEach(k => { histSel.delete(k); delete runNames[k]; }); else { histSel.clear(); runNames = {}; }
    saveHist();
    updateJobsView();
  }

  // 一个批次里某个函数：一行（函数名、结果、状态标签、复现 / 详情 / 展开按钮）；拆成多批或有失败明细时可展开逐批的执行情况（失败的批排前面）
  function fnTasksHtml(runKey: string, fnId: string, g: FnGroup, latest: boolean, noteOf: Map<string, ExecNote>): string {
    const jobs = g.jobs.slice().sort((a, b) => (a.run?.part ?? 0) - (b.run?.part ?? 0) || a.createdAt - b.createdAt);
    const calls = g.calls.slice().sort((a, b) => a.part - b.part || a.time - b.time);
    const done = jobs.filter(j => j.status === 'applied').length;
    const total = jobs[0]?.run?.parts || jobs.length;
    const callFail = calls.reduce((n, c) => n + callFailN(c), 0);
    const callOk = calls.reduce((n, c) => n + c.ok, 0);
    const took = calls.reduce((n, c) => n + c.ms, 0);
    const state = jobs.length ? `${done}/${total} 已写回` : calls.length ? `成功 ${callOk} 条${callFail ? `，失败 ${callFail} 条` : ''}，用时 ${took < 1000 ? `${took} 毫秒` : fmtDuration(took)}` : '';
    const lineCount = jobs.length + calls.length + g.notes.length;
    const expandable = lineCount > 1 || g.fails.length > 0;
    const key = `f|${runKey}|${fnId}`;
    const open = expandable && isFold(key, g.fails.length > 0 || callFail > 0 || jobs.some(j => j.status === 'failed'));
    if (expandable) foldKeys.push({ key, def: false });
    // 只有一批时，详情直接放在函数行上；多批时详情在各批行里
    const only = lineCount === 1 ? (jobs[0] ? noteOf.get(noteKey(runKey, fnId, jobs[0].run?.part ?? 0)) : calls[0] ? noteOf.get(noteKey(runKey, fnId, calls[0].part)) : g.notes[0]) : undefined;
    const attrs = `data-run="${esc(runKey)}" data-fn="${esc(fnId)}"`;
    const restore = runKey !== '' && runConfigOf(runKey) !== null ? `<button type="button" class="af-fnbtn" data-act="jobs-restore" data-mode="fns" ${attrs} title="只恢复这个函数运行时的输入映射和输出字段；面板上其他函数和筛选条件不动，这个函数当前的配置会被替换">复现</button>` : '';
    const detail = only ? `<button type="button" class="af-fnbtn" data-act="note-view" data-uid="${only.uid}" title="查看这次执行的详情">详情</button>` : '';
    const copyBtn = `<button type="button" class="af-fnbtn" data-act="jobs-copy" ${attrs} title="复制这个函数分批执行记录的详情">复制</button>`;
    const toggle = expandable ? `<button type="button" class="af-fnbtn${open ? ' on' : ''}" data-act="jobs-fold" data-key="${esc(key)}" data-open="${open ? 1 : 0}" title="${open ? '收起' : '展开'}逐批的执行情况">${lineCount > 1 ? `${lineCount} 批` : '明细'} ${open ? '▴' : '▾'}</button>` : '';
    const unfinished = jobs.some(j => j.status !== 'applied');
    const lines = [...jobs.map(j => ({ bad: j.status === 'failed', html: jobLineHtml(j, noteOf.get(noteKey(runKey, fnId, j.run?.part ?? 0)), latest) })),
      ...calls.map(cc => ({ bad: callFailN(cc) > 0, html: callLineHtml(cc, noteOf.get(noteKey(runKey, fnId, cc.part)), latest) })),
      ...g.notes.slice().sort((a, b) => a.part - b.part).map(n => ({ bad: false, html: noteLineHtml(n, latest) }))]
      .sort((a, b) => Number(b.bad) - Number(a.bad)).map(x => x.html).join('');
    return `<div class="af-fnrow"><span class="af-fnrow-name" title="${esc(g.name)}">${esc(g.name)}</span><span class="af-fnrow-state" title="${esc(state)}">${esc(state)}</span>` +
      `${statChips(jobs.filter(j => j.status !== 'applied'), g.fails.length + (jobs.length ? 0 : 0))}${restore}${copyBtn}${detail}${toggle}</div>` +
      (jobs.length && unfinished ? `<div class="af-bar"><i style="width:${Math.round(done / Math.max(total, 1) * 100)}%"></i></div>` : '') +
      (open ? `<div class="af-fn-detail">${lines}${failDetailsHtml(g.fails, `${runKey}|${fnId}`)}</div>` : '');
  }

  const dayLabelOf = (t: number) => {
    const d = new Date(t), today = new Date();
    const diff = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return diff === 0 ? '今天' : diff === 1 ? '昨天' : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  // 历史的内容：状态标签、汇总、是否全部展开，以及按天分组、每个批次一张可勾选卡片的列表；有搜索词时只留匹配的函数，并全部展开
  function historyPanelHtml(showAllRuns: boolean): { chips: string; info: string; runKeys: string[]; body: string } {
    const live = visibleJobs();
    loadHist();
    const failN = asyncFails.length + callLog.reduce((n, c) => n + callFailN(c), 0);
    const chips = statChips(live, failN) + (live.some(j => j.status === 'applied') ? `<span class="af-chip ok">已写回 ${live.filter(j => j.status === 'applied').length}</span>` : '');
    foldKeys = [];
    const grouped = groupHistory();
    const noteOf = grouped.noteOf;
    const q = histQuery.trim().toLowerCase();
    let ordered = grouped.runs;
    if (q) {
      const fnText = (rk: string, fid: string, g: FnGroup) => [g.name, ...g.jobs.map(j => jobView(j).text), ...g.calls.map(c => c.error || ''), ...g.fails.map(f => f.error),
        ...noteLog.filter(n => n.runId === rk && n.fnId === fid).flatMap(n => [n.batch || '', ...n.rows.map(r => r.text)])].join('\n').toLowerCase();
      ordered = ordered.flatMap(([rk, r]): [string, RunGroup][] => {
        const runHit = `批次 ${fmtClock(r.at, true)} ${dayLabelOf(r.at)} ${runNames[rk] || ''}`.toLowerCase().includes(q);
        const fns = new Map([...r.fns].filter(([fid, g]) => runHit || fnText(rk, fid, g).includes(q)));
        return fns.size ? [[rk, { ...r, fns }]] : [];
      });
    }
    const visible = showAllRuns || q ? ordered : ordered.slice(0, RUNS_SHOWN);
    let lastDay = '';
    const body = visible.map(([runKey, r], idx) => {
      const groups = [...r.fns.values()];
      const all = groups.flatMap(g => g.jobs);
      const runFail = groups.reduce((n, g) => n + g.fails.length + g.calls.reduce((m, c) => m + callFailN(c), 0), 0);
      const doneN = all.filter(j => j.status === 'applied').length;
      const parts = groups.reduce((n, g) => n + (g.jobs[0]?.run?.parts || g.jobs.length), 0);
      const callN = groups.reduce((n, g) => n + g.calls.length, 0);
      const unfinished = all.some(j => j.status !== 'applied');
      const day = runKey === '' ? '更早的记录' : dayLabelOf(r.at);
      const dayHead = day !== lastDay ? `<div class="af-hist-day">${esc(day)}</div>` : '';
      lastDay = day;
      const check = `<button type="button" class="af-hist-check${histSel.has(runKey) ? ' on' : ''}" data-act="hist-sel" data-run="${esc(runKey)}" title="选择这个批次，可批量复制 / 删除"></button>`;
      const runAct = Math.max(0, ...all.map(jobTime), ...groups.flatMap(g => [...g.calls.map(cc => cc.time), ...g.fails.map(f => f.time)]), ...noteLog.filter(n => n.runId === runKey).map(n => n.time));
      const runDot = runAct > (readSeen()[runKey] || 0) ? `<i class="af-dot af-run-dot ${dotState(runFail > 0, unfinished)}" title="有新的结果，点击这个批次后消失"></i>` : '';
      const okN = groups.reduce((n, g) => n + g.calls.reduce((m, cc) => m + cc.ok, 0), 0);
      const names = groups.map(g => g.name).join('、');
      const stat = [callN ? `成功 ${okN} 条${runFail ? `，失败 ${runFail} 条` : ''}` : runFail ? `失败 ${runFail} 条` : '', all.length ? `${doneN}/${parts} 个异步任务已写回` : ''].filter(Boolean).join(' · ') || '无执行结果';
      const attrs = `data-run="${esc(runKey)}"`;
      const canRestore = runKey !== '' && runConfigOf(runKey) !== null; // 从面板运行过、记着当时的配置，才能复现
      const restoreBtns = canRestore ? `<button class="af-add" data-act="jobs-restore" data-mode="fns" ${attrs} title="把「函数」块整体换成这个批次运行时的配置（各函数、输入映射、输出字段）。筛选条件不动；面板上现有的函数配置会被替换，只想恢复其中一个函数请用函数行上的「复现」">恢复函数配置</button>` : '';
      return dayHead + `<div class="af-hist-item af-runcard${unfinished ? ' live' : ''}${histSel.has(runKey) ? ' sel' : ''}" data-run="${esc(runKey)}">${runDot}${check}` +
        `<button type="button" class="af-hist-x" data-act="jobs-clear" ${attrs} title="删除这个批次的记录（已写回的任务只是不再显示）">×</button>` +
        `<div class="af-hist-title"><span class="af-hist-kind run">批次</span>${runKey === '' ? '' : `<span class="af-hist-name${runNames[runKey] ? '' : ' empty'}" data-act="run-rename" data-run="${esc(runKey)}" title="点击给这个批次命名 / 改名，方便以后查找；命名过的批次超出保留上限时优先保留">${runNames[runKey] ? esc(runNames[runKey]) : '＋ 命名'}</span>`}<span class="af-hist-time">${runKey === '' ? '无批次信息' : esc(fmtClock(r.at, true).replace(/^\d\d-\d\d /, ''))}</span></div>` +
        `<div class="af-hist-line" title="${esc(names)}">${r.total ? `${r.total} 条记录 · ` : ''}函数：${esc(names)}</div>` +
        `<div class="af-hist-line stat${runFail > 0 ? ' bad' : ''}" title="${esc(stat)}">${esc(stat)}${statChips(all, 0)}</div>` +
        `<div class="af-fnrows">${[...r.fns.entries()].map(([fid, g]) => fnTasksHtml(runKey, fid, g, idx === 0 || !!q, noteOf)).join('')}</div>` +
        `<div class="af-hist-btns"><span class="af-hist-btns-left">${restoreBtns}<button class="af-add" data-act="jobs-copy" ${attrs} title="复制这个批次的记录和执行详情">复制</button></span></div></div>`;
    }).join('') + (!q && ordered.length > RUNS_SHOWN ? `<button type="button" class="af-add af-runs-toggle" data-act="jobs-runs">${showAllRuns ? '收起较早的批次' : `显示更早的 ${ordered.length - RUNS_SHOWN} 个批次`}</button>` : '');
    const execN = live.length + callLog.length;
    const info = ordered.length ? `${q ? '匹配 ' : ''}${ordered.length} 个批次 · ${execN} 次执行${failN ? ` · ${failN} 条失败` : ''}` : '';
    return {
      chips, info, runKeys: visible.map(([k]) => k),
      body: body || `<div class="af-note-empty">${q ? '没有匹配的记录' : '还没有运行记录。运行函数后，每次调用、异步任务和函数返回的执行详情都会记在这里'}</div>`,
    };
  }
  // 历史里的点击（历史窗口、面板本身共用）；处理了返回 true
  function handleJobAct(act: string, btn: HTMLElement): boolean {
    const runScope = (): string[] | undefined => (btn.dataset.run !== undefined ? [btn.dataset.run] : undefined); // 没有 data-run = 全部
    const copied = (text: string) => copyText(text).then(() => { const old = btn.innerHTML; const isIcon = !!btn.querySelector('svg'); btn.innerHTML = isIcon ? ico('check') : '已复制'; setTimeout(() => { btn.innerHTML = old; }, 1500); }, () => { /* 复制失败不打扰 */ });
    switch (act) {
      case 'jobs-refresh': refreshJobs(); return true;
      case 'jobs-toggle': if (jobWin) closeJobWin(); else openJobWin(); return true;
      case 'jobs-runs': jobShowAllRuns = !jobShowAllRuns; updateJobsView(); return true;
      case 'jobs-fold': foldOpen.set(btn.dataset.key || '', btn.dataset.open !== '1'); updateJobsView(); return true;
      case 'jobs-win-close': closeJobWin(); return true;
      case 'jobs-copy': copied(histText(runScope(), btn.dataset.fn)); return true;
      case 'jobs-clear': clearHist(runScope(), btn.dataset.fn); return true;
      case 'jobs-restore': {
        const cfg = runConfigOf(btn.dataset.run || '');
        const mode = btn.dataset.mode === 'all' ? 'all' : btn.dataset.mode === 'filter' ? 'filter' : 'fns';
        if (cfg && restoreHistory({ id: '', time: Number(readSeenAt(btn.dataset.run || '')) || Date.now(), kind: 'run', config: cfg, matched: 0, total: 0 }, mode, btn.dataset.fn)) closeJobWin();
        return true;
      }
      case 'hist-sel': { const k = btn.dataset.run || ''; if (histSel.has(k)) histSel.delete(k); else histSel.add(k); updateJobsView(); return true; }
      case 'hist-sel-all': {
        const keys = historyPanelHtml(jobShowAllRuns).runKeys;
        if (keys.length && keys.every(k => histSel.has(k))) keys.forEach(k => histSel.delete(k)); else keys.forEach(k => histSel.add(k));
        updateJobsView(); return true;
      }
      case 'jobs-copy-sel': copied(histText([...histSel])); return true;
      case 'jobs-clear-sel': clearHist([...histSel]); return true;
      case 'note-view': { const n = noteLog.find(x => String(x.uid) === btn.dataset.uid); if (n) showNotePop(n, false); return true; }
      case 'job-cancel': cancelJob(btn.dataset.id!); return true;
      default: return false;
    }
  }

  // 批次改名：原地换成输入框，回车 / 失焦保存，Esc 放弃，留空就是取消命名（和批处理历史的命名一样）
  function renameRun(el: HTMLElement) {
    const runKey = el.dataset.run || '';
    loadHist();
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'af-hist-name-input';
    input.value = runNames[runKey] || '';
    input.maxLength = HISTORY_NAME_MAX;
    input.placeholder = '给这个批次起个名字';
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      renamingRun = false;
      const body = jobWin?.querySelector('[data-jobwin-body]');
      if (body) lastHtml.delete(body as HTMLElement); // 输入框是直接换进 DOM 的，内容没变时 setHtml 会跳过重画，输入框就留在那里；清掉缓存强制重画
      if (save) {
        const v = input.value.trim();
        if (v) runNames[runKey] = v; else delete runNames[runKey];
        trimHist();
        saveHist();
      }
      updateJobsView();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // Esc 只放弃命名，不关历史窗口
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    renamingRun = true;
    el.replaceWith(input);
    input.focus();
    input.select();
  }

  // 历史窗口（挂在 body 上，样式沿用批处理的「历史记录」窗口）：搜索 + 选择栏 + 按天分组的批次卡片
  function openJobWin() {
    if (!jobWin) {
      try { localStorage.setItem(NOTE_SEEN_KEY(), String(Date.now())); } catch { /* ignore */ }
      histQuery = '';
      const overlay = document.createElement('div');
      overlay.className = 'af-modal';
      overlay.innerHTML = `<div class="af-modal-box af-hist-box af-histwin-box" role="dialog" aria-modal="true">
        <div class="af-modal-head"><span>历史（函数运行记录）</span><span class="af-pop-chips" data-jobwin-chips></span><button type="button" class="af-x" data-act="jobs-win-close" title="关闭">×</button></div>
        <div class="af-hist-search"><input type="text" data-hist-search placeholder="搜索批次名称、函数名、批次时间、执行详情、失败原因…" /></div>
        <div class="af-hist-bar"><button type="button" class="af-hist-check" data-act="hist-sel-all" data-hist-selall title="全选 / 取消全选（当前列表里的批次）"></button><span class="af-hist-selinfo" data-jobwin-info></span>
          <button type="button" class="af-add" data-act="jobs-copy-sel" data-hist-selbtn disabled title="复制勾选的批次">复制</button><button type="button" class="af-add" data-act="jobs-clear-sel" data-hist-selbtn disabled title="删除勾选的批次">删除</button>
          <button type="button" class="af-add" data-act="jobs-refresh" title="立即刷新任务状态，并写回已完成的任务">刷新</button></div>
        <div class="af-modal-body af-hist-list" data-jobwin-body></div></div>`;
      overlay.addEventListener('click', (e) => {
        const t = e.target as HTMLElement;
        if (t === overlay) { closeJobWin(); return; }
        const card = t.closest('.af-runcard') as HTMLElement | null;
        const dot = card?.querySelector('.af-run-dot');
        if (card && dot) { markRunSeen(card.dataset.run || ''); dot.remove(); } // 点这个批次卡片的任何位置，它的提示点消失
        const nameEl = t.closest('[data-act="run-rename"]') as HTMLElement | null;
        if (nameEl) { renameRun(nameEl); return; }
        const btn = t.closest('button[data-act]') as HTMLElement | null;
        if (!btn) return;
        const act = btn.dataset.act!;
        if (act.startsWith('afail-')) onAsyncFailAction(act, btn); else handleJobAct(act, btn);
      });
      overlay.addEventListener('input', (e) => {
        const t = e.target as HTMLInputElement;
        if (t.matches('[data-hist-search]')) { histQuery = t.value; updateJobsView(); }
      });
      overlay.addEventListener('toggle', (e) => { // 失败明细展开 / 折叠要记住，重绘后保持原样
        const el = e.target as HTMLDetailsElement;
        if (el.classList?.contains('af-afail')) { const k = el.dataset.fn || ''; if (el.open) afailOpenKeys.add(k); else afailOpenKeys.delete(k); }
      }, true);
      document.body.appendChild(overlay); // 挂在 body 上，不受面板缩放影响
      jobWin = overlay;
      (overlay.querySelector('[data-hist-search]') as HTMLInputElement).focus();
    }
    updateJobsView();
  }
  function closeJobWin() { if (jobWin) { jobWin.remove(); jobWin = null; histSel.clear(); updateJobsView(); } }

  // 执行详情悬浮窗：点历史里某次调用的「说明」打开（只看这一条）；函数返回了说明且开着“自动弹出”时也会弹出（同一次运行的后续说明追加在里面）。不遮罩，不挡操作
  function noteItemHtml(n: ExecNote): string {
    const title = `${n.part ? `${n.async ? '任务' : '调用'} ${n.part}/${n.parts}` : '详情'}${n.from ? ` · ${rangeText(n.from, n.to)}` : ''}`;
    return `<div class="af-notepop-item"><div class="af-note-head"><b>${esc(n.fnName)}</b><span>${esc(title)}</span><span>${esc(fmtClock(n.time, true))}</span></div>${noteInnerHtml(n)}</div>`;
  }
  function showNotePop(n: ExecNote, append: boolean) {
    if (!append || !notePop) notePopList = [n]; else notePopList.push(n);
    if (notePopList.length > 50) notePopList.splice(0, notePopList.length - 50);
    if (!notePop) {
      const win = document.createElement('div');
      win.className = 'af-modal af-notepop';
      win.innerHTML = `<div class="af-modal-box"><div class="af-modal-head"><span>执行详情</span>
        <span class="af-modal-actions"><button type="button" class="af-add" data-npop="copy">复制</button><button type="button" class="af-x" data-npop="close" title="关闭">×</button></span></div>
        <div class="af-modal-body af-notepop-body"></div></div>`;
      win.addEventListener('click', (e) => {
        if (e.target === win) { closeNotePop(); return; } // 点遮罩关闭
        const act = (e.target as HTMLElement).closest('[data-npop]')?.getAttribute('data-npop');
        if (act === 'close') closeNotePop();
        else if (act === 'copy') {
          const btn = (e.target as HTMLElement).closest('[data-npop]') as HTMLElement;
          copyText(notePopList.map(x => [`【${x.fnName}${x.part ? ` 任务${x.part}/${x.parts}` : ''} ${fmtClock(x.time, true)}】`, ...noteLines(x).map(l => l.trim())].join('\n')).join('\n\n')).then(() => { btn.textContent = '已复制'; setTimeout(() => { btn.textContent = '复制'; }, 1500); }, () => { /* ignore */ });
        }
      });
      document.body.appendChild(win);
      notePop = win;
    }
    const body = notePop.querySelector('.af-notepop-body') as HTMLElement;
    body.innerHTML = notePopList.map(noteItemHtml).join('');
    if (append) body.scrollTop = body.scrollHeight;
  }
  function closeNotePop() { if (notePop) { notePop.remove(); notePop = null; notePopList = []; } }

  // 「函数」块右上角常驻的「历史」按钮：右上角一个状态点（执行中橙、有失败红、全部完成绿，没有记录时不显示）；点击打开历史窗口。
  // 状态不占面板版面，所以下发之后可以继续配置、运行别的函数
  function jobBadgeHtml(): string {
    loadHist();
    const live = visibleJobs();
    const seenAt = Number(localStorage.getItem(NOTE_SEEN_KEY()) || 0);
    const activity = Math.max(0, ...live.map(jobTime), ...callLog.map(c => c.time), ...noteLog.map(n => n.time), ...asyncFails.map(f => f.time));
    const unseen = activity > seenAt; // 有新的活动（新调用 / 任务状态变化 / 新详情）：亮点，点开历史就消失
    const busy = live.filter(j => j.status === 'queued' || j.status === 'running').length;
    const waiting = live.filter(j => j.status === 'done' || j.status === 'failed').length;
    const applied = live.filter(j => j.status === 'applied').length;
    const failN = asyncFails.length + callLog.reduce((n, c) => n + callFailN(c), 0);
    // 红色只表示失败：只要有失败的行就立刻变红（还有任务没结束时，红点呼吸，表示“有失败，且还没跑完”）；没有失败：执行中橙色呼吸，全部完成绿色
    const live2 = busy > 0 || waiting > 0;
    const hasAny = live.length > 0 || callLog.length > 0 || noteLog.length > 0 || failN > 0;
    const state = dotState(failN > 0, live2);
    const tip = ['运行历史', busy ? `运行中 ${busy}` : '', waiting ? `待写回 ${waiting}` : '', applied ? `已写回 ${applied}` : '', callLog.length ? `同步调用 ${callLog.length} 次` : '', failN ? `${failN} 条失败` : ''].filter(Boolean).join(' · ');
    return `<button type="button" class="af-job-badge${jobWin ? ' on' : ''}" data-act="jobs-toggle" title="${esc(tip + (hasAny && unseen ? ' · 有新的结果' : ''))}">${ico('list')}<span>历史</span>${hasAny && unseen ? `<i class="af-dot ${state}"></i>` : ''}</button>`;
  }

  function jobNoteHtml(): string { return jobNote ? `<div class="af-hint af-err">${esc(jobNote)}</div>` : ''; }

  // 只更新标签和弹层，不整块重绘面板（免得轮询时打断正在输入的筛选条件）；内容没变就不动，转圈图标才不会每次轮询都从头转
  // （不能拿 innerHTML 读回来比：浏览器会把它规范化成另一种写法，所以自己记下上一次写进去的字符串）
  const lastHtml = new WeakMap<HTMLElement, string>();
  function setHtml(el: HTMLElement, html: string) {
    if (lastHtml.get(el) === html) return;
    el.innerHTML = html;
    lastHtml.set(el, html);
  }
  function updateJobsView() {
    const badge = container.querySelector('[data-jobs-badge]') as HTMLElement | null;
    if (badge) setHtml(badge, jobBadgeHtml());
    if (jobWin && !renamingRun) { // 历史窗口：只换列表内容，滚动位置保持不变
      const panel = historyPanelHtml(jobShowAllRuns);
      [...histSel].forEach(k => { if (!panel.runKeys.includes(k)) histSel.delete(k); }); // 被搜索过滤掉 / 已删除的批次不再算选中
      const n = histSel.size;
      setHtml(jobWin.querySelector('[data-jobwin-chips]') as HTMLElement, panel.chips);
      setHtml(jobWin.querySelector('[data-jobwin-info]') as HTMLElement, esc(n ? `已选 ${n} 个批次` : panel.info));
      setHtml(jobWin.querySelector('[data-jobwin-body]') as HTMLElement, panel.body);
      (jobWin.querySelector('[data-hist-selall]') as HTMLElement).className = 'af-hist-check' + (n === 0 ? '' : n >= panel.runKeys.length ? ' on' : ' part');
      jobWin.querySelectorAll('[data-hist-selbtn]').forEach(b => { (b as HTMLButtonElement).disabled = n === 0; });
    }
    const note = container.querySelector('.af-jobs-note') as HTMLElement | null;
    if (note) setHtml(note, jobNoteHtml());
  }

  function asyncFailTable(rows: AsyncFail[]): string[][] {
    return [['序号', '记录ID', '函数', '失败原因'], ...rows.map(f => [String(f.index), f.recordId, f.fnName, f.error])];
  }
  // 失败明细的操作只针对按钮所在的那个函数
  async function onAsyncFailAction(act: string, btn: HTMLElement) {
    const key = btn.dataset.fn || '';
    const rows = asyncFails.filter(f => failKey(f) === key);
    try {
      if (act === 'afail-clear') {
        if (!confirm('删除这个函数的异步失败明细？')) return;
        asyncFails = asyncFails.filter(f => failKey(f) !== key);
        try { localStorage.setItem(asyncFailKey(), JSON.stringify(asyncFails)); } catch { /* ignore */ }
        updateJobsView();
        return;
      }
      if (act === 'afail-csv') { downloadCsv(toCsv(asyncFailTable(rows)), '异步任务失败行'); return; }
      await copyText(act === 'afail-ids' ? rows.map(f => f.recordId).join('\n') : toTsv(asyncFailTable(rows)));
      const old = btn.textContent;
      btn.textContent = '已复制';
      setTimeout(() => { btn.textContent = old; }, 1500);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
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
      const all = await host.loadAllRecords((done, total) => setReadProgress(` ${done}/${total}`), { fresh: true });
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
      const all = await host.loadAllRecords((done, total) => setReadProgress(` ${done}/${total}`), { fresh: true });
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
  const FILTER_FILE_TYPE = 'data-engine-filter';
  const LEGACY_FILTER_FILE_TYPE = 'bitable-editor-filter'; // 插件改名（bitable-editor → data-engine）前导出的文件，仍可导入
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
        if (!data || (data.type !== FILTER_FILE_TYPE && data.type !== LEGACY_FILTER_FILE_TYPE)) throw new Error('这不是本插件导出的筛选条件文件');
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

  // 预览 / 统计可能用了缓存里的记录：数据不是刚读的就在窗口底部说明，并告诉用户怎么拿最新的
  function dataAgeHint(): string {
    const sec = Math.round((Date.now() - host.loadedAt()) / 1000);
    if (sec < 3) return '';
    const ago = sec < 60 ? `${sec} 秒` : `${Math.floor(sec / 60)} 分钟`;
    return `（数据读取于 ${ago}前，要最新数据请先点「筛选」）`;
  }

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
  // 和 filteredRows 的列一一对应（第一列是记录 ID）：哪些列是多选字段，统计时要按选项拆开
  const multiFlags = () => [false, ...host.getFields().map(f => f.type === FType.MULTI_SELECT)];

  function openPreviewTab(rows: string[][], total: number, tab: 'data' | 'stats' = 'data') {
    const url = URL.createObjectURL(new Blob([buildPreviewHtml(rows, total, tab, multiFlags())], { type: 'text/html;charset=utf-8' }));
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
      <div class="af-modal-foot"><span>${body.length > shown.length ? `仅显示前 ${shown.length} 条，导出 CSV 包含全部 ${body.length} 条` : `共 ${body.length} 条`}${dataAgeHint()}</span><span class="af-modal-actions"><button class="af-add" data-newtab title="在新标签页里打开，能用上整个浏览器窗口，并支持排序、调整列宽">在新标签页打开</button><button class="af-add" data-export>导出 CSV</button></span></div>
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

  // 按函数描述配置：每个函数一行——函数名、入参 ← 字段（或 = 填写的值）、输出 → 字段
  function describeFns(c: Config): string[] {
    const names = new Map(host.getAllFields().map(f => [f.id, f.name]));
    const fieldName = (id: string) => (id ? names.get(id) ?? '（字段已不存在）' : '未选字段');
    const fnIdOf = (key: string) => findCall(key)?.id ?? findOutput(key)?.fn.id ?? '';
    const order: string[] = [];
    for (const o of c.outputs) { const id = fnIdOf(o.param); if (id && !order.includes(id)) order.push(id); }
    const lines = order.map((id) => {
      const fn = fns.find(f => f.id === id);
      const ins = c.inputs.filter(i => i.fn === id && (i.fieldId || i.value !== undefined)).map(i => (i.value !== undefined
        ? `${i.param} = ${Array.isArray(i.value) ? i.value.join('、') || '（未选）' : i.value || '（未填）'}`
        : `${i.param} ← ${fieldName(i.fieldId)}`));
      const outs = c.outputs.filter(o => fnIdOf(o.param) === id && !o.param.startsWith(FN_PREFIX))
        .map(o => `${findOutput(o.param)?.out.label || o.param}${o.fieldId ? ` → ${fieldName(o.fieldId)}` : '（不写入）'}`);
      return `${fn?.name || id}${ins.length ? `｜入参：${ins.join('，')}` : ''}${outs.length ? `｜写入：${outs.join('，')}` : outs.length === 0 ? '｜只调用' : ''}`;
    });
    // 旧版历史里没带函数归属的输入，单独列出来
    const legacy = c.inputs.filter(i => !i.fn && (i.fieldId || i.value !== undefined)).map(i => `${i.param || '未选参数'} ← ${fieldName(i.fieldId)}`);
    if (legacy.length) lines.push(`输入：${legacy.join('，')}`);
    return lines;
  }

  function restoreHistory(entry: HistoryEntry, only: 'all' | 'filter' | 'fns', fnId?: string): boolean {
    if (running || exporting) { alert('正在读取记录或运行中，完成后再恢复历史配置'); return false; }
    const hasContent = config.filter.children.length > 0 || config.inputs.length > 0 || config.outputs.length > 0;
    const cur = JSON.stringify(config);
    // 当前配置没跑过（历史里找不到一模一样的）：恢复会把它覆盖掉，先确认
    if (hasContent && !readHistory().some(h => JSON.stringify(h.config) === cur) &&
        !confirm('当前配置还没有运行过，恢复历史配置会覆盖它，确定吗？')) return false;
    const saved = JSON.parse(JSON.stringify(entry.config)) as Config;
    if (only === 'filter') config = { ...config, filter: saved.filter };
    else if (only === 'fns') {
      migrateLegacyInputs(saved);
      if (fnId === undefined) config = { ...config, inputs: saved.inputs, outputs: saved.outputs }; // 整套函数配置（筛选条件不动）
      else { // 只换这个函数：先去掉当前配置里它的输出 / 输入，再放进当时的
        const mine = (o: Mapping) => (fnOfKey(o.param)?.id ?? findCall(o.param)?.id) === fnId;
        config = { ...config, outputs: [...config.outputs.filter(o => !mine(o)), ...saved.outputs.filter(mine)], inputs: [...config.inputs.filter(i => i.fn !== fnId), ...saved.inputs.filter(i => i.fn === fnId)] };
      }
    } else config = { ...newConfig(), ...saved };
    migrateSeps(config.filter);
    migrateLegacyInputs(config); // 旧版历史里的输入是全局的
    saveConfig();
    const when = new Date(entry.time);
    const pad2 = (n: number) => String(n).padStart(2, '0');
    setStatus(`已恢复 ${when.getMonth() + 1}-${when.getDate()} ${pad2(when.getHours())}:${pad2(when.getMinutes())} 的${only === 'filter' ? '筛选条件' : only === 'fns' ? (fnId !== undefined ? '函数配置（该函数）' : '函数配置') : '整套配置'}`, 'ok');
    render();
    return true;
  }

  // ── 历史记录导出 / 导入（JSON 文件）：和筛选条件一样，字段除了 ID 还带上字段名，换一张表时按字段名重新对应 ──
  const HISTORY_FILE_TYPE = 'data-engine-history';
  const LEGACY_HISTORY_FILE_TYPE = 'bitable-editor-history'; // 改名前导出的文件，仍可导入

  function entryForExport(e: HistoryEntry): any {
    const byId = new Map(host.getAllFields().map(f => [f.id, f.name]));
    const io = (m: Mapping) => ({ param: m.param, fieldId: m.fieldId, fieldName: byId.get(m.fieldId) ?? '', ...(m.fn ? { fn: m.fn } : {}), ...(m.value !== undefined ? { value: m.value } : {}) });
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
    if (!data || (data.type !== HISTORY_FILE_TYPE && data.type !== LEGACY_HISTORY_FILE_TYPE) || !Array.isArray(data.entries)) throw new Error('这不是本插件导出的历史记录文件');
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
    // 不来自字段的入参填的值：字符串，或（多选）字符串数组
    const value = (v: any) => (typeof v === 'string' ? { value: v } : Array.isArray(v) ? { value: v.map(String) } : {});
    const io = (raw: any): Mapping[] => {
      if (!Array.isArray(raw)) throw new Error('函数配置的结构不对');
      return raw.map((m: any) => ({ param: String(m?.param ?? ''), fieldId: mapField(String(m?.fieldId ?? ''), String(m?.fieldName ?? '')), ...(typeof m?.fn === 'string' && m.fn ? { fn: m.fn } : {}), ...value(m?.value) }));
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

  // mode：'run' 运行历史（标题行的历史按钮）：只列运行记录，用来复现整套「筛选 + 函数」配置；'filter' 筛选历史（筛选块菜单里的历史）：只列筛选 / 预览 / 统计 / 导出，只管筛选条件
  function openHistory(mode: 'run' | 'filter' = 'run') {
    const isRunMode = mode === 'run';
    const inMode = (e: HistoryEntry) => (e.kind === 'run') === isRunMode;
    const pad = (n: number) => String(n).padStart(2, '0');
    const dayLabel = (t: number) => {
      const d = new Date(t), today = new Date();
      const diff = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000);
      return diff === 0 ? '今天' : diff === 1 ? '昨天' : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };
    const overlay = document.createElement('div');
    overlay.className = 'af-modal';
    overlay.innerHTML = `<div class="af-modal-box af-hist-box" role="dialog" aria-modal="true">
      <div class="af-modal-head"><span>${isRunMode ? '运行历史' : '筛选历史'}（最多 ${HISTORY_LIMIT} 条，命名过的优先保留）</span><button class="af-x" data-close title="关闭">×</button></div>
      <div class="af-hist-search"><input type="text" data-search placeholder="搜索名称、字段名、条件、函数名…" /></div>
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
      const items = readHistory().filter(inMode).map(e => {
        const when = new Date(e.time);
        const lines = isRunMode ? [`筛选：${describeFilter(e.config.filter)}`, ...(describeFns(e.config).length ? describeFns(e.config).map(l => `函数：${l}`) : ['函数：未配置'])] : [`筛选：${describeFilter(e.config.filter)}`];
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
      if (!shown.length) { listEl.innerHTML = `<div class="af-hint">${items.length ? '没有匹配的历史记录' : (isRunMode ? '还没有运行记录：运行之后，会把当时的筛选条件和函数配置记在这里' : '还没有筛选记录：筛选、预览、统计或导出之后，会把当时的筛选条件记在这里')}</div>`; return; }
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
          <div class="af-hist-btns"><span class="af-hist-btns-left">${isRunMode ? `<button class="af-add" data-h="all" title="把筛选条件和函数配置整套换成这条记录当时的配置">恢复全部</button><button class="af-add" data-h="filter" title="只替换筛选条件，函数配置保持不变">仅恢复筛选</button><button class="af-add" data-h="fns" title="只替换函数配置（各函数、入参映射、输出字段），筛选条件保持不变">仅恢复函数</button>` : `<button class="af-add" data-h="filter" title="把筛选条件换成这条记录当时的条件，函数配置保持不变">恢复筛选条件</button>`}<button class="af-add" data-h="export" title="把这条历史记录导出为文件">导出</button></span></div>
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
      if (entry && restoreHistory(entry, btn.dataset.h === 'filter' ? 'filter' : btn.dataset.h === 'fns' ? 'fns' : 'all')) close();
    });
    searchEl.addEventListener('input', draw);
    document.addEventListener('keydown', onKey);
    draw();
    document.body.appendChild(overlay); // 挂在 body 上，不受面板缩放影响
    searchEl.focus();
  }

  // ── 统计：读取记录、筛选，在侧边栏里弹出悬浮窗看统计（窗口里可以再在新标签页打开，空间更大）──
  async function statsFiltered() {
    if (running || exporting) return;
    const regexErr = checkRegexes(config.filter);
    if (regexErr) { setStatus(regexErr, 'error'); return; }
    exporting = true;
    setReadProgress('');
    render();
    let ready: { rows: string[][]; total: number } | null = null;
    try {
      const all = await host.loadAllRecords((done, n) => setReadProgress(` ${done}/${n}`));
      const matched = all.filter(r => evalGroup(config.filter, r));
      filterResult = { sig: filterSig(), matched: matched.length, total: all.length };
      recordHistory('stats', matched.length, all.length);
      if (matched.length === 0) setStatus(`视图共 ${all.length} 条记录，没有符合筛选条件的记录`, '');
      else { ready = { rows: filteredRows(matched), total: all.length }; setStatus('', ''); }
    } catch (e) {
      setStatus(`统计失败：${describeError(e, 'read')}`, 'error');
    } finally {
      exporting = false;
      const keep = { text: statusText, kind: statusKind };
      render();
      setStatus(keep.text, keep.kind);
    }
    if (!ready) return;
    const { rows, total } = ready;
    const [head, ...body] = rows;
    const overlay = document.createElement('div');
    overlay.className = 'af-modal';
    overlay.innerHTML = `<div class="af-modal-box af-stats-box" role="dialog" aria-modal="true">
      <div class="af-modal-head"><span>统计：命中 ${body.length} / 共 ${total} 条</span><button class="af-x" data-close title="关闭">×</button></div>
      <div class="af-modal-body af-stats-body"></div>
      <div class="af-modal-foot"><span>这是点击统计那一刻的快照，不会自动更新${dataAgeHint()}</span><span class="af-modal-actions"><button class="af-add" data-newtab title="在新标签页里打开，能用上整个浏览器窗口">在新标签页打开</button></span></div>
    </div>`;
    renderStatsView(overlay.querySelector('.af-stats-body') as HTMLElement, head, body, multiFlags());
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    overlay.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t === overlay || t.closest('[data-close]')) close();
      else if (t.closest('[data-newtab]')) openPreviewTab(rows, total, 'stats');
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay); // 挂在 body 上，不受面板缩放影响
  }

  async function startRun() {
    if (running || exporting) return;
    const err = validate();
    if (err) { setStatus(err, 'error'); return; }
    running = true;
    cancelled = false;
    // 每次点「运行」生成一个唯一的运行 ID（也就是函数历史里的“批次”）：异步任务带着它，历史才能按批次分组
    const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const runAt = Date.now();
    setStatus('正在读取视图记录…', '');
    render();
    const fieldById = new Map(host.getAllFields().map(f => [f.id, f]));
    let written = 0, failed = 0, skipped = 0, called = 0, matchedCount = 0, dispatched = 0;
    let hasWrites = true; // 输出里有没有要写进字段的（全是“只调用的函数”则没有）
    failures = [];
    // 失败明细里带上送给函数的输入：用到的各函数的输入映射，相同的（参数 + 字段）只列一列；不来自字段的入参，列里是填写的值
    const inCols: { label: string; fieldId: string; value?: string }[] = [];
    for (const fn of new Map(config.outputs.flatMap(o => { const f = fnOfKey(o.param); return f ? [[f.id, f] as [string, FnMeta]] : []; })).values()) {
      for (const inp of fn.inputs) {
        if (isManual(inp)) {
          const m = config.inputs.find(i => i.fn === fn.id && i.param === inp.name);
          const value = Array.isArray(m?.value) ? m!.value.join(',') : m?.value ?? '';
          const label = `${inp.name}(填写值)`;
          if (m && !inCols.some(c => c.label === label && c.value === value)) inCols.push({ label, fieldId: '', value });
          continue;
        }
        const fid = inputField(fn.id, inp.name);
        const label = `${inp.name}(${fieldById.get(fid)?.name ?? fid})`;
        if (fid && !inCols.some(c => c.label === label && c.fieldId === fid)) inCols.push({ label, fieldId: fid });
      }
    }
    failureHeaders = inCols.map(c => c.label);
    const optionsOf = new Map<string, FieldOption[]>(); // 单选/多选输出字段的选项
    let historyId = '';
    try {
      const all = await host.loadAllRecords((done, total) => setStatus(`正在读取视图记录… ${done}/${total}`, ''), { fresh: true });
      const matched = all.filter(r => evalGroup(config.filter, r));
      matchedCount = matched.length;
      filterResult = { sig: filterSig(), matched: matched.length, total: all.length };
      if (matched.length === 0) { setStatus(`视图共 ${all.length} 条记录，没有符合筛选条件的记录`, ''); return; }
      // 同步函数的写入（hasWrites、writeOuts 都只看同步函数）；异步函数的结果由服务端跑完后，插件取回再写，不在这次运行里写
      const fnOf = (key: string) => findCall(key) ?? findOutput(key)?.fn;
      const allWriteOuts = config.outputs.filter(o => !o.param.startsWith(FN_PREFIX) && o.fieldId);
      const writeOuts = allWriteOuts.filter(o => !fnOf(o.param)?.async);
      hasWrites = writeOuts.length > 0;
      // 只调用、不写入的函数：添加了但没选输出参数的，以及输出参数都没选字段的
      const writtenFns = new Set(allWriteOuts.map(o => fnOf(o.param)?.id));
      const callOnly = [...new Set(config.outputs.map(o => fnOf(o.param)).filter((f): f is FnMeta => !!f && !f.async && !writtenFns.has(f.id)).map(f => f.name))];
      const asyncFnList = [...new Map(config.outputs.map(o => fnOf(o.param)).filter((f): f is FnMeta => !!f && !!f.async).map(f => [f.id, f] as [string, FnMeta])).values()];
      const asyncPlan = asyncFnList.map(f => {
        const labels = allWriteOuts.filter(o => fnOf(o.param)?.id === f.id).map(o => outLabel(o.param));
        return `${f.name}${labels.length ? `（写入：${labels.join('、')}）` : '（只调用）'}`;
      });
      const plan = [
        hasWrites ? `将调用函数并覆盖写入：${writeOuts.map(o => outLabel(o.param)).join('、')}` : '',
        callOnly.length ? `将调用函数：${callOnly.join('、')}（只调用，不写入表格）` : '',
        asyncPlan.length ? `将下发异步函数：${asyncPlan.join('、')}\n（在服务端后台执行，完成后自动覆盖写入；期间需保持这张表的插件页面开着）` : '',
      ].filter(Boolean).join('\n');
      if (!confirm(`视图共 ${all.length} 条记录，${matched.length} 条符合筛选条件。\n${plan}\n\n确定开始吗？`)) {
        setStatus('已取消', '');
        return;
      }
      historyId = recordHistory('run', matched.length, all.length);
      updateHistory(historyId, { runId });
      saveRunCfg(runId, runAt); // 记下批次 ID，函数块的历史据此复现当时的函数配置

      // 按函数分组：同一个函数的多个输出，一次调用拿齐
      const byFn = new Map<string, { fn: FnMeta; outs: { name: string; fieldId: string }[] }>();
      for (const o of config.outputs) {
        const call = findCall(o.param);
        if (call) { // 只调用的函数：没有要写的输出，但要照常调用
          if (!byFn.has(call.id)) byFn.set(call.id, { fn: call, outs: [] });
          continue;
        }
        const hit = findOutput(o.param)!;
        if (!byFn.has(hit.fn.id)) byFn.set(hit.fn.id, { fn: hit.fn, outs: [] });
        byFn.get(hit.fn.id)!.outs.push({ name: hit.out.name, fieldId: o.fieldId });
      }
      for (const o of config.outputs) {
        const f = fieldById.get(o.fieldId);
        if (f && needsOptions(f.type) && !optionsOf.has(o.fieldId)) optionsOf.set(o.fieldId, await host.getFieldOptions(o.fieldId));
      }
      const indexOf = new Map(all.map((r, i) => [r.recordId, i + 1]));

      // 适配层：写回表格固定每 WRITE_BATCH（100）条提交一次；调用函数则按函数自己的 batchSize 来——
      // 一轮取选中的函数里最大的批大小那么多条记录，批大小大于 100 的函数把几个 100 攒成一次调用，小于 100 的拆成几次；
      // 一轮算完，结果再按 100 条一批写回。取消在一轮处理完后生效（只选一个函数时，一轮就是一次调用）
      const sentBy = new Map<string, number>(); // 异步函数 → 已下发条数
      // 批次：这次点「运行」是一个批次，被函数的 batchSize 拆成多个任务，任务带着批次信息，面板里才看得出它们的关系
      const partSeq = new Map<string, number>(); // 异步函数 → 已拆出几个任务
      const partsOf = (fn: FnMeta) => { // 这个函数在这个批次里一共会拆成几个任务（每一轮取 roundSize 条，再按函数的批大小拆）
        const size = batchOf(fn);
        return Math.floor(matched.length / roundSize) * Math.ceil(roundSize / size) + (matched.length % roundSize ? Math.ceil((matched.length % roundSize) / size) : 0);
      };
      const syncFns = [...byFn.values()].filter(x => !x.fn.async);
      const asyncFns = [...byFn.values()].filter(x => x.fn.async);
      const roundSize = Math.max(...[...byFn.values()].map(x => batchOf(x.fn)));
      for (let start = 0; start < matched.length; start += roundSize) {
        if (cancelled) break;
        const chunk = matched.slice(start, start + roundSize);
        // 多个函数的入参映射到同一个字段时，这一轮里每条记录的这个字段只转一次文本
        const textCache = new Map<string, string>();
        const cellOf = (rec: RecordData, fid: string) => {
          const k = rec.recordId + '\u0000' + fid;
          let t = textCache.get(k);
          if (t === undefined) { t = cellText(rec.fields[fid]); textCache.set(k, t); }
          return t;
        };
        const values = chunk.map(() => ({} as Record<string, any>));
        const bad = chunk.map(() => '');
        // 字段入参每行取那一格的文本；不来自字段的入参每行都是卡片里填的同一个值（多选是字符串数组）
        const buildRows = (fn: FnMeta) => {
          const plan = fn.inputs.flatMap((inp): { name: string; fieldId: string; value?: string | string[] }[] => {
            const m = config.inputs.find(i => i.fn === fn.id && i.param === inp.name);
            if (!m) return [];
            if (isManual(inp)) return [{ name: inp.name, fieldId: '', value: m.value ?? (inp.type === 'multiSelect' ? [] : '') }];
            return m.fieldId ? [{ name: inp.name, fieldId: m.fieldId, value: undefined }] : [];
          });
          return chunk.map(rec => {
            const row: Record<string, any> = {};
            for (const p of plan) row[p.name] = p.fieldId ? cellOf(rec, p.fieldId) : p.value;
            return row;
          });
        };
        for (const { fn, outs } of syncFns) {
          const rows = buildRows(fn);
          const size = batchOf(fn);
          const results: FnResult[] = [];
          for (let s = 0; s < rows.length; s += size) {
            // 每一批调用都记进历史（成功 / 失败条数、用时），有执行详情的一起收进去（有说明就弹出 / 追加到历史窗口）
            const indexes = chunk.slice(s, s + size).map(r => indexOf.get(r.recordId) || 0);
            const seq = (partSeq.get(fn.id) || 0) + 1;
            partSeq.set(fn.id, seq);
            const ref = { id: runId, at: runAt, part: seq, parts: partsOf(fn) };
            const t0 = Date.now();
            let part: { results: FnResult[]; message?: string };
            try { part = await callFunction(fn, rows.slice(s, s + size)); }
            catch (e) { pushCall(makeCall(fn, indexes, ref, [], Date.now() - t0, e instanceof Error ? e.message : String(e))); throw e; }
            results.push(...part.results);
            pushCall(makeCall(fn, indexes, ref, part.results, Date.now() - t0));
            pushNote(makeNote(fn, part.results, part.message, indexes, false, ref));
          }
          results.forEach((r, i) => {
            if (bad[i]) return;
            if (!r.ok) { bad[i] = r.error || '函数执行失败'; return; }
            try {
              for (const o of outs) {
                if (!o.fieldId) continue; // 没选字段：不写入，也不要求函数返回它
                if (!r.outputs || !(o.name in r.outputs)) throw new Error(`函数“${fn.name}”没有返回“${o.name}”`);
                if (r.outputs[o.name] === null) continue; // 函数返回 null：这个字段不写入，保留原值
                values[i][o.fieldId] = toFieldValue(fieldById.get(o.fieldId)!, r.outputs[o.name], optionsOf.get(o.fieldId));
              }
            } catch (e) { bad[i] = e instanceof Error ? e.message : String(e); }
          });
        }
        const items: { recordId: string; fields: Record<string, any> }[] = [];
        chunk.forEach((rec, i) => {
          if (syncFns.length === 0) return; // 这次选的全是异步函数：没有同步结果可统计
          if (bad[i]) {
            failed++;
            failures.push({ index: indexOf.get(rec.recordId) || 0, recordId: rec.recordId, inputs: inCols.map(c => (c.fieldId ? cellText(rec.fields[c.fieldId]) : c.value ?? '')), error: bad[i] });
          } else if (!hasWrites) called++; // 只调用的函数：成功就算已调用，没有要写的内容
          else if (Object.keys(values[i]).length === 0) skipped++; // 所有输出都是 null，没有可写的内容
          else items.push({ recordId: rec.recordId, fields: values[i] });
        });
        for (let s = 0; s < items.length; s += WRITE_BATCH) {
          const part = items.slice(s, s + WRITE_BATCH);
          await host.writeRecords(part);
          written += part.length;
        }
        // 异步函数：同步函数的结果写完后，把这一轮的行下发成任务（立刻返回，不等执行）
        for (const { fn, outs } of asyncFns) {
          const rows = buildRows(fn);
          const size = batchOf(fn);
          const mapped = outs.filter(o => o.fieldId);
          for (let s = 0; s < rows.length; s += size) {
            const part = chunk.slice(s, s + size);
            const seq = (partSeq.get(fn.id) || 0) + 1;
            partSeq.set(fn.id, seq);
            const run: RunInfo = { id: runId, at: runAt, total: matched.length, part: seq, parts: partsOf(fn), from: start + s + 1, to: start + s + part.length };
            await dispatchJob(fn, rows.slice(s, s + size), { recordIds: part.map(r => r.recordId), indexes: part.map(r => indexOf.get(r.recordId) || 0), outs: mapped, run });
            // 按函数累计，已下发条数取各函数里最多的那个（同一条记录给多个异步函数只算一条）；下发到一半失败时，已成功的部分也如实计入
            sentBy.set(fn.id, (sentBy.get(fn.id) || 0) + part.length);
            dispatched = Math.max(dispatched, ...sentBy.values());
          }
        }
        const prog = [syncFns.length ? `${hasWrites ? `已写入 ${written}` : `已调用 ${called}`}，失败 ${failed}` : '', asyncFns.length ? `已下发 ${dispatched}` : ''].filter(Boolean).join('，');
        setStatus(`进度 ${Math.min(start + roundSize, matched.length)}/${matched.length}（${prog}）`, '');
      }
      const syncPart = syncFns.length
        ? (hasWrites ? `已写入 ${written} 条` : `已调用 ${called} 条（只调用，不写入表格）`) + `，失败 ${failed} 条` +
          (skipped ? `，跳过 ${skipped} 条（函数没有返回内容，未写入）` : '') + (failed ? '（详见下方失败明细）' : '')
        : '';
      const asyncPart = asyncFns.length ? `已下发 ${dispatched} 条给异步函数（后台执行，完成后自动写回，进度见「函数」块右上角的标签）` : '';
      const summary = `${cancelled ? '已取消' : '完成'}：符合筛选 ${matchedCount} 条，` + [syncPart, asyncPart].filter(Boolean).join('；');
      setStatus(summary, failed || cancelled ? 'error' : 'ok');
      if (historyId) updateHistory(historyId, { result: summary, ok: !(failed || cancelled) });
    } catch (e) {
      const doneText = `已写入 ${written} 条` + (dispatched ? `，已下发 ${dispatched} 条给异步函数（它们仍会照常执行并回写）` : '');
      setStatus(`中断：${describeError(e, 'write')}\n${doneText}，其余记录未处理`, 'error');
      if (historyId) updateHistory(historyId, { result: `中断：${doneText}，其余记录未处理`, ok: false });
    } finally {
      running = false;
      const keep = { text: statusText, kind: statusKind };
      render();
      setStatus(keep.text, keep.kind);
      if (dispatched > 0) refreshJobs(); // 刚下发了任务：马上刷新一次任务区，之后自动轮询
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
