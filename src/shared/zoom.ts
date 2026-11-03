// 侧边栏字号缩放：把 --ann-zoom 写到 target 上，样式按它整体缩放；档位记在 localStorage。
// 界面上显示的百分比是相对 base（默认的实际缩放）的：默认永远显示 100%。
// localStorage 里存的是实际缩放值（base × 百分比），以后调整 base 不会让已经调过的人突然变样
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 1.2;
const STEP = 0.05;
const pct = (z: number) => `${Math.round(z * 100)}%`;

export function setupZoom(target: HTMLElement, storageKey: string, base: number) {
  const outBtn = document.getElementById('zoomOutBtn')!;
  const inBtn = document.getElementById('zoomInBtn')!;
  const saved = parseFloat(localStorage.getItem(storageKey) || '');
  let zoom = saved > 0 ? Math.round(saved / base * 100) / 100 : 1; // 相对 base 的倍数

  // 鼠标悬停提示：当前缩放百分比和上下限；到了上下限会说明不能再调了
  function updateTitles() {
    const range = `当前 ${pct(zoom)}（范围 ${pct(MIN_ZOOM)} ~ ${pct(MAX_ZOOM)}）`;
    outBtn.title = zoom <= MIN_ZOOM + 1e-9 ? `缩小侧边栏字号：已到下限。${range}` : `缩小侧边栏字号。${range}`;
    inBtn.title = zoom >= MAX_ZOOM - 1e-9 ? `放大侧边栏字号：已到上限。${range}` : `放大侧边栏字号。${range}`;
  }

  // persist：只有用户点按钮调整时才记下来；初始化时不写，这样以后改默认值，没手动调过的人能直接生效
  function setZoom(z: number, persist = true) {
    zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 100) / 100));
    const actual = Math.round(base * zoom * 10000) / 10000;
    target.style.setProperty('--ann-zoom', String(actual));
    if (persist) localStorage.setItem(storageKey, String(actual));
    updateTitles();
  }

  setZoom(zoom, false);
  outBtn.addEventListener('click', () => setZoom(zoom - STEP));
  inBtn.addEventListener('click', () => setZoom(zoom + STEP));
}
