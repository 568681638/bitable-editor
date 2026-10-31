// 多行文本框的两项共用能力：随内容撑开高度、分两步的 Ctrl+A

// 默认高度上限：窗口高度的比例（右侧标注栏）。超出后文本框内部滚动。左侧渲染块的标题栏要给渲染区让位，调用时传更小的比例
const MAX_HEIGHT_RATIO = 0.5;

// 按内容（包括折行）撑开高度：没有换行时与单行输入框一样高（rows=1），最大不超过窗口高度的 maxRatio。
// 不可见（隐藏的字段）时量不出高度，直接跳过，等变可见后再调用
export function autosizeTextarea(ta: HTMLTextAreaElement, maxRatio = MAX_HEIGHT_RATIO) {
  if (ta.dataset.manual === '1') return; // 用户手动拖拽过高度，不再自动调整
  if (!ta.offsetHeight) return;
  // 值里没有换行时是“单行状态”：外观与单行输入框一致（不出滚动条、不显示拖拽角），见样式 .single-line
  ta.classList.toggle('single-line', !ta.value.includes('\n'));
  ta.style.height = 'auto';
  const extra = ta.offsetHeight - ta.clientHeight; // 边框 + 横向滚动条的厚度
  // 页面可能被缩放（面板页右栏有 zoom）：屏幕像素 / CSS 像素，上限要按屏幕像素算
  const scale = ta.getBoundingClientRect().height / ta.offsetHeight || 1;
  const cap = Math.floor((window.innerHeight * maxRatio) / scale);
  const height = Math.min(ta.scrollHeight + extra, cap);
  ta.style.height = height + 'px';
  ta.dataset.autoHeight = String(height);
}

// 用户拖拽文本框右下角调整过高度后，不再自动撑开，避免把手动调整的结果覆盖掉
export function trackManualResize(ta: HTMLTextAreaElement) {
  ta.addEventListener('mouseup', () => {
    if (Math.abs(ta.offsetHeight - Number(ta.dataset.autoHeight)) > 1) ta.dataset.manual = '1';
  });
}

// Ctrl+A 分两步（类似飞书文档）：第一次只选中光标所在的那一行，
// 这一行已经被整行选中时，再按一次才选中全文。
// 单行文本、空行、选区已经跨行时，都直接走浏览器默认的全选
export function installLineSelectAll(ta: HTMLTextAreaElement) {
  ta.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'a') return;
    const value = ta.value;
    if (!value.includes('\n')) return;
    const start = ta.selectionStart, end = ta.selectionEnd;
    const lineStart = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1;
    let lineEnd = value.indexOf('\n', start);
    if (lineEnd === -1) lineEnd = value.length;
    const withinOneLine = end <= lineEnd;
    const lineSelected = start === lineStart && end === lineEnd;
    if (!withinOneLine || lineSelected || lineStart === lineEnd) return;
    e.preventDefault();
    ta.setSelectionRange(lineStart, lineEnd);
  });
}
