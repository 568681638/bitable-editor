# 自动刷写的 Python 函数执行器：由 server.mjs 调用，不要直接运行。
#   python _python_executor.py <函数文件.py> meta <输入文件> <输出文件>   → 把该文件的 META 写进输出文件
#   python _python_executor.py <函数文件.py> run  <输入文件> <输出文件>   → 读输入文件 {"rows": [...]}，把 {"results": [...]} 写进输出文件
# 数据全部走文件（JSON，UTF-8），不经过命令行参数和管道，数据量不受限制；
# 函数里 print 的内容会被转到 stderr（进服务日志）。
import sys
import json
import importlib.util
import os

sys.stdout = sys.stderr


def main():
    path, mode, in_path, out_path = sys.argv[1:5]
    sys.path.insert(0, os.path.dirname(os.path.abspath(path)))  # 函数文件可以 import 同目录下以 _ 开头的公共模块
    spec = importlib.util.spec_from_file_location('autoflush_fn', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    if mode == 'meta':
        result = mod.META
    else:
        with open(in_path, 'r', encoding='utf-8') as f:
            rows = json.load(f)['rows']
        outs = mod.run(rows)
        if not isinstance(outs, (list, tuple)) or len(outs) != len(rows):
            raise ValueError('run(rows) 必须返回与 rows 等长的列表（收到 %d 行，返回 %s）' % (
                len(rows), len(outs) if isinstance(outs, (list, tuple)) else type(outs).__name__))
        results = []
        for o in outs:
            if isinstance(o, BaseException):  # 返回异常对象 = 这一行失败
                results.append({'ok': False, 'error': '%s: %s' % (type(o).__name__, o)})
            else:
                results.append({'ok': True, 'outputs': o if isinstance(o, dict) else {}})
        result = {'results': results}

    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False)


main()
