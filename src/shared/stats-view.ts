// 统计视图：对一批记录（表头 + 文本单元格）做统计，侧边栏的悬浮窗和新标签页的统计页共用这一份。
// 新标签页的页面是一份自带脚本的静态 HTML，用 toString() 把这个函数的源码嵌进去，所以：
//   1) 函数必须自包含（不能引用函数外面的任何变量 / 函数）；
//   2) 里面不要用模板字符串（反引号）、${、反斜杠，避免和外层模板字符串冲突。
// 统计类型（下拉框里选，默认“取值分布”）：
//   取值分布：选一列，看这批记录在这一列上的取值分布；多选字段自动按选项拆开统计（multi[k] 为 true 的列）
//   数值区间：选一个数值列，分成若干区间看分布（直方图）
//   日期趋势：选一个日期列，按天 / 按月看记录数的变化
// 想加新的统计类型：往 TYPES 里加一项，并在 draw() 里补一个分支，算出 { label, count, dim } 的行交给 bars() 画就行。
export function renderStatsView(root: HTMLElement, head: string[], body: string[][], multi?: boolean[]): void {
  var n = body.length;
  var TYPES = [
    { id: 'dist', name: '取值分布' },
    { id: 'hist', name: '数值区间' },
    { id: 'trend', name: '日期趋势' },
  ];

  function isNum(s: string): boolean { return s !== '' && s.trim() !== '' && isFinite(Number(s)); }
  function p2(x: number): string { return String(x).length < 2 ? '0' + x : String(x); }
  function fmtDate(ms: number): string { var d = new Date(ms); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
  function fmtMonth(ms: number): string { var d = new Date(ms); return d.getFullYear() + '-' + p2(d.getMonth() + 1); }
  function fmtNum(x: number): string { return String(Math.round(x * 100) / 100); }
  function pct(a: number, b: number): string { return b ? (Math.round(a / b * 1000) / 10) + '%' : '0%'; }
  function el(tag: string, cls?: string, text?: string): HTMLElement {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function blank(v: string): boolean { return v === '' || v.trim() === ''; }

  // 每一列的概况：已填、不同取值、数值 / 日期的范围
  var info = head.map(function (name, k) {
    var filled = 0, nums = 0, dates = 0, sum = 0, min = Infinity, max = -Infinity, distinct = 0;
    var seen: Record<string, number> = Object.create(null);
    for (var r = 0; r < n; r++) {
      var v = body[r][k];
      if (blank(v)) continue;
      filled++;
      if (!seen[v]) { seen[v] = 1; distinct++; }
      if (isNum(v)) {
        var x = Number(v);
        nums++; sum += x;
        if (x < min) min = x;
        if (x > max) max = x;
        if (/^[0-9]{12,13}$/.test(v) && x > 946684800000 && x < 4102444800000) dates++;  // 毫秒时间戳 → 当日期
      }
    }
    return { name: name, k: k, filled: filled, distinct: distinct, sum: sum, min: min, max: max,
      isDate: filled > 0 && dates === filled, isNumber: filled > 0 && nums === filled && dates !== filled };
  });

  root.innerHTML = '';
  var sec = el('div', 'st-sec');
  var ctl = el('div', 'st-ctl');
  var typeSel = el('select') as HTMLSelectElement;
  TYPES.forEach(function (t) { var o = el('option', '', t.name) as HTMLOptionElement; o.value = t.id; typeSel.appendChild(o); });
  var colSel = el('select') as HTMLSelectElement;
  var topSel = el('select') as HTMLSelectElement;  // 取值分布：显示前几个
  [10, 20, 50, 100, 0].forEach(function (t) { var o = el('option', '', t ? '前 ' + t + ' 个' : '全部') as HTMLOptionElement; o.value = String(t); topSel.appendChild(o); });
  topSel.value = '20';
  var binSel = el('select') as HTMLSelectElement;  // 数值区间：分几段
  [5, 10, 20].forEach(function (t) { var o = el('option', '', '分 ' + t + ' 段') as HTMLOptionElement; o.value = String(t); binSel.appendChild(o); });
  binSel.value = '10';
  var granSel = el('select') as HTMLSelectElement;  // 日期趋势：按天 / 按月
  [['day', '按天'], ['month', '按月']].forEach(function (t) { var o = el('option', '', t[1]) as HTMLOptionElement; o.value = t[0]; granSel.appendChild(o); });
  [typeSel, colSel, topSel, binSel, granSel].forEach(function (s) { ctl.appendChild(s); });
  sec.appendChild(ctl);
  var sumEl = el('div', 'st-sum');
  sec.appendChild(sumEl);
  var distEl = el('div');
  sec.appendChild(distEl);
  root.appendChild(sec);

  // 当前统计类型适用的列：取值分布全部可用，数值区间要数值列，日期趋势要日期列
  function fillCols(preferred: number): void {
    var type = typeSel.value;
    colSel.innerHTML = '';
    var first = -1, keep = false;
    info.forEach(function (c) {
      if (type === 'hist' && !c.isNumber) return;
      if (type === 'trend' && !c.isDate) return;
      var o = el('option', '', c.name) as HTMLOptionElement;
      o.value = String(c.k);
      colSel.appendChild(o);
      if (first < 0) first = c.k;
      if (c.k === preferred) keep = true;
    });
    if (first >= 0) colSel.value = String(keep ? preferred : first);
  }

  type Row = { label: string; count: number; dim: boolean };

  function bars(rows: Row[]): void {
    distEl.innerHTML = '';
    if (!rows.length) { distEl.appendChild(el('div', 'st-empty', '没有数据')); return; }
    var maxC = 0;
    rows.forEach(function (x) { if (x.count > maxC) maxC = x.count; });
    rows.forEach(function (x) {
      var row = el('div', 'dist-row');
      var lab = el('div', 'dist-label' + (x.dim ? ' dim' : ''), x.label);
      lab.title = x.label;
      var track = el('div', 'dist-track');
      var f = el('i', x.dim ? 'dim' : '');
      f.style.width = (maxC ? x.count / maxC * 100 : 0) + '%';
      track.appendChild(f);
      row.appendChild(lab);
      row.appendChild(track);
      row.appendChild(el('div', 'dist-num', x.count + '（' + pct(x.count, n) + '）'));
      distEl.appendChild(row);
    });
  }

  function draw(): void {
    var type = typeSel.value;
    topSel.style.display = type === 'dist' ? '' : 'none';
    binSel.style.display = type === 'hist' ? '' : 'none';
    granSel.style.display = type === 'trend' ? '' : 'none';
    if (colSel.options.length === 0) {
      sumEl.textContent = '';
      bars([]);
      distEl.innerHTML = '';
      distEl.appendChild(el('div', 'st-empty', type === 'hist' ? '没有数值列' : '没有日期列'));
      return;
    }
    var k = Number(colSel.value);
    var inf = info[k];
    var parts = ['已填 ' + inf.filled + ' / ' + n + '（' + pct(inf.filled, n) + '）'];
    var rows: Row[] = [];
    var empty = 0;
    for (var r0 = 0; r0 < n; r0++) if (blank(body[r0][k])) empty++;

    if (type === 'dist') {
      var counts: Record<string, number> = Object.create(null);
      var split = !!(multi && multi[k]);  // 多选字段：值是用逗号拼起来的，按选项拆开统计
      for (var r = 0; r < n; r++) {
        var v = body[r][k];
        if (blank(v)) continue;
        var keys = split ? v.split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s !== ''; }) : [v];
        for (var q = 0; q < keys.length; q++) {
          var key = inf.isDate ? fmtDate(Number(keys[q])) : keys[q];
          counts[key] = (counts[key] || 0) + 1;
        }
      }
      var arr = Object.keys(counts).map(function (key) { return { key: key, count: counts[key] }; });
      arr.sort(function (a, b) { return b.count - a.count || a.key.localeCompare(b.key, 'zh'); });
      var top = Number(topSel.value) || arr.length;  // 0 = 全部
      var shown = arr.slice(0, top);
      var restCount = 0;
      for (var m = top; m < arr.length; m++) restCount += arr[m].count;
      if (inf.isDate) shown.sort(function (a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; });  // 日期按时间顺序排
      rows = shown.map(function (x) { return { label: x.key, count: x.count, dim: false }; });
      if (arr.length > top) rows.push({ label: '其他（' + (arr.length - top) + ' 个取值）', count: restCount, dim: true });
      parts.push((split ? '选项数 ' : '不同取值 ') + arr.length);
      if (inf.isDate) parts.push('最早 ' + fmtDate(inf.min), '最晚 ' + fmtDate(inf.max));
      else if (inf.isNumber) parts.push('最小 ' + fmtNum(inf.min), '最大 ' + fmtNum(inf.max), '平均 ' + fmtNum(inf.sum / inf.filled), '合计 ' + fmtNum(inf.sum));
    } else if (type === 'hist') {
      var vals: number[] = [];
      for (var r2 = 0; r2 < n; r2++) if (!blank(body[r2][k])) vals.push(Number(body[r2][k]));
      var bins = Number(binSel.value);
      var lo = inf.min, hi = inf.max;
      var width = (hi - lo) / bins;
      var bc: number[] = [];
      for (var b0 = 0; b0 < bins; b0++) bc.push(0);
      vals.forEach(function (x) { bc[width > 0 ? Math.min(bins - 1, Math.floor((x - lo) / width)) : 0]++; });
      if (width > 0) {
        for (var b = 0; b < bins; b++) rows.push({ label: fmtNum(lo + b * width) + ' ~ ' + fmtNum(lo + (b + 1) * width), count: bc[b], dim: false });
      } else {
        rows.push({ label: fmtNum(lo), count: vals.length, dim: false });
      }
      vals.sort(function (a, b) { return a - b; });
      var mid = vals.length ? (vals.length % 2 ? vals[(vals.length - 1) / 2] : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2) : 0;
      parts.push('最小 ' + fmtNum(inf.min), '最大 ' + fmtNum(inf.max), '平均 ' + fmtNum(inf.sum / inf.filled), '中位数 ' + fmtNum(mid), '合计 ' + fmtNum(inf.sum));
    } else {
      var byMonth = granSel.value === 'month';
      var tc: Record<string, number> = Object.create(null);
      var tmin = Infinity, tmax = -Infinity;
      for (var r3 = 0; r3 < n; r3++) {
        var tv = body[r3][k];
        if (blank(tv)) continue;
        var ms = Number(tv);
        if (ms < tmin) tmin = ms;
        if (ms > tmax) tmax = ms;
        var tk = byMonth ? fmtMonth(ms) : fmtDate(ms);
        tc[tk] = (tc[tk] || 0) + 1;
      }
      // 按时间顺序列出，中间没有记录的日子 / 月份补 0，趋势才看得出断档（跨度太大就不补）
      var cur = new Date(tmin);
      var stop = new Date(tmax);
      var guard = 0;
      var span = byMonth ? (stop.getFullYear() - cur.getFullYear()) * 12 + stop.getMonth() - cur.getMonth() : Math.round((tmax - tmin) / 86400000);
      if (span <= (byMonth ? 120 : 400)) {
        cur = byMonth ? new Date(cur.getFullYear(), cur.getMonth(), 1) : new Date(cur.getFullYear(), cur.getMonth(), cur.getDate());
        while (guard++ < 1000 && (byMonth ? fmtMonth(cur.getTime()) <= fmtMonth(tmax) : fmtDate(cur.getTime()) <= fmtDate(tmax))) {
          var ck = byMonth ? fmtMonth(cur.getTime()) : fmtDate(cur.getTime());
          rows.push({ label: ck, count: tc[ck] || 0, dim: false });
          cur = byMonth ? new Date(cur.getFullYear(), cur.getMonth() + 1, 1) : new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1);
        }
      } else {
        Object.keys(tc).sort().forEach(function (ck2) { rows.push({ label: ck2, count: tc[ck2], dim: false }); });
      }
      var peak = rows.reduce(function (p, x) { return x.count > p.count ? x : p; }, { label: '', count: -1, dim: false });
      parts.push('最早 ' + fmtDate(tmin), '最晚 ' + fmtDate(tmax), '最多 ' + peak.label + '（' + peak.count + '）');
    }
    if (empty > 0) rows.push({ label: '（空）', count: empty, dim: true });
    sumEl.textContent = parts.join('　·　');
    bars(rows);
  }

  typeSel.addEventListener('change', function () { fillCols(Number(colSel.value)); draw(); });
  [colSel, topSel, binSel, granSel].forEach(function (s) { s.addEventListener('change', draw); });

  // 默认选第一个“有重复取值”的列：每个值都唯一的列（如记录 ID）画分布没有意义
  var firstUseful = 0;
  for (var u = 0; u < info.length; u++) { if (info[u].distinct > 1 && info[u].distinct < info[u].filled) { firstUseful = u; break; } }
  fillCols(firstUseful);
  draw();
}
