import http, { createServer } from 'http';
import { lookup as dnsLookup } from 'dns';
import { isIP } from 'net';
import { readFile, stat } from 'fs/promises';
import { gzip, brotliCompress, constants as zlibConstants } from 'zlib';
import { promisify } from 'util';
import { join, extname, sep, dirname } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import { URL } from 'url';
import { readdir, mkdtemp, writeFile, unlink, rmdir } from 'fs/promises';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import { pathToFileURL } from 'url';
import { createJobStore } from './jobs.mjs';
import { createFnLocks } from './locks.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..', 'dist');
const ASSETS = join(ROOT, 'assets');
const PORT = process.env.PORT || 6868;

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.webp': 'image/webp',
  '.json': 'application/json',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.ogg':  'video/ogg',
  '.mov':  'video/quicktime',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.flac': 'audio/flac',
  '.aac':  'audio/aac',
};

const MAX_REDIRECTS = 5;
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'];
const FORWARD_HEADERS = ['range', 'if-range', 'if-none-match', 'if-modified-since', 'accept', 'accept-encoding', 'user-agent'];

// 内网段（10/8、172.16/12、192.168/16、100.64/10）有意放行——代理的目的就是访问浏览器够不到的内网资源。
// 只拦截本机回环、链路本地（云元数据 169.254.x）、未指定/组播/保留地址，防止借代理打本机服务。
function isBlockedIP(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 127 || (a === 169 && b === 254) || a >= 224;
  }
  const lo = ip.toLowerCase();
  const mapped = lo.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIP(mapped[1]);
  if (lo.startsWith('::ffff:')) return true;
  return lo === '::' || lo === '::1' || /^fe[89ab]/.test(lo) || lo.startsWith('ff');
}

// 校验解析结果并固定到该 IP，防 DNS rebinding
function safeLookup(hostname, options, cb) {
  dnsLookup(hostname, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = addrs.filter(a => !isBlockedIP(a.address));
    if (!list.length) return cb(new Error('Target address is not allowed'));
    if (options && options.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

function proxyRequest(targetUrl, req, res, redirects = 0) {
  let parsed;
  try { parsed = new URL(targetUrl); } catch { res.writeHead(400); return res.end('Bad proxy URL'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    res.writeHead(400);
    return res.end('Only http/https is supported');
  }
  // IP 字面量不会触发 lookup，需单独校验
  const bareHost = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isIP(bareHost) && isBlockedIP(bareHost)) {
    res.writeHead(403);
    return res.end('Target address is not allowed');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end('Method not allowed');
  }

  const headers = { host: parsed.host };
  for (const h of FORWARD_HEADERS) if (req.headers[h]) headers[h] = req.headers[h];

  const client = parsed.protocol === 'https:' ? https : http;
  const proxyReq = client.request({
    hostname: parsed.hostname,
    port: parsed.port || undefined,
    path: parsed.pathname + parsed.search,
    method: req.method,
    headers,
    lookup: safeLookup,
  }, (proxyRes) => {
    const status = proxyRes.statusCode;
    if ([301, 302, 303, 307, 308].includes(status) && proxyRes.headers.location) {
      proxyRes.resume();
      if (redirects >= MAX_REDIRECTS) { res.writeHead(502); return res.end('Too many redirects'); }
      return proxyRequest(new URL(proxyRes.headers.location, parsed).href, req, res, redirects + 1);
    }
    const out = { ...proxyRes.headers };
    for (const h of HOP_BY_HOP) delete out[h];
    delete out['set-cookie'];
    res.writeHead(status, out);
    proxyRes.pipe(res);
    proxyRes.on('error', () => res.destroy());
  });

  proxyReq.on('error', (err) => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502);
    res.end('Proxy error: ' + err.message);
  });
  proxyReq.setTimeout(30000, () => proxyReq.destroy(new Error('Proxy timeout')));
  res.on('close', () => proxyReq.destroy());
  proxyReq.end();
}

// ── 网页能否被 iframe 嵌入的检查：/api/frame-check?url=<目标URL> → { embeddable: true|false|null, reason } ──
// 只看响应头：X-Frame-Options（DENY / SAMEORIGIN 都不能被我们嵌入）和 CSP 的 frame-ancestors（没有 * 就视为禁止）。
// embeddable 为 null 表示没查出来（目标连不上、超时等），前端按“可以嵌入”处理。结果缓存 10 分钟。
const FRAME_CHECK_TTL = 10 * 60 * 1000;
const frameCheckCache = new Map();

function judgeFrameHeaders(headers) {
  const xfo = String(headers['x-frame-options'] || '').toLowerCase();
  if (xfo.includes('deny') || xfo.includes('sameorigin') || xfo.includes('allow-from')) {
    return { embeddable: false, reason: 'X-Frame-Options: ' + xfo };
  }
  const csp = String(headers['content-security-policy'] || '');
  const m = csp.match(/frame-ancestors([^;]*)/i);
  if (m && m[1].split(/\s+/).indexOf('*') < 0) {
    return { embeddable: false, reason: 'CSP frame-ancestors:' + m[1] };
  }
  return { embeddable: true, reason: 'no frame restrictions' };
}

function frameCheckOnce(targetUrl, redirects) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(targetUrl); } catch { return resolve({ embeddable: null, reason: 'bad url' }); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return resolve({ embeddable: null, reason: 'unsupported protocol' });
    const bareHost = parsed.hostname.replace(/^\[|\]$/g, '');
    if (isIP(bareHost) && isBlockedIP(bareHost)) return resolve({ embeddable: null, reason: 'address not allowed' });
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request({
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { host: parsed.host, 'user-agent': 'Mozilla/5.0 data-engine-frame-check', accept: 'text/html' },
      lookup: safeLookup,
    }, (res) => {
      res.destroy(); // 只要响应头，不读内容
      const status = res.statusCode;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        if (redirects >= MAX_REDIRECTS) return resolve({ embeddable: null, reason: 'too many redirects' });
        return resolve(frameCheckOnce(new URL(res.headers.location, parsed).href, redirects + 1));
      }
      resolve(judgeFrameHeaders(res.headers));
    });
    req.on('error', (err) => resolve({ embeddable: null, reason: err.message }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ embeddable: null, reason: 'timeout' }); });
    req.end();
  });
}

