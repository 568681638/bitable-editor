# 批处理函数注册检查：确认函数已注册、声明合法，并用样例行实际调用一次 /run。只用标准库。
#   python -I check_function.py --list                          列出已注册的函数，并判断服务端版本
#   python -I check_function.py <函数 id>                       只检查注册信息
#   python -I check_function.py <函数 id> --rows rows.json      再用样例行调用一次（rows.json 是 [{入参名: 值}, ...]）
#   --base http://127.0.0.1:6868                                服务地址（默认这个；Windows 上别用 localhost，每次连接可能多等 2 秒）
# 有 FAIL 时退出码为 1。
import argparse
import json
import sys
import time
import urllib.error
import urllib.request

try:
    # 统一输出 UTF-8：Windows 上被管道接走时默认是 GBK，Git Bash / 编辑器终端会显示成乱码（真正的控制台窗口不受影响）
    sys.stdout.reconfigure(encoding='utf-8', errors='backslashreplace')
except AttributeError:
    pass

MANUAL_TYPES = ('select', 'multiSelect', 'text')
problems = []


def fail(msg):
    problems.append(msg)
    print('  FAIL ' + msg)


def ok(msg):
    print('  ok   ' + msg)


def http(base, path, body=None, timeout=30):
    data = None if body is None else json.dumps(body).encode('utf-8')
    req = urllib.request.Request(base + path, data, {'Content-Type': 'application/json'}, method='GET' if body is None else 'POST')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode('utf-8'))
        except Exception:
            return e.code, {}


def load_functions(base):
    try:
        status, data = http(base, '/api/functions')
    except Exception as e:
        print('连不上服务 %s：%s\n请先启动服务（npm run serve，或按 release/README.md 部署），再重试。' % (base, e))
        sys.exit(2)
    if status != 200 or not isinstance(data, list):
        print('服务返回异常：HTTP %s %s' % (status, data))
        sys.exit(2)
    return data


def flags(f):
    out = []
    if f.get('async'):
        out.append('异步')
    if f.get('serializeCalls', f.get('serializeRuns')):
        out.append('串行')
    return '、'.join(out) or '普通'


def cmd_list(base):
    fns = load_functions(base)
    new = all('serializeCalls' in f for f in fns) if fns else None
    print('服务端版本：%s' % ('新' if new else '未知（还没有任何函数）' if new is None else '旧（缺 serializeCalls 字段，async / serializeCalls 会被忽略，请先更新服务端）'))
    for f in fns:
        print('%-24s %-28s %-12s batch=%-5s 目录=%s' % (f['id'], f.get('name', ''), flags(f), f.get('batchSize'), '/'.join(f.get('path') or []) or '（根目录）'))
    return 0 if new is not False else 1


def check_declaration(f):
    print('声明：%s（%s），%s，batchSize=%s，目录=%s' % (f['id'], f.get('name'), flags(f), f.get('batchSize'), '/'.join(f.get('path') or []) or '（根目录）'))
    inputs, outputs = f.get('inputs') or [], f.get('outputs') or []
    names = [p['name'] for p in inputs]
    if len(set(names)) != len(names):
        fail('入参名有重复：%s' % names)
    for p in inputs:
        kind = p.get('type') or 'field'
        desc = p.get('description')
        if kind in MANUAL_TYPES:
            line = '入参 %s（%s）：%s' % (p['name'], p.get('label') or '', kind)
            if kind != 'text':
                line += '，可选值 %s' % [o['value'] for o in p.get('options') or []]
            if 'default' in p:
                line += '，默认 %s' % json.dumps(p['default'], ensure_ascii=False)
            ok(line)
            if not desc:
                fail('入参 %s 不来自字段，但没有 description：面板里用户看不出该填什么' % p['name'])
        else:
            ok('入参 %s（%s）：来自字段，run 拿到的是字符串' % (p['name'], p.get('label') or ''))
    all_out = [o['name'] for o in outputs]
    if len(set(all_out)) != len(all_out):
        fail('出参名有重复：%s' % all_out)
    if len([o for o in outputs if o.get('type') in ('detail', 'message')]) > 1:
        fail('type: "detail"（执行详情）的出参最多一个')
    out_names = [o['name'] for o in outputs if o.get('type') not in ('detail', 'message')]  # 执行详情不写进字段，可以不返回
    for o in outputs:
        if o.get('type') in ('detail', 'message'):
            ok('出参 %s（%s）：执行详情，不写进字段，面板会展示它；这一行没有详情就返回 None' % (o['name'], o.get('label') or ''))
            continue
        req = o.get('requires')
        bad = [r for r in req or [] if r not in names]
        if bad:
            fail('出参 %s 的 requires 里有不存在的入参：%s' % (o['name'], bad))
        ok('出参 %s（%s）%s' % (o['name'], o.get('label') or '', '，requires=%s' % req if req else ''))
    if not out_names:
        ok('没有要写进表格的出参：只调用、不写表格，run 每项返回 {} 即可' + ('（执行详情照常返回）' if outputs else ''))
    return names, out_names, [o['name'] for o in outputs if o.get('type') in ('detail', 'message')]


