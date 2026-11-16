// 使用教程的链接（☰ 菜单里的“使用教程”和双栏面板的空状态引导都用它）。
// 这里是内置默认值；服务端 release/server/config.json 的 helpUrl 会在运行时覆盖它（见 loadConfig），改那个文件即可，不用重新构建
export let HELP_URL = 'https://zyt.feishu.cn/wiki/BcnjwJ86BiTQJokiwHXcvi3Gnwd';

// 从服务端取运行时配置；取不到（比如纯静态托管、服务没起）就保持默认值
export async function loadConfig(): Promise<void> {
  try {
    const res = await fetch('/api/config', { cache: 'no-store' });
    if (!res.ok) return;
    const cfg = await res.json();
    if (typeof cfg.helpUrl === 'string' && /^https?:\/\//i.test(cfg.helpUrl)) HELP_URL = cfg.helpUrl;
  } catch { /* 用默认值 */ }
}

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

// 媒体直连失败（网络不通 / 混合内容 / CORS / PNA 等）时，自动改走服务器代理重试一次；
// 走了代理还是失败，说明这个预览显示不出来，把编辑区里对应的渲染区整块移除，不占位置
export function installProxyFallback() {
  document.addEventListener('error', (e) => {
    const el = e.target as HTMLElement | null;
    if (!el || !['IMG', 'VIDEO', 'AUDIO', 'SOURCE'].includes(el.tagName)) return;
    const raw = el.getAttribute('src');
    if (!raw) return;
    const alreadyProxied = !!el.dataset.proxied || raw.indexOf('api-proxy/') === 0;
    if (!alreadyProxied && /^https?:\/\//i.test(raw)) {
      el.dataset.proxied = '1';
      el.setAttribute('src', toProxy(raw));
      const media = el.tagName === 'SOURCE' ? el.parentElement as HTMLMediaElement | null : null;
      if (media && typeof media.load === 'function') media.load();
      e.stopPropagation();
      return;
    }
    const kind = el.tagName === 'IMG' ? '图片' : (el.closest('audio') ? '音频' : '视频');
    showPreviewNote(el, `${kind}加载失败，无法预览`, `直连和服务端中转都没能加载这个${kind}：${raw}`);
  }, true);
}

// 预览显示不出来时：移除渲染区，并在字段块的右上角（标题行右侧）写一句说明，让用户知道怎么回事。
// from 可以是渲染区里的任意元素，也可以是占位元素；找不到字段块或渲染区已经被移除时什么都不做
export function showPreviewNote(from: Element, text: string, title = '') {
  const box = from.closest('.url-preview') || from;
  const row = box.closest('.field-row');
  if (!row || !box.isConnected) return;
  box.remove();
  const label = row.querySelector('.field-label');
  if (!label) return;
  label.querySelector('.preview-note')?.remove();
  const note = document.createElement('span');
  note.className = 'preview-note';
  note.textContent = text;
  if (title) note.title = title;
  label.appendChild(note);
}

// ── 会执行破框代码的域名（不渲染 iframe，只展示链接） ──
const FRAMEBUSTER_DOMAINS = [
  'tte.zytintra.com', // 嵌入后会反复触发登录重载（实测），不渲染
];

export function isFramebuster(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return FRAMEBUSTER_DOMAINS.some(d => hostname.includes(d));
  } catch { return false; }
}