async function frameCheck(targetUrl) {
  const hit = frameCheckCache.get(targetUrl);
  if (hit && Date.now() - hit.at < FRAME_CHECK_TTL) return hit.result;
  const result = await frameCheckOnce(targetUrl, 0);
  if (result.embeddable !== null) frameCheckCache.set(targetUrl, { at: Date.now(), result });
  return result;
}

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg']);

// 静态文件内容与压缩结果按 mtime 缓存在内存里（dist 总共才 1MB 左右），重新构建后自动失效
const staticCache = new Map();

async function loadStatic(filePath) {
  const st = await stat(filePath);
  if (!st.isFile()) throw new Error('Not a file');
  let entry = staticCache.get(filePath);
  if (!entry || entry.mtimeMs !== st.mtimeMs) {
    entry = {
      mtimeMs: st.mtimeMs,
      etag: `W/"${st.size}-${Math.floor(st.mtimeMs)}"`,
      raw: await readFile(filePath),
      gz: null,
      br: null,
    };
    staticCache.set(filePath, entry);
  }
  return entry;
}

// 带哈希的 assets/* 永久缓存；html 等入口文件每次校验 ETag（未变化返回 304）
async function sendStatic(req, res, filePath) {
  const entry = await loadStatic(filePath);
  const ext = extname(filePath).toLowerCase();
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': filePath.startsWith(ASSETS + sep) ? 'public, max-age=31536000, immutable' : 'no-cache',
    'ETag': entry.etag,
    'Vary': 'Accept-Encoding',
  };
  if (req.headers['if-none-match'] === entry.etag) {
    res.writeHead(304, headers);
    return res.end();
  }

  let body = entry.raw;
  if (COMPRESSIBLE.has(ext)) {
    const accepted = (req.headers['accept-encoding'] || '').split(',').map(e => e.trim().split(';')[0]);
    if (accepted.includes('br')) {
      if (!entry.br) entry.br = await brotliAsync(entry.raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 } });
      body = entry.br;
      headers['Content-Encoding'] = 'br';
    } else if (accepted.includes('gzip')) {
      if (!entry.gz) entry.gz = await gzipAsync(entry.raw);
      body = entry.gz;
      headers['Content-Encoding'] = 'gzip';
    }
  }
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

