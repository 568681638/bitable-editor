// ── 类型定义 ──────────────────────────────────────
export interface FieldMeta {
  id: string;
  name: string;
  type: number;
  isPrimary?: boolean;
}

export interface FieldOption {
  id: string;
  name: string;
  color?: number;
}

export interface RecordData {
  recordId: string;
  fields: Record<string, any>;
}

// ── 飞书字段类型常量 ─────────────────────────────
export const FType: Record<string, number> = {
  TEXT: 1, NUMBER: 2, SINGLE_SELECT: 3, MULTI_SELECT: 4,
  DATE_TIME: 5, CHECKBOX: 7, USER: 11, PHONE: 13,
  URL: 15, ATTACHMENT: 17, SINGLE_LINK: 18, FORMULA: 20,
  DUPLEX_LINK: 21, LOCATION: 22, GROUP_CHAT: 23, OBJECT: 25,
  EMAIL: 99005, AUTO_NUMBER: 1005, PROGRESS: 99002,
  CURRENCY: 99003, RATING: 99004,
};

// ── 清理URL中的反引号和前后空格 ──────────────────
export function cleanUrl(raw: string): string {
  return raw.replace(/`/g, '').trim();
}

// ── IOpenSegment[] → 纯文本（保留换行） ───────────
export function segmentsToText(value: any): string {
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
export function findUrlInSegments(value: any): string | null {
  if (!Array.isArray(value)) return null;
  for (const seg of value) {
    if (seg && seg.type === 'url' && (seg.link || seg.text)) {
      return cleanUrl(seg.link || seg.text);
    }
  }
  return null;
}

// ── 提取 URL（通用） ──────────────────────────────
export function extractUrlFromValue(value: any): string {
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
export function hasNewlines(value: any): boolean {
  const text = Array.isArray(value) ? segmentsToText(value) : String(value || '');
  return text.trimEnd().includes('\n');
}

export function isUrl(value: string): boolean {
  return /^https?:\/\/[^\s]+$/.test(value);
}

export function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// ── 从搜索页URL中提取真实图片链接 ─────────────────
export function resolveImageUrl(url: string): string {
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

export type UrlType = 'video' | 'image' | 'audio' | 'webpage';

export function detectUrlType(url: string): UrlType {
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

// ── 内网域名必须走代理；其他域名先直连，失败后自动回退到代理 ──
const PROXY_DOMAINS = [
  'oss-cn-shenzhen-internal.aliyuncs.com',
];

function needsProxy(url: string): boolean {
  return PROXY_DOMAINS.some(d => url.includes(d));
}

export function toProxy(url: string): string {
  return 'api-proxy/' + encodeURIComponent(url);
}

export function proxyUrl(url: string): string {
  if (/^https?:\/\//.test(url) && needsProxy(url)) return toProxy(url);
  return url;
}

// 媒体直连失败（网络不通 / 混合内容 / CORS / PNA 等）时，自动改走服务器代理重试一次
export function installProxyFallback() {
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
}

// ── 会执行破框代码的域名（不渲染 iframe，只展示链接） ──
const FRAMEBUSTER_DOMAINS = [
  'tte.zytintra.com',
];

export function isFramebuster(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return FRAMEBUSTER_DOMAINS.some(d => hostname.includes(d));
  } catch { return false; }
}

export function renderUrlPreview(url: string, type: string): string {
  const src = esc(proxyUrl(url));
  const fallbackLink = `<a href="${src}" target="_blank" rel="noopener noreferrer">${src}</a>`;
  switch (type) {
    case 'video': return `<video controls style="width:100%;"><source src="${src}" type="video/mp4">${fallbackLink}</video>`;
    case 'image': {
      const imgSrc = esc(resolveImageUrl(proxyUrl(url)));
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
