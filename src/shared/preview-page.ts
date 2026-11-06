// 筛选结果预览的“整页”版本：生成一份自带样式和脚本的 HTML，在新标签页里打开，能用上整个浏览器窗口。
// 功能：表头固定、拖动表头右边缘调整列宽、点击表头按列排序、虚拟滚动（几万行也不卡）、导出 CSV；顶部「数据 | 统计」切换，统计页见 stats-view.ts。
// 页面里只用 textContent 写入单元格内容，数据不会被当成 HTML 执行。
//
// 注意：下面嵌入的页面脚本写在模板字符串里，所以脚本里不能出现反引号和 ${，也尽量不用反斜杠转义。

import { renderStatsView } from './stats-view';

const PAGE_CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; font-size: 13px; color: #333; }
  body { display: flex; flex-direction: column; background: #fff; }
  .bar { display: flex; align-items: center; gap: 12px; padding: 8px 14px; background: #fafafa; border-bottom: 1px solid #e8e8e8; flex: none; }
  .bar b { font-size: 14px; }
  .bar .hint { color: #999; font-size: 12px; flex: 1; }
  .bar button { padding: 4px 12px; background: #4f7cff; border: none; border-radius: 4px; color: #fff; cursor: pointer; font-size: 13px; }
  .bar button:hover { background: #3d6ae8; }
  #wrap { flex: 1; overflow: auto; position: relative; }
  table { border-collapse: collapse; table-layout: fixed; }
  th, td { height: 28px; padding: 0 10px; border: 1px solid #eee; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
  thead th { position: sticky; top: 0; z-index: 2; background: #f5f7fa; cursor: pointer; user-select: none; font-weight: 600; }
  thead th:hover { background: #eaeff8; }
  th.idx, td.idx { color: #999; text-align: right; }
  tbody tr:hover td { background: #f0f4ff; }
  .rz { position: absolute; top: 0; right: 0; width: 7px; height: 100%; cursor: col-resize; }
  .rz:hover, .rz.on { background: rgba(79, 124, 255, 0.35); }
  th { position: sticky; }
  .sp td { padding: 0; border: none; }

  .tabs { display: flex; }
  .bar .tabs button { background: #fff; color: #555; border: 1px solid #d9d9d9; border-radius: 0; padding: 4px 14px; }
  .bar .tabs button:first-child { border-radius: 4px 0 0 4px; }
  .bar .tabs button:last-child { border-radius: 0 4px 4px 0; margin-left: -1px; }
  .bar .tabs button:hover { background: #f0f4ff; }
  .bar .tabs button.on { background: #4f7cff; color: #fff; border-color: #4f7cff; }
  #stats { flex: 1; overflow: auto; padding: 16px 20px; display: none; }
  .st-sec { margin-bottom: 28px; }
  .st-sec h3 { font-size: 14px; margin-bottom: 8px; }
  .st-sec .sub { color: #999; font-size: 12px; font-weight: 400; margin-left: 8px; }
  .st-table { border-collapse: collapse; table-layout: auto; }
  .st-table th, .st-table td { height: 30px; padding: 0 12px; border: 1px solid #eee; white-space: nowrap; text-align: left; overflow: visible; }
  .st-table th { background: #f5f7fa; position: static; cursor: default; font-weight: 600; }
  .st-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .st-table td.dim { color: #bbb; text-align: center; }
  .st-table tbody tr { cursor: pointer; }
  .st-table tbody tr:hover td { background: #f0f4ff; }
  .st-table tbody tr.on td { background: #e6eaff; }
  .pbar { display: inline-block; vertical-align: middle; width: 120px; height: 10px; margin-right: 8px; background: #eef0f4; border-radius: 5px; overflow: hidden; }
  .pbar i { display: block; height: 100%; background: #4f7cff; }
  .st-ctl { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
  .st-ctl select { padding: 4px 8px; border: 1px solid #d9d9d9; border-radius: 4px; font-size: 13px; max-width: 280px; }
  .dist-row { display: flex; align-items: center; gap: 10px; height: 26px; }
  .dist-label { flex: none; width: 240px; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dist-label.dim { color: #aaa; }
  .dist-track { flex: 1; max-width: 640px; height: 14px; background: #f3f4f7; border-radius: 3px; overflow: hidden; }
  .dist-track i { display: block; height: 100%; background: #4f7cff; border-radius: 3px; }
  .dist-track i.dim { background: #c9ced8; }
  .dist-num { flex: none; width: 150px; color: #666; font-variant-numeric: tabular-nums; }
  .st-empty { color: #999; padding: 8px 0; }
  .st-sum { color: #666; margin-bottom: 10px; }
`;

const PAGE_SCRIPT = `
(function () {
  var data = JSON.parse(document.getElementById('data').textContent);
  var head = data.rows[0];
  var body = data.rows.slice(1);
  var n = body.length;
  var ROW_H = 28;
  var BUFFER = 12;
  var widths = [56].concat(head.map(function (_, i) { return i === 0 ? 130 : 160; }));
  var order = [];
  for (var i = 0; i < n; i++) order.push(i);
  var sortCol = -1;
  var sortDir = 0;

  var wrap = document.getElementById('wrap');
  var table = document.createElement('table');
  var colgroup = document.createElement('colgroup');
  var thead = document.createElement('thead');
  var tbody = document.createElement('tbody');
  table.appendChild(colgroup);
  table.appendChild(thead);
  table.appendChild(tbody);
  wrap.appendChild(table);

  function applyWidths() {
    var total = 0;
    for (var c = 0; c < widths.length; c++) {
      colgroup.children[c].style.width = widths[c] + 'px';
      total += widths[c];
    }
    table.style.width = total + 'px';
  }

  var ths = [];
  function buildHead() {
    var tr = document.createElement('tr');
    var cols = ['#'].concat(head);
    cols.forEach(function (name, c) {
      colgroup.appendChild(document.createElement('col'));
      var th = document.createElement('th');
      if (c === 0) th.className = 'idx';
      var label = document.createElement('span');
      label.textContent = name;
      th.appendChild(label);
      th.title = name;
      var rz = document.createElement('div');
      rz.className = 'rz';
      th.appendChild(rz);
      rz.addEventListener('click', function (e) { e.stopPropagation(); });
      rz.addEventListener('mousedown', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var startX = e.clientX;
        var startW = widths[c];
        rz.classList.add('on');
        function move(ev) { widths[c] = Math.max(40, startW + ev.clientX - startX); applyWidths(); }
        function up() {
          rz.classList.remove('on');
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
        }
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
      th.addEventListener('click', function () { toggleSort(c); });
      tr.appendChild(th);
      ths.push({ th: th, label: label, name: name });
    });
    thead.appendChild(tr);
    applyWidths();
  }

  function isNum(s) { return s !== '' && s.trim() !== '' && isFinite(Number(s)); }

  function toggleSort(c) {
    if (c === 0) { sortCol = -1; sortDir = 0; }
    else if (sortCol === c) {
      if (sortDir === 1) sortDir = -1;
      else { sortCol = -1; sortDir = 0; }
    } else { sortCol = c; sortDir = 1; }
    for (var i = 0; i < n; i++) order[i] = i;
    if (sortCol > 0) {
      var k = sortCol - 1;
      var dir = sortDir;
      order.sort(function (a, b) {
        var x = body[a][k];
        var y = body[b][k];
        var ex = x === '';
        var ey = y === '';
        if (ex || ey) return ex === ey ? a - b : (ex ? 1 : -1);  // 空值始终排在最后
        var r = isNum(x) && isNum(y) ? Number(x) - Number(y) : x.localeCompare(y, 'zh');
        return r === 0 ? a - b : r * dir;
      });
    }
    ths.forEach(function (h, i) {
      h.label.textContent = h.name + (i === sortCol ? (sortDir === 1 ? ' ▲' : ' ▼') : '');
    });
    wrap.scrollTop = 0;
    render();
  }

  var pending = false;
  function render() {
    pending = false;
    var viewH = wrap.clientHeight;
    var start = Math.max(0, Math.floor(wrap.scrollTop / ROW_H) - BUFFER);
    var end = Math.min(n, Math.ceil((wrap.scrollTop + viewH) / ROW_H) + BUFFER);
    var frag = document.createDocumentFragment();
    function spacer(h) {
      var tr = document.createElement('tr');
      tr.className = 'sp';
      var td = document.createElement('td');
      td.colSpan = widths.length;
      td.style.height = h + 'px';
      tr.appendChild(td);
      return tr;
    }
    frag.appendChild(spacer(start * ROW_H));
    for (var r = start; r < end; r++) {
      var idx = order[r];
      var tr = document.createElement('tr');
      var td0 = document.createElement('td');
      td0.className = 'idx';
      td0.textContent = String(idx + 1);
      tr.appendChild(td0);
      var row = body[idx];
      for (var c = 0; c < row.length; c++) {
        var td = document.createElement('td');
        td.textContent = row[c];
        td.title = row[c];
        tr.appendChild(td);
      }
      frag.appendChild(tr);
    }
    frag.appendChild(spacer((n - end) * ROW_H));
    tbody.innerHTML = '';
    tbody.appendChild(frag);
  }

  wrap.addEventListener('scroll', function () {
    if (!pending) { pending = true; requestAnimationFrame(render); }
  });
  window.addEventListener('resize', render);

  function quote(s) {
    var cr = String.fromCharCode(13);
    var lf = String.fromCharCode(10);
    if (s.indexOf('"') >= 0 || s.indexOf(',') >= 0 || s.indexOf(cr) >= 0 || s.indexOf(lf) >= 0) return '"' + s.split('"').join('""') + '"';
    return s;
  }

  document.getElementById('export').addEventListener('click', function () {
    var lines = data.rows.map(function (r) { return r.map(quote).join(','); });
    var text = String.fromCharCode(0xFEFF) + lines.join(String.fromCharCode(13, 10));
    var url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    var a = document.createElement('a');
    var d = new Date();
    function p(x) { return String(x).length < 2 ? '0' + x : String(x); }
    a.href = url;
    a.download = '筛选结果_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });


  // ── 统计页：在页面里直接用这份快照算，不再读表格（统计视图的代码和侧边栏悬浮窗共用，见 stats-view.ts）──
  var renderStatsView = ${renderStatsView.toString()};
  var statsEl = document.getElementById('stats');
  var tabBtns = document.querySelectorAll('.tabs button');
  var statsBuilt = false;

  function showTab(name) {
    wrap.style.display = name === 'data' ? '' : 'none';
    statsEl.style.display = name === 'stats' ? 'block' : 'none';
    for (var i = 0; i < tabBtns.length; i++) tabBtns[i].classList.toggle('on', tabBtns[i].getAttribute('data-tab') === name);
    if (name === 'stats' && !statsBuilt) { statsBuilt = true; renderStatsView(statsEl, head, body, data.multi); }
    if (name === 'data') render();
  }
  for (var tb = 0; tb < tabBtns.length; tb++) {
    (function (btn) { btn.addEventListener('click', function () { showTab(btn.getAttribute('data-tab')); }); })(tabBtns[tb]);
  }

  buildHead();
  render();
  if (data.startTab === 'stats') showTab('stats');
})();
`;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 生成预览页的完整 HTML。rows 第一行是表头，其余是数据。 */
/** multi：和 rows 的列一一对应，true 表示这一列是多选字段（统计时按选项拆开）。 */
export function buildPreviewHtml(rows: string[][], total: number, startTab: 'data' | 'stats' = 'data', multi: boolean[] = []): string {
  // 数据放在 JSON 脚本块里：转义 < 防止提前结束脚本块，转义 U+2028/2029 避免被当成换行
  const json = JSON.stringify({ rows, startTab, multi })
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  const title = `筛选结果预览：命中 ${rows.length - 1} / 共 ${total} 条`;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(title)}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="bar"><b>${esc(title)}</b><span class="tabs"><button data-tab="data" class="on">数据</button><button data-tab="stats">统计</button></span><span class="hint">数据页：点击表头排序，拖动表头右边缘调整列宽。这是点击预览那一刻的快照，不会自动更新</span><button id="export">导出 CSV</button></div>
<div id="wrap"></div>
<div id="stats"></div>
<script id="data" type="application/json">${json}</script>
<script>${PAGE_SCRIPT}</script>
</body>
</html>`;
}