// ── 函数注册表：热加载 functions/ 下的函数文件夹 ─────────────
// 一个函数 = 一个文件夹，文件夹里必须有入口文件 function.mjs（JS）或 function.py（Python），其余文件（依赖的模块、数据、配置）随便放。
// 不含入口文件的文件夹是“分类目录”，可以多层嵌套，目录结构就是面板里选函数时的层级；函数文件夹里面不再往下找函数。
// 每次请求都扫一遍目录，新增 / 修改 / 删除立即生效，不用重启服务。以 _ 或 . 开头的文件和目录被忽略；某个函数加载失败只在日志里报错，不影响其他函数。
const FUNCTIONS_DIR = join(__dirname, 'functions');
const ENTRY_FILES = ['function.mjs', 'function.py'];
const fnFileCache = new Map(); // 函数文件夹（相对路径）→ { sig, defs }

function validDef(d) {
  const okParams = (list) => Array.isArray(list) && list.every(p => p && typeof p.name === 'string' && p.name);
  // outputs 可以不写 / 写空数组：只调用、不往表格写值的函数（比如发通知、触发任务）
  return d && typeof d.id === 'string' && d.id && typeof d.name === 'string' && typeof d.run === 'function'
    && okParams(d.inputs) && d.inputs.every(p => validInput(d.id, p)) && (d.outputs === undefined || (okParams(d.outputs) && validOutputs(d.id, d.outputs)));
}

// ── 出参的类型：type 不写 = 普通出参（值写进表格字段）；
//   detail   执行详情（旧名 message 仍然认）：一段文本，描述这一行 / 这一批执行得怎么样。不写进字段，也不出现在“＋输出”的选项里，面板每次调用都会收集并展示（悬浮窗）。每个函数最多一个
// 另外 run 可以不返回数组，而返回 { results: [...与 rows 等长], detail: '本批整体的详情' }（旧名 message 仍然认），detail 是这一批（这一次 run）的详情，同样给面板展示
const OUTPUT_TYPES = ['detail', 'message'];
const isDetailOut = (o) => o && (o.type === 'detail' || o.type === 'message');
const MAX_NOTE = 20000; // 单条说明的字数上限，超出截断（说明是给人看的，免得撑大响应和落盘的任务文件）
function validOutputs(fnId, list) {
  let why = '';
  for (const p of list) if (p.type !== undefined && OUTPUT_TYPES.indexOf(p.type) < 0) { why = '出参 ' + p.name + ' 的 type 只能是 ' + OUTPUT_TYPES.join(' / ') + '（或不写），收到 ' + JSON.stringify(p.type); break; }
  if (!why && list.filter(isDetailOut).length > 1) why = 'type: "detail" 的出参最多一个';
  if (why) console.error('[functions] 函数 ' + fnId + ' 不合法：' + why);
  return !why;
}
function noteText(v) {
  if (v === null || v === undefined) return undefined;
  let t = typeof v === 'string' ? v : (typeof v === 'object' ? JSON.stringify(v) : String(v));
  if (!t.trim()) return undefined;
  if (t.length > MAX_NOTE) t = t.slice(0, MAX_NOTE) + '\n…（说明过长，已截断）';
  return t;
}
// 把 run 的返回规整成 { results: [{ok, outputs} | {ok:false, error}], detail? }。返回的可以是数组，也可以是 { results, detail }
function shapeRun(fn, out, n) {
  let list = out, message;
  if (out && !Array.isArray(out) && typeof out === 'object' && Array.isArray(out.results)) { list = out.results; message = noteText(out.detail !== undefined ? out.detail : out.message); }
  if (!Array.isArray(list) || list.length !== n) {
    throw new Error('函数 ' + fn.id + ' 必须返回与 rows 等长的数组（收到 ' + n + ' 行，返回 ' + (Array.isArray(list) ? list.length : typeof list) + '）');
  }
  const msgName = ((fn.outputs || []).find(isDetailOut) || {}).name;
  const results = list.map((o) => {
    if (o instanceof Error) return { ok: false, error: o.message };
    const outputs = Object.assign({}, o || {});
    if (msgName && msgName in outputs) { const t = noteText(outputs[msgName]); if (t === undefined) delete outputs[msgName]; else outputs[msgName] = t; }
    return { ok: true, outputs };
  });
  return message === undefined ? { results } : { results, detail: message };
}