// 网页预览：向服务端询问这个网页是否禁止被嵌入（X-Frame-Options / CSP frame-ancestors）。
// 确定禁止的 ok 为 false；查不出来（服务端连不上、没有这个接口）按“可以嵌入”处理，不影响原有行为。
// 结果按地址缓存在内存里；刷新时调用 clearEmbeddableCache 重新查
const embeddableCache = new Map<string, Promise<{ ok: boolean; reason: string }>>();
export function checkEmbeddable(url: string): Promise<{ ok: boolean; reason: string }> {
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
export const clearEmbeddableCache = () => embeddableCache.clear();

// ── 视频 / 音频播放器：仿照原生（Chrome）控制条的样子自绘一套，区别只有在播放键旁边多了「上一帧 / 下一帧」 ──
// 原生控制条没法往里加按钮，所以去掉原生 controls、自己画：播放键 / 上一帧 / 下一帧 / 时间 / 音量 / 全屏，下面一行进度条。
// 单帧时长优先用 requestVideoFrameCallback 取到的真实帧间隔（取最小的，丢帧只会让间隔偏大），取不到（音频、旧浏览器）按 1/30 秒；音频没有帧，同样按这个步长微调。
// 点击用事件委托，渲染区被整块替换（换记录、换地址）后不用重新绑定；调用一次 installMediaStep 即可。样式见 annotator.scss 的 .media-wrap
const DEFAULT_FRAME = 1 / 30;
const MI = {
  play: 'M8 5v14l11-7z',
  pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
  prev: 'M6 6h2v12H6zm3.5 6l8.5 6V6z',
  next: 'M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z',
  vol: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
  mute: 'M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z',
  fs: 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z',
  more: 'M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',
  fsExit: 'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z',
};
const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
const mIcon = (d: string) => `<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="${d}"/></svg>`;

// kind：'video' | 'audio'；src 已转义
export function mediaWithStep(kind: 'video' | 'audio', src: string, mediaClass = ''): string {
  const video = kind === 'video';
  const cls = mediaClass ? ` class="${mediaClass}"` : '';
  const tag = video ? `<video playsinline src="${src}"${cls}></video>` : `<audio src="${src}"${cls}></audio>`;
  return `<div class="media-wrap paused ${video ? 'is-video' : 'is-audio'}">${tag}<div class="media-bar" data-media-bar>`
    + `<div class="media-row">`
    + `<button type="button" data-do="play" title="播放 / 暂停">${mIcon(MI.play)}</button>`
    + `<button type="button" data-do="prev" title="上一帧（暂停并后退一帧）">${mIcon(MI.prev)}</button>`
    + `<button type="button" data-do="next" title="下一帧（暂停并前进一帧）">${mIcon(MI.next)}</button>`
    + `<span class="media-time" data-time>0:00 / 0:00</span><span class="media-gap"></span>`
    + `<span class="media-vol"><button type="button" data-do="mute" title="静音 / 取消静音">${mIcon(MI.vol)}</button><input type="range" class="media-volume" min="0" max="1" step="0.05" value="1" data-vol title="音量"></span>`
    + (video ? `<button type="button" class="media-fs" data-do="fs" title="全屏 / 退出全屏">${mIcon(MI.fs)}</button>` : '')
    // ⋮ 菜单：倍速、画中画（只有视频）、下载，和原生一样
    + `<span class="media-more"><button type="button" data-do="more" title="更多">${mIcon(MI.more)}</button><div class="media-menu" data-menu hidden>`
    + `<div class="media-rates" title="播放速度">${RATES.map(r => `<button type="button" data-rate="${r}">${r === 1 ? '正常' : r + 'x'}</button>`).join('')}</div>`
    + (video ? `<button type="button" class="media-menu-item" data-do="pip">画中画</button>` : '')
    + `<button type="button" class="media-menu-item" data-do="download">下载</button></div></span>`
    + `</div><input type="range" class="media-seek" min="0" max="1000" step="1" value="0" data-seek title="进度"></div></div>`;
}

export function installMediaStep() {
  const isMedia = (el: unknown): el is HTMLMediaElement => el instanceof HTMLVideoElement || el instanceof HTMLAudioElement;
  const mediaOf = (el: Element) => el.closest('.media-wrap')?.querySelector<HTMLMediaElement>('video, audio') || null;
  const frameOf = (m: HTMLMediaElement) => Number(m.dataset.frame) || DEFAULT_FRAME;
  const clock = (t: number) => {
    if (!isFinite(t) || t < 0) t = 0;
    const h = Math.floor(t / 3600), mi = Math.floor(t / 60) % 60, sec = Math.floor(t % 60);
    return (h ? h + ':' + (mi < 10 ? '0' : '') : '') + mi + ':' + (sec < 10 ? '0' : '') + sec;
  };
  const setIcon = (el: Element | null, d: string) => { if (el) el.innerHTML = mIcon(d); };
  const toggleFs = (wrap: HTMLElement) => { if (document.fullscreenElement === wrap) void document.exitFullscreen(); else void wrap.requestFullscreen?.(); };

  // 把控制条同步成媒体当前的状态：播放键图标、进度条、时间、音量
  function sync(m: HTMLMediaElement) {
    const wrap = m.closest<HTMLElement>('.media-wrap');
    const bar = wrap?.querySelector<HTMLElement>('[data-media-bar]');
    if (!wrap || !bar) return;
    wrap.classList.toggle('paused', m.paused);
    setIcon(bar.querySelector('[data-do="play"]'), m.paused ? MI.play : MI.pause);
    setIcon(bar.querySelector('[data-do="mute"]'), m.muted || m.volume === 0 ? MI.mute : MI.vol);
    const vol = bar.querySelector<HTMLInputElement>('[data-vol]')!;
    if (!vol.matches(':active')) { vol.value = String(m.muted ? 0 : m.volume); vol.style.setProperty('--p', Number(vol.value) * 100 + '%'); }
    const seek = bar.querySelector<HTMLInputElement>('[data-seek]')!;
    if (!seek.matches(':active') && isFinite(m.duration) && m.duration > 0) {
      seek.value = String(Math.round(m.currentTime / m.duration * 1000));
      seek.style.setProperty('--p', m.currentTime / m.duration * 100 + '%');
    }
    bar.querySelector('[data-time]')!.textContent = clock(m.currentTime) + ' / ' + clock(m.duration);
    bar.querySelectorAll<HTMLElement>('[data-rate]').forEach(b => b.classList.toggle('on', Number(b.dataset.rate) === m.playbackRate));
    const pip = bar.querySelector<HTMLElement>('[data-do="pip"]');
    if (pip) pip.hidden = !(document as any).pictureInPictureEnabled;
    setIcon(bar.querySelector('[data-do="fs"]'), document.fullscreenElement === wrap ? MI.fsExit : MI.fs);
  }

  // 视频出第一帧后开始跟踪：记下当前画面的真实时间戳，并用相邻两帧的间隔估计单帧时长
  function track(v: HTMLVideoElement) {
    if (v.dataset.tracking || typeof v.requestVideoFrameCallback !== 'function') return;
    v.dataset.tracking = '1';
    let last = -1;
    const onFrame = (_now: number, meta: { mediaTime: number }) => {
      const t = meta.mediaTime;
      v.dataset.mt = String(t);
      const d = last >= 0 ? Math.abs(t - last) : 0;
      if (d > 1 / 240 && d < 0.2) v.dataset.frame = String(Math.min(Number(v.dataset.frame) || Infinity, d));
      last = t;
      v.requestVideoFrameCallback(onFrame);
    };
    v.requestVideoFrameCallback(onFrame);
  }

  function step(m: HTMLMediaElement, dir: number) {
    m.pause();
    const fd = frameOf(m);
    const shown = m instanceof HTMLVideoElement && m.dataset.mt !== undefined ? Number(m.dataset.mt) : Math.round(m.currentTime / fd) * fd;
    // 落在目标帧的前 1/4 处：正好踩在时间戳上会因浮点误差显示成相邻的那一帧
    const target = shown + dir * fd + fd * 0.25;
    m.currentTime = Math.min(Math.max(target, 0), isFinite(m.duration) ? m.duration : target);
  }
  const toggle = (m: HTMLMediaElement) => { if (m.paused) void m.play().catch(() => {}); else m.pause(); };

  // ⋮ 菜单开着时控制条保持显示；点别处关闭
  const closeMenus = (except?: Element | null) => document.querySelectorAll<HTMLElement>('.media-wrap').forEach(w => {
    if (w === except) return;
    const menu = w.querySelector<HTMLElement>('[data-menu]');
    if (menu) menu.hidden = true;
    w.classList.remove('menu-open');
  });
  document.addEventListener('click', (e) => {
    const t = e.target as HTMLElement | null;
    if (!t) return;
    // 点菜单本身 / ⋮ 按钮以外的任何地方（包括视频画面）都先把菜单关掉；点 ⋮ 的开关在下面单独处理
    if (!t.closest('[data-menu]') && !t.closest('[data-do="more"]')) closeMenus();
    const btn = t.closest<HTMLElement>('[data-media-bar] button');
    if (btn) {
      const m = mediaOf(btn);
      if (!m) return;
      if (btn.dataset.rate) { m.playbackRate = Number(btn.dataset.rate); sync(m); closeMenus(); return; }
      const act = btn.dataset.do;
      if (act === 'more') {
        const wrap = btn.closest<HTMLElement>('.media-wrap')!;
        const menu = wrap.querySelector<HTMLElement>('[data-menu]')!;
        closeMenus(wrap); // 别的播放器开着的菜单关掉
        menu.hidden = !menu.hidden;
        wrap.classList.toggle('menu-open', !menu.hidden);
        return;
      }
      if (act === 'pip') { void (m as HTMLVideoElement).requestPictureInPicture?.().catch(() => {}); closeMenus(); return; }
      if (act === 'download') {
        const a = document.createElement('a');
        a.href = m.currentSrc || m.src; a.download = ''; a.target = '_blank'; a.rel = 'noopener';
        document.body.appendChild(a); a.click(); a.remove();
        closeMenus();
        return;
      }
      if (act === 'play') toggle(m);
      else if (act === 'prev') step(m, -1);
      else if (act === 'next') step(m, 1);
      else if (act === 'mute') { m.muted = !m.muted; if (!m.muted && m.volume === 0) m.volume = 1; }
      else if (act === 'fs') toggleFs(btn.closest<HTMLElement>('.media-wrap')!);
      return;
    }
    if (isMedia(t) && t.closest('.media-wrap')) toggle(t); // 点画面本身播放 / 暂停
  });
  document.addEventListener('dblclick', (e) => { // 双击画面全屏，和原生一样
    const t = e.target;
    if (t instanceof HTMLVideoElement && t.closest('.media-wrap')) toggleFs(t.closest<HTMLElement>('.media-wrap')!);
  });
  document.addEventListener('input', (e) => {
    const r = e.target as HTMLInputElement | null;
    if (!r || !r.hasAttribute) return;
    const m = mediaOf(r);
    if (!m) return;
    if (r.hasAttribute('data-seek') && isFinite(m.duration)) { m.currentTime = Number(r.value) / 1000 * m.duration; r.style.setProperty('--p', Number(r.value) / 10 + '%'); sync(m); }
    else if (r.hasAttribute('data-vol')) { m.muted = false; m.volume = Number(r.value); }
  });
  // 倍速记在本地：切到下一条记录会换一个新的播放器，开始加载时套用上次选的倍速（用户在 ⋮ 菜单里改了就更新）
  const RATE_KEY = 'annotator-media-rate';
  let savedRate = 1;
  try { const r = Number(localStorage.getItem(RATE_KEY)); if (r > 0) savedRate = r; } catch { /* ignore */ }
  document.addEventListener('loadstart', (e) => {
    if (!isMedia(e.target) || !e.target.closest('.media-wrap')) return;
    e.target.defaultPlaybackRate = savedRate;
    e.target.playbackRate = savedRate;
  }, true);
  document.addEventListener('ratechange', (e) => {
    if (!isMedia(e.target) || !e.target.closest('.media-wrap') || e.target.playbackRate === savedRate) return;
    savedRate = e.target.playbackRate;
    try { localStorage.setItem(RATE_KEY, String(savedRate)); } catch { /* ignore */ }
  }, true);
  // 媒体事件不冒泡，在捕获阶段接
  for (const ev of ['play', 'pause', 'ended', 'timeupdate', 'seeked', 'loadedmetadata', 'durationchange', 'volumechange', 'ratechange']) {
    document.addEventListener(ev, (e) => { if (isMedia(e.target)) sync(e.target); }, true);
  }
  document.addEventListener('loadeddata', (e) => { if (e.target instanceof HTMLVideoElement) track(e.target); }, true);
  document.addEventListener('fullscreenchange', () => document.querySelectorAll<HTMLMediaElement>('.media-wrap video, .media-wrap audio').forEach(sync));
}

// 编辑区字段下方的预览。显示不出来的情况（走代理也加载失败、网页禁止嵌入）不留任何占位：
// 图片 / 视频 / 音频加载失败时，由 installProxyFallback 把整个渲染区移除；网页由 annotator-ui 先检查能否嵌入。
export function renderUrlPreview(url: string, type: string): string {
  const src = esc(proxyUrl(url));
  switch (type) {
    case 'video': return mediaWithStep('video', src);
    case 'image': return `<img src="${esc(resolveImageUrl(proxyUrl(url)))}" alt="预览" style="width:100%;object-fit:contain;" />`;
    case 'audio': return mediaWithStep('audio', src);
    case 'webpage':
      if (isFramebuster(url)) return '';
      return `<iframe src="${src}" style="width:100%;aspect-ratio:16/9;border:1px solid #ddd;border-radius:4px;" sandbox="allow-scripts allow-same-origin allow-popups"></iframe>`;
    default: return '';
  }
}
