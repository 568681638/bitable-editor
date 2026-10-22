import http, { createServer } from 'http';
import { lookup as dnsLookup } from 'dns';
import { isIP } from 'net';
import { readFile } from 'fs/promises';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import { URL } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DIST = join(__dirname, 'dist');
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

  // 静态文件
  const cleanPath = req.url.split('?')[0].split('#')[0];
  const filePath = join(DIST, cleanPath === '/' ? 'index.html' : cleanPath);

  readFile(filePath)
    .then(data => {
      const ext = extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    })
    .catch(() => {
      readFile(join(DIST, 'index.html'))
        .then(data => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(data); })
        .catch(() => { res.writeHead(404); res.end('Not Found'); });
    });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${PORT}/`);
});