// ── 入参的取值方式：type 不写（或写 'field'）= 由面板映射到字段，每行取那一格的文本（原来的方式）；
// 另外三种不来自字段，在面板的函数卡片里直接填，整次运行每一行都是同一个值：
//   select       单选：从 options 里选一个，run 拿到字符串
//   multiSelect  多选：从 options 里勾若干个，run 拿到字符串数组（按 options 的顺序）
//   text         文本：手动输入，run 拿到字符串
// options：['a', 'b'] 或 [{ value: 'a', label: '显示名' }]（value 是传给 run 的值）；default：面板里的初始值（multiSelect 是数组）；
// description：给填写的人看的说明，显示在输入行下面
const INPUT_TYPES = ['field', 'select', 'multiSelect', 'text'];
const isManualInput = (p) => !!p.type && p.type !== 'field';
const optionList = (p) => (Array.isArray(p.options) ? p.options : [])
  .filter(o => o != null && (typeof o !== 'object' || o.value != null))
  .map(o => (typeof o === 'object' ? { value: String(o.value), label: String(o.label != null ? o.label : o.value) } : { value: String(o), label: String(o) }))
  .filter(o => o.value !== '');

function validInput(fnId, p) {
  let why = '';
  if (p.type !== undefined && INPUT_TYPES.indexOf(p.type) < 0) why = 'type 只能是 ' + INPUT_TYPES.join(' / ') + '，收到 ' + JSON.stringify(p.type);
  else if ((p.type === 'select' || p.type === 'multiSelect') && !optionList(p).length) why = p.type + ' 必须写 options（非空数组）';
  else if (p.type === 'select' && p.default !== undefined && !optionList(p).some(o => o.value === String(p.default))) why = 'default 不在 options 里';
  else if (p.type === 'multiSelect' && p.default !== undefined && !(Array.isArray(p.default) && p.default.every(v => optionList(p).some(o => o.value === String(v))))) why = 'multiSelect 的 default 必须是 options 里的值组成的数组';
  if (why) console.error('[functions] 函数 ' + fnId + ' 的入参 ' + p.name + ' 不合法：' + why);
  return !why;
}

// 给面板的入参描述：字段入参保持原样（name、label），其他取值方式带上 type / options / default / description
function publicInput(p) {
  const out = { name: p.name, label: p.label };
  if (typeof p.description === 'string' && p.description) out.description = p.description;
  if (!isManualInput(p)) return out;
  out.type = p.type;
  if (p.type !== 'text') out.options = optionList(p);
  if (p.default !== undefined) out.default = p.type === 'multiSelect' ? p.default.map(String) : String(p.default);
  return out;
}

// 不来自字段的入参，请求里没带（比如 curl 直接调）时用声明的 default 补上；面板总会带上
function fillDefaults(fn, rows) {
  const defs = fn.inputs.filter(p => isManualInput(p) && p.default !== undefined).map(publicInput);
  if (!defs.length) return rows;
  return rows.map((r) => {
    const row = Object.assign({}, r);
    for (const p of defs) if (!(p.name in row)) row[p.name] = p.default;
    return row;
  });
}

// 函数每次 run 建议拿到的行数：函数用 batchSize 自己声明，没写就是默认值；限制在 1 ~ MAX_BATCH 之间。
// 服务端只负责把它告诉面板（/api/functions），拆分 / 攒批由前端按它来做；run 接口收到多少行就一次交给函数多少行
const DEFAULT_BATCH = 100;
const MAX_BATCH = 5000;
function batchSizeOf(d) {
  const n = Math.floor(Number(d.batchSize));
  return n >= 1 ? Math.min(n, MAX_BATCH) : DEFAULT_BATCH;
}

