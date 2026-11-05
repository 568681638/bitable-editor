import http, { createServer } from 'http';
import { lookup as dnsLookup } from 'dns';
import { isIP } from 'net';
import { readFile, stat } from 'fs/promises';
import { gzip, brotliCompress, constants as zlibConstants } from 'zlib';
import { promisify } from 'util';
import { join, extname, sep } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import { URL } from 'url';
import { readdir, mkdtemp, writeFile, unlink, rmdir } from 'fs/promises';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import { pathToFileURL } from 'url';

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
      headers: { host: parsed.host, 'user-agent': 'Mozilla/5.0 bitable-editor-frame-check', accept: 'text/html' },
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

// ── 函数注册表：热加载 functions/*.mjs 和 functions/*.py ─────────────
// 每次请求都扫一遍目录，新增/修改/删除文件立即生效，不用重启服务。
// 以 _ 开头的文件被忽略；某个文件加载失败只在日志里报错，不影响其他函数。
const FUNCTIONS_DIR = join(__dirname, 'functions');
const fnFileCache = new Map(); // 文件名 → { mtimeMs, defs }

function validDef(d) {
  const okParams = (list) => Array.isArray(list) && list.every(p => p && typeof p.name === 'string' && p.name);
  return d && typeof d.id === 'string' && d.id && typeof d.name === 'string' && typeof d.run === 'function'
    && okParams(d.inputs) && okParams(d.outputs);
}

// ── Python 函数：由 functions/_python_executor.py 加载 .py 并执行，一批行启动一次进程 ──
// 数据经临时目录里的 JSON 文件传递（不走命令行参数和管道），数据量不受限制
const PYTHON_BIN = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
const PY_EXECUTOR = join(FUNCTIONS_DIR, '_python_executor.py');
const PY_META_TIMEOUT = 15000;
const PY_RUN_TIMEOUT = Number(process.env.PY_RUN_TIMEOUT_MS) || 300000; // 单批执行的超时，可用环境变量调大

async function runPython(file, mode, input, timeoutMs) {
  const dir = await mkdtemp(join(tmpdir(), 'autoflush-'));
  const inPath = join(dir, 'in.json');
  const outPath = join(dir, 'out.json');
  try {
    await writeFile(inPath, JSON.stringify(input === undefined ? {} : input), 'utf8');
    await new Promise((resolve, reject) => {
      const child = spawn(PYTHON_BIN, [PY_EXECUTOR, file, mode, inPath, outPath], { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
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

async function loadPyDef(full) {
  const meta = await runPython(full, 'meta', undefined, PY_META_TIMEOUT);
  return [{
    id: meta.id, name: meta.name, inputs: meta.inputs, outputs: meta.outputs,
    // 与 JS 函数同形：返回与 rows 等长的数组，失败的行是 Error
    async run(rows) {
      const data = await runPython(full, 'run', { rows }, PY_RUN_TIMEOUT);
      if (!data || !Array.isArray(data.results)) throw new Error('Python 返回格式不对');
      return data.results.map(r => (r.ok ? r.outputs : new Error(r.error)));
    },
  }].filter(validDef);
}

async function loadFunctions() {
  let files = [];
  try { files = (await readdir(FUNCTIONS_DIR)).filter(f => (f.endsWith('.mjs') || f.endsWith('.py')) && !f.startsWith('_')).sort(); }
  catch (e) { console.error('[functions] 读取目录失败:', e.message); }
  const seen = new Set(files);
  for (const name of fnFileCache.keys()) if (!seen.has(name)) fnFileCache.delete(name);

  const all = [];
  const ids = new Set();
  for (const file of files) {
    const full = join(FUNCTIONS_DIR, file);
    try {
      const st = await stat(full);
      let entry = fnFileCache.get(file);
      if (!entry || entry.mtimeMs !== st.mtimeMs) {
        // 带上 mtime 做查询串，绕开 Node 的模块缓存，重新加载改过的文件
        let defs;
        if (file.endsWith('.py')) {
          defs = await loadPyDef(full);
        } else {
          const mod = await import(pathToFileURL(full).href + '?v=' + st.mtimeMs);
          defs = (Array.isArray(mod.default) ? mod.default : [mod.default]).filter(validDef);
        }
        entry = { mtimeMs: st.mtimeMs, defs };
        fnFileCache.set(file, entry);
        console.log('[functions] 已加载 ' + file + '：' + (defs.map(d => d.id).join(', ') || '（没有有效的函数定义）'));
      }
      for (const d of entry.defs) {
        if (ids.has(d.id)) { console.error('[functions] 函数 id 重复，忽略 ' + file + ' 里的 ' + d.id); continue; }
        ids.add(d.id);
        all.push(d);
      }
    } catch (e) {
      // 失败的文件不缓存 mtime，下次请求会重试；同时保留它上一次加载成功的版本
      console.error('[functions] 加载 ' + file + ' 失败:', e.message);
      const old = fnFileCache.get(file);
      if (old) for (const d of old.defs) if (!ids.has(d.id)) { ids.add(d.id); all.push(d); }
    }
  }
  return all;
}

// ── 批处理函数接口 ──────────────────────────────
// GET  /api/functions          → [{ id, name, inputs, outputs }]
// POST /api/functions/<id>/run  body { rows: [{...入参}] } → { results: [{ ok: true, outputs } | { ok: false, error }] }
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
    return sendJson(res, 200, FUNCTIONS.map(({ id, name, inputs, outputs }) => ({ id, name, inputs, outputs })));
  }
  const m = path.match(/^\/api\/functions\/([^/]+)\/run$/);
  if (m && req.method === 'POST') {
    const fn = (await loadFunctions()).find(f => f.id === decodeURIComponent(m[1]));
    if (!fn) return sendJson(res, 404, { error: 'Unknown function' });
    let body;
    try { body = await readJson(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    if (!body || !Array.isArray(body.rows)) return sendJson(res, 400, { error: 'rows is required' });
    // 批量计算：函数一次拿到全部 rows，返回与 rows 等长的数组；Error 项表示该行失败
    let outs;
    try { outs = await fn.run(body.rows.map(r => r || {})); }
    catch (e) { return sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) }); }
    if (!Array.isArray(outs) || outs.length !== body.rows.length) {
      return sendJson(res, 500, { error: '函数 ' + fn.id + ' 必须返回与 rows 等长的数组（收到 ' + body.rows.length + ' 行，返回 ' + (Array.isArray(outs) ? outs.length : typeof outs) + '）' });
    }
    const results = outs.map(o => (o instanceof Error ? { ok: false, error: o.message } : { ok: true, outputs: o || {} }));
    return sendJson(res, 200, { results });
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${PORT}/`);
});