def check_run(base, f, rows, names, out_names, timeout, note_names=()):
    print('调用：%d 行样例' % len(rows))
    unknown = sorted({k for r in rows for k in r} - set(names))
    if unknown:
        fail('样例行里有函数没声明的入参：%s（面板不会传这些键）' % unknown)
    started = time.time()
    while True:
        status, data = http(base, '/api/functions/%s/run' % urllib.request.quote(f['id']), {'rows': rows}, timeout)
        if status == 202 and data.get('waiting'):  # 串行函数排队中，按约定重试
            print('  ..   串行函数正在排队，重试')
            continue
        break
    took = time.time() - started
    if status != 200:
        fail('整批失败：HTTP %s %s' % (status, data.get('error') or data))
        return
    results = data.get('results')
    if not isinstance(results, list) or len(results) != len(rows):
        fail('返回条数不对：收到 %d 行，返回 %s' % (len(rows), len(results) if isinstance(results, list) else type(results).__name__))
        return
    ok('返回 %d 条，与行数一致，用时 %.1f 秒（单批）' % (len(results), took))
    if (data.get('detail') or data.get('message')):
        print('  批级详情：%s' % (data.get('detail') or data.get('message')))
    for i, (row, r) in enumerate(zip(rows, results), 1):
        shown = json.dumps(row, ensure_ascii=False)
        shown = shown if len(shown) <= 80 else shown[:77] + '...'
        if not r.get('ok'):
            print('  row%-2d 失败：%s    ← %s' % (i, r.get('error'), shown))
            continue
        outs = r.get('outputs') or {}
        missing = [n for n in out_names if n not in outs]
        extra = [n for n in outs if n not in out_names and n not in note_names]
        if missing:
            fail('第 %d 行成功但缺少出参 %s（不想写值要显式返回 null / None，不能省略）' % (i, missing))
        if extra:
            print('  note 第 %d 行返回了没声明的出参 %s，面板会忽略它们' % (i, extra))
        print('  row%-2d 成功：%s    ← %s' % (i, json.dumps({k: outs.get(k) for k in out_names}, ensure_ascii=False), shown))
        for n in note_names:
            if outs.get(n):
                print('         详情：%s' % str(outs[n]).replace('\n', ' / '))


def main():
    ap = argparse.ArgumentParser(description='检查批处理函数是否注册成功、能否按约定调用')
    ap.add_argument('fn_id', nargs='?', help='函数 id（不写 id 时默认是函数文件夹名）')
    ap.add_argument('--list', action='store_true', help='列出已注册的函数')
    ap.add_argument('--rows', help='样例行 JSON 文件：[{入参名: 值}, ...]')
    ap.add_argument('--base', default='http://127.0.0.1:6868', help='服务地址')
    ap.add_argument('--timeout', type=float, default=300, help='一次调用最多等多少秒')
    a = ap.parse_args()
    base = a.base.rstrip('/')
    if a.list or not a.fn_id:
        return cmd_list(base)
    fns = load_functions(base)
    f = next((x for x in fns if x['id'] == a.fn_id), None)
    if not f:
        print('函数 %s 没有注册。已注册：%s' % (a.fn_id, ', '.join(x['id'] for x in fns)))
        print('请看服务日志里 [functions] 开头的行：语法错误、定义不合法、入参声明不合法、id 重复都会写明原因。')
        return 1
    if 'serializeCalls' not in f:
        fail('服务端是旧版本（返回里没有 serializeCalls），async / serializeCalls 会被忽略，请先更新服务端')
    names, out_names, note_names = check_declaration(f)
    if a.rows:
        with open(a.rows, encoding='utf-8') as fh:
            rows = json.load(fh)
        if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows):
            print('--rows 文件必须是 [{入参名: 值}, ...]')
            return 2
        check_run(base, f, rows, names, out_names, a.timeout, note_names)
    else:
        print('（没有给 --rows，只检查了注册信息；建议再用样例行实际调用一次）')
    print('\n结果：%s' % ('全部通过' if not problems else '%d 个问题需要修' % len(problems)))
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