// ── Python 函数：由 functions/_python_executor.py 加载 .py 并执行，一批行启动一次进程 ──
// 数据经临时目录里的 JSON 文件传递（不走命令行参数和管道），数据量不受限制
const PYTHON_BIN = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
const PY_EXECUTOR = join(FUNCTIONS_DIR, '_python_executor.py');
const PY_META_TIMEOUT = 15000;
const PY_RUN_TIMEOUT = Number(process.env.PY_RUN_TIMEOUT_MS) || 300000; // 单批执行的超时，可用环境变量调大
const PY_ASYNC_TIMEOUT = Number(process.env.PY_ASYNC_TIMEOUT_MS) || 4 * 3600 * 1000; // 异步函数（META 里 async: true）单批执行的超时，默认 4 小时

async function runPython(file, mode, input, timeoutMs) {
  const dir = await mkdtemp(join(tmpdir(), 'autoflush-'));
  const inPath = join(dir, 'in.json');
  const outPath = join(dir, 'out.json');
  try {
    await writeFile(inPath, JSON.stringify(input === undefined ? {} : input), 'utf8');
    await new Promise((resolve, reject) => {
      // 工作目录设为函数文件夹，函数里按相对路径读自己文件夹里的数据文件就行
      const child = spawn(PYTHON_BIN, [PY_EXECUTOR, file, mode, inPath, outPath], { cwd: dirname(file), env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      const err = [];
      let done = false;
      const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
      const timer = setTimeout(() => { child.kill(); finish(reject, new Error('Python 执行超时')); }, timeoutMs);
      child.stdout.on('data', () => {});
      child.stderr.on('data', c => err.push(c));
      child.on('error', e => finish(reject, new Error('无法启动 ' + PYTHON_BIN + '：' + e.message)));
      child.on('close', (code) => {
        const text = Buffer.concat(err).toString('utf8').trim();
        if (text) console.error('[python] ' + text);
        if (code !== 0) return finish(reject, new Error(text.split(String.fromCharCode(10)).pop() || '退出码 ' + code));
        finish(resolve, text);
      });
    });
    try { return JSON.parse(await readFile(outPath, 'utf8')); }
    catch { throw new Error('Python 没有产出合法的结果文件'); }
  } finally {
    // 不用 fs.rm（Node 14.14 才有）：删文件再删目录
    await unlink(inPath).catch(() => {});
    await unlink(outPath).catch(() => {});
    await rmdir(dir).catch(() => {});
  }
}

async function loadPyDef(full, fallbackId) {
  const meta = await runPython(full, 'meta', undefined, PY_META_TIMEOUT);
  return [{
    id: meta.id || fallbackId, name: meta.name || meta.id || fallbackId, inputs: meta.inputs, outputs: meta.outputs, batchSize: meta.batchSize, async: meta.async === true, serializeCalls: meta.serializeCalls === true || meta.serializeRuns === true, // serializeRuns 是旧名字，仍然认
    // 与 JS 函数同形：返回与 rows 等长的数组，失败的行是 Error
    async run(rows) {
      const data = await runPython(full, 'run', { rows }, meta.async === true ? PY_ASYNC_TIMEOUT : PY_RUN_TIMEOUT);
      if (!data || !Array.isArray(data.results)) throw new Error('Python 返回格式不对');
      const list = data.results.map(r => (r.ok ? r.outputs : new Error(r.error)));
      return data.detail === undefined || data.detail === null ? list : { results: list, detail: data.detail }; // 带批级详情时用 { results, detail }，和 JS 函数同形
    },
  }].filter(validDef);
}

// 递归找函数文件夹：含入口文件的文件夹是一个函数，不含的当分类目录往下找。
// 直接放在分类目录里的单个 .mjs / .py 文件（旧写法）不再加载，在日志里提醒一次该怎么改
const MAX_FN_DEPTH = 8;
const legacyWarned = new Set();
async function listFunctions(dir, folders, out) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch (e) { console.error('[functions] 读取目录失败:', e.message); return; }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const entryFile = folders.length > 0 ? ENTRY_FILES.find(n => entries.some(e => e.isFile() && e.name === n)) : undefined;
  if (entryFile) {
    out.push({ key: folders.join('/'), dir, full: join(dir, entryFile), categories: folders.slice(0, -1), folderName: folders[folders.length - 1] });
    return; // 函数文件夹里面不再找函数
  }
  for (const ent of entries) {
    if (ent.name.startsWith('_') || ent.name.startsWith('.') || ent.name === 'node_modules') continue;
    if (ent.isDirectory()) {
      if (folders.length < MAX_FN_DEPTH) await listFunctions(join(dir, ent.name), [...folders, ent.name], out);
    } else if (ent.isFile() && (ent.name.endsWith('.mjs') || ent.name.endsWith('.py'))) {
      const key = [...folders, ent.name].join('/');
      if (!legacyWarned.has(key)) {
        legacyWarned.add(key);
        console.error('[functions] 忽略 ' + key + '：函数现在要放在自己的文件夹里，入口文件命名为 function.mjs / function.py（例如 ' + [...folders, ent.name.replace(/\.(mjs|py)$/, '')].join('/') + '/' + (ent.name.endsWith('.py') ? 'function.py' : 'function.mjs') + '）');
      }
    }
  }
}

// 函数文件夹的“指纹”：里面所有文件的最新修改时间 + 文件数，任何一个文件变了（含依赖的模块）就重新加载。
// 跳过 node_modules / __pycache__ / .git，文件数封顶，免得拖慢每次请求
async function folderSignature(dir) {
  let latest = 0, count = 0;
  const walk = async (d, depth) => {
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (count > 3000) return;
      if (ent.name === 'node_modules' || ent.name === '__pycache__' || ent.name === '.git') continue;
      const p = join(d, ent.name);
      if (ent.isDirectory()) { if (depth < 6) await walk(p, depth + 1); }
      else if (ent.isFile()) { count++; try { latest = Math.max(latest, (await stat(p)).mtimeMs); } catch { /* 刚被删掉 */ } }
    }
  };
  await walk(dir, 0);
  return latest + '-' + count;
}

