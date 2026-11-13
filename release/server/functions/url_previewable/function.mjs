// 判断链接能不能在预览窗格里正常预览（被 iframe 嵌入加载）：只看响应头，不下载页面，和面板自己的“嵌入检查”同一套规则——
//   X-Frame-Options 是 DENY / SAMEORIGIN / ALLOW-FROM，或 CSP 的 frame-ancestors 里没有 *，就不能嵌入（false）；否则可以（true）。
// 返回布尔值即可：写复选框直接用；写文本字段时面板会转成 "true" / "false"。
// 目标连不上、超时、不是 http(s) 链接时，这一行算失败（没法判断，不猜 true / false）。
// 自包含：不依赖 server.mjs。要兼容 Node 14（不用 ??=、||=、replaceAll、.at()）。
import http from 'http';
import https from 'https';
import { lookup as dnsLookup } from 'dns';
import { isIP } from 'net';

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 5000;
const WORKERS = 20; // 同时检查的链接数

// 内网段有意放行（预览要访问的就是浏览器够不到的内网资源）；只拦回环、链路本地（云元数据）、未指定 / 组播 / 保留地址，防止借这个函数打本机服务
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

function safeLookup(hostname, options, cb) {
  dnsLookup(hostname, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = addrs.filter(a => !isBlockedIP(a.address));
    if (!list.length) return cb(new Error('目标地址不允许访问'));
    if (options && options.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

function judge(headers) {
  const xfo = String(headers['x-frame-options'] || '').toLowerCase();
  if (xfo.includes('deny') || xfo.includes('sameorigin') || xfo.includes('allow-from')) return { ok: false, why: 'X-Frame-Options: ' + xfo };
  const m = String(headers['content-security-policy'] || '').match(/frame-ancestors([^;]*)/i);
  if (m && m[1].split(/\s+/).indexOf('*') < 0) return { ok: false, why: 'CSP frame-ancestors:' + m[1] };
  return { ok: true, why: '没有嵌入限制' };
}

// 返回 { ok, why }；没法判断（连不上等）时 reject
function check(targetUrl, redirects) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(targetUrl); } catch (e) { return reject(new Error('不是合法链接')); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return reject(new Error('只支持 http / https 链接'));
    const bare = parsed.hostname.replace(/^\[|\]$/g, '');
    if (isIP(bare) && isBlockedIP(bare)) return reject(new Error('目标地址不允许访问'));
    const req = (parsed.protocol === 'https:' ? https : http).request({
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { host: parsed.host, 'user-agent': 'Mozilla/5.0 data-engine-frame-check', accept: 'text/html' },
      lookup: safeLookup,
    }, (res) => {
      res.destroy(); // 只要响应头，不读内容
      if ([301, 302, 303, 307, 308].indexOf(res.statusCode) >= 0 && res.headers.location) {
        if (redirects >= MAX_REDIRECTS) return reject(new Error('重定向次数过多'));
        let next;
        try { next = new URL(res.headers.location, parsed).href; } catch (e) { return reject(new Error('重定向地址不合法')); }
        return resolve(check(next, redirects + 1));
      }
      resolve(judge(res.headers));
    });
    req.on('error', (err) => reject(new Error('无法访问：' + err.message)));
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(); reject(new Error('访问超时')); });
    req.end();
  });
}

export default {
  id: 'url_previewable',
  name: '链接能否预览',
  inputs: [{ name: 'url', label: '链接' }],
  outputs: [
    { name: 'previewable', label: '可预览' }, // 布尔值 true / false
    { name: 'reason', label: '判断依据', type: 'detail' },
  ],
  batchSize: 100,
  async run(rows) {
    const results = new Array(rows.length);
    let next = 0;
    const worker = async () => {
      while (next < rows.length) {
        const i = next++;
        const url = String(rows[i].url == null ? '' : rows[i].url).trim();
        if (!url) { results[i] = new Error('链接为空'); continue; }
        try {
          const r = await check(url, 0);
          results[i] = { previewable: r.ok, reason: r.why };
        } catch (e) { results[i] = new Error(e.message); } // 连不上 / 超时：这一行失败，不猜结果
      }
    };
    await Promise.all(Array.from({ length: Math.min(WORKERS, rows.length) }, worker));
    return results;
  },
};