async function loadFunctions() {
  const found = [];
  await listFunctions(FUNCTIONS_DIR, [], found);
  const seen = new Set(found.map(f => f.key));
  for (const key of fnFileCache.keys()) if (!seen.has(key)) fnFileCache.delete(key);

  const all = [];
  const ids = new Set();
  for (const { key, dir, full, categories, folderName } of found) {
    try {
      const sig = await folderSignature(dir);
      let entry = fnFileCache.get(key);
      if (!entry || entry.sig !== sig) {
        // 带上指纹做查询串，绕开 Node 的模块缓存，重新加载改过的入口文件
        let defs;
        if (full.endsWith('.py')) {
          defs = await loadPyDef(full, folderName);
        } else {
          const mod = await import(pathToFileURL(full).href + '?v=' + sig);
          defs = (Array.isArray(mod.default) ? mod.default : [mod.default]).filter(Boolean);
          defs.forEach(d => { if (!d.id) d.id = folderName; if (!d.name) d.name = d.id; d.serializeCalls = d.serializeCalls === true || d.serializeRuns === true; }); // id、name 不写就用文件夹名；serializeRuns 是 serializeCalls 的旧名字，仍然认
          defs = defs.filter(validDef);
        }
        defs.forEach(d => { d.folder = categories; }); // 所在的分类目录（各级目录名，不含函数文件夹自己），面板按它分层
        entry = { sig, defs };
        fnFileCache.set(key, entry);
        console.log('[functions] 已加载 ' + key + '：' + (defs.map(d => d.id).join(', ') || '（没有有效的函数定义）'));
      }
      for (const d of entry.defs) {
        if (ids.has(d.id)) { console.error('[functions] 函数 id 重复，忽略 ' + key + ' 里的 ' + d.id); continue; }
        ids.add(d.id);
        all.push(d);
      }
    } catch (e) {
      // 失败的不缓存指纹，下次请求会重试；同时保留它上一次加载成功的版本
      console.error('[functions] 加载 ' + key + ' 失败:', e.message);
      const old = fnFileCache.get(key);
      if (old) for (const d of old.defs) if (!ids.has(d.id)) { ids.add(d.id); all.push(d); }
    }
  }
  return all;
}

// ── 批处理函数接口 ──────────────────────────────
// GET  /api/functions          → [{ id, name, inputs, outputs, batchSize, async, serializeCalls, serializeRuns, path }]（serializeRuns 是 serializeCalls 的旧名字，值相同，留给旧版面板）（path：函数所在分类目录的各级目录名，不含函数文件夹自己）
// POST /api/functions/<id>/run  body { rows: [{...入参}] } → { results: [{ ok: true, outputs } | { ok: false, error }], detail?: 这一批的整体详情 }（执行详情类型的出参就在 outputs 里）
const MAX_BODY = 64 * 1024 * 1024;

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('Bad JSON')); } });
    req.on('error', reject);
  });
}

async function handleFunctions(req, res, path) {
  if (path === '/api/functions' && req.method === 'GET') {
    const FUNCTIONS = await loadFunctions();
    return sendJson(res, 200, FUNCTIONS.map((d) => ({ id: d.id, name: d.name, inputs: d.inputs.map(publicInput), outputs: (d.outputs || []).map(o => (o.type === 'message' ? { ...o, type: 'detail' } : o)), batchSize: batchSizeOf(d), async: d.async === true, serializeCalls: d.serializeCalls === true, serializeRuns: d.serializeCalls === true, path: d.folder || [] })));
  }
  const m = path.match(/^\/api\/functions\/([^/]+)\/run$/);
  if (m && req.method === 'POST') {
    const fn = (await loadFunctions()).find(f => f.id === decodeURIComponent(m[1]));
    if (!fn) return sendJson(res, 404, { error: 'Unknown function' });
    let body;
    try { body = await readJson(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    if (!body || !Array.isArray(body.rows)) return sendJson(res, 400, { error: 'rows is required' });
    // 声明了 serializeCalls: true 的函数串行执行：同一时间最多一次 run 在跑，不管调用来自哪个运行，按到达先后排队（见 locks.mjs）。
    // 轮不到时最多等 LOCK_WAIT_MS 就回 202（前端自动重试并提示“排队中”），免得请求挂着被网关掐断
    let held = false;
    if (fn.serializeCalls === true) {
      // 前端第一次请求只等一小会儿（body.wait），好让排队的人马上看到“正在排队”的提示；之后的重试才等满 LOCK_WAIT_MS
      const askWait = Number(body.wait);
      const ticket = locks.enter(fn.id, askWait > 0 ? Math.min(askWait, LOCK_WAIT_MS) : LOCK_WAIT_MS);
      res.on('close', () => { if (!res.writableEnded) ticket.cancel(); }); // 排队时客户端断开了：退出排队
      const got = await ticket.promise;
      if (got === 'timeout') return sendJson(res, 202, { waiting: true });
      if (got !== 'ok') return;
      held = true;
    }
    // 批量计算：函数一次拿到全部 rows，返回与 rows 等长的数组；Error 项表示该行失败
    let shaped;
    try { shaped = shapeRun(fn, await fn.run(fillDefaults(fn, body.rows.map(r => r || {}))), body.rows.length); }
    catch (e) { return sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) }); }
    finally {
      if (held) locks.leave(fn.id);
    }
    return sendJson(res, 200, shaped); // { results, detail? }
  }
  // 异步函数：下发一批行，立刻返回任务 ID，函数在后台执行（任务和结果落盘，见 jobs.mjs）。只有声明了 async: true 的函数能这样用
  const jm = path.match(/^\/api\/functions\/([^/]+)\/jobs$/);
  if (jm && req.method === 'POST') {
    const fn = (await loadFunctions()).find(f => f.id === decodeURIComponent(jm[1]));
    if (!fn) return sendJson(res, 404, { error: 'Unknown function' });
    if (fn.async !== true) return sendJson(res, 400, { error: '函数 ' + fn.id + ' 不是异步函数（定义里没有 async: true）' });
    let body;
    try { body = await readJson(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    if (!body || !Array.isArray(body.rows)) return sendJson(res, 400, { error: 'rows is required' });
    if (typeof body.scope !== 'string' || !body.scope || body.scope.length > 200) return sendJson(res, 400, { error: 'scope is required' });
    const rows = fillDefaults(fn, body.rows.map(r => r || {}));
    const job = jobs.create({ fnId: fn.id, fnName: fn.name, scope: body.scope, rows, meta: body.meta, locked: fn.serializeCalls === true }, async (input) => {
      return shapeRun(fn, await fn.run(input), input.length);
    });
    return sendJson(res, 200, { job });
  }
  sendJson(res, 404, { error: 'Not found' });
}

// ── 异步任务接口 ─────────────────────────────────
// GET  /api/jobs?scope=<s>               → { jobs: [摘要] }（这张表下的全部任务）
// POST /api/jobs/<id>/claim  { scope }   → { job: 带 meta / results 的完整任务, token }；已被认领或状态不对返回 409
// POST /api/jobs/<id>/ack    { token, result }   回写完成，任务转为已回写
// POST /api/jobs/<id>/release { token }  回写没成功，放开认领
// POST /api/jobs/<id>/cancel { scope }   取消
const LOCK_WAIT_MS = Number(process.env.LOCK_WAIT_MS) || 25000; // 串行函数的同步调用排队等锁，一次请求最多等多久（到点回 202，前端重试）
const locks = createFnLocks();
const jobs = createJobStore(process.env.JOBS_DIR || join(__dirname, 'data', 'jobs'), locks);

async function handleJobs(req, res, path) {
  if (path === '/api/jobs' && req.method === 'GET') {
    const scope = new URL(req.url, 'http://localhost').searchParams.get('scope') || '';
    return sendJson(res, 200, { jobs: scope ? jobs.list(scope) : [] });
  }
  const m = path.match(/^\/api\/jobs\/([0-9a-f]+)\/(claim|ack|release|cancel)$/);
  if (m && req.method === 'POST') {
    let body;
    try { body = await readJson(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    body = body || {};
    const r = m[2] === 'claim' ? jobs.claim(m[1], String(body.scope || ''))
      : m[2] === 'ack' ? jobs.ack(m[1], String(body.token || ''), body.result)
      : m[2] === 'release' ? jobs.release(m[1], String(body.token || ''))
      : jobs.cancel(m[1], String(body.scope || ''));
    return r.error ? sendJson(res, r.status || 400, { error: r.error }) : sendJson(res, 200, r);
  }
  sendJson(res, 404, { error: 'Not found' });
}

const server = createServer((req, res) => {
  // 通用代理: /api-proxy/<encodeURIComponent(目标URL)>
  if (req.url.startsWith('/api-proxy/')) {
    const encoded = req.url.slice('/api-proxy/'.length);
    try {
      const targetUrl = decodeURIComponent(encoded);
      return proxyRequest(targetUrl, req, res);
    } catch {
      res.writeHead(400);
      return res.end('Bad proxy URL');
    }
  }

  if (req.url.startsWith('/api/frame-check')) {
    const target = new URL(req.url, 'http://localhost').searchParams.get('url') || '';
    return frameCheck(target).then(r => sendJson(res, 200, r), e => sendJson(res, 500, { error: e.message }));
  }

  // 运行时配置：每次请求都重新读 config.json，服务端改完保存即生效，不用重新构建 / 重启
  if (req.url.split('?')[0] === '/api/config') {
    return readFile(join(__dirname, 'config.json'), 'utf8')
      .then(t => JSON.parse(t), () => ({}))
      .then(cfg => sendJson(res, 200, cfg), () => sendJson(res, 200, {}));
  }

  if (req.url.startsWith('/api/jobs')) {
    return handleJobs(req, res, req.url.split('?')[0]).catch((e) => { if (!res.headersSent) sendJson(res, 500, { error: e.message }); });
  }

  if (req.url.startsWith('/api/functions')) {
    return handleFunctions(req, res, req.url.split('?')[0]).catch((e) => { if (!res.headersSent) sendJson(res, 500, { error: e.message }); });
  }

  // 静态文件
  let cleanPath;
  try { cleanPath = decodeURIComponent(req.url.split('?')[0].split('#')[0]); }
  catch { res.writeHead(400); return res.end('Bad URL'); }
  let filePath = join(ROOT, cleanPath === '/' ? 'index.html' : cleanPath);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + sep)) filePath = join(ROOT, 'index.html');

  sendStatic(req, res, filePath).catch(() => {
    sendStatic(req, res, join(ROOT, 'index.html')).catch(() => {
      if (!res.headersSent) res.writeHead(404);
      res.end('Not Found');
    });
  });
});

// 先把落盘的异步任务读进来再开始监听（Node 14 的 ES 模块不能用顶层 await）
jobs.init().catch((e) => console.error('[jobs] 初始化失败，异步任务不可用:', e.message)).then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${PORT}/`);
  });
});
