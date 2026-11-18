# 批处理的 Python 函数执行器（服务内部实现，不在 functions/ 里）：由 server.mjs 调用，不要直接运行。
#   python python_executor.py <函数入口 function.py> meta <输入文件> <输出文件>   → 把该文件的 META 写进输出文件
#   python python_executor.py <函数入口 function.py> run  <输入文件> <输出文件>   → 读输入文件 {"rows": [...]}，把 {"results": [...], "detail": 可选，这一批的整体详情} 写进输出文件
# 数据全部走文件（JSON，UTF-8），不经过命令行参数和管道，数据量不受限制；
# 函数里 print 的内容会被转到 stderr（进服务日志）。
import sys
import json
import importlib.util
import inspect
import os

sys.stdout = sys.stderr


def main():
    path, mode, in_path, out_path = sys.argv[1:5]
    os.environ['AUTOFLOW_FN_DIR'] = os.path.dirname(os.path.abspath(path))  # _config 据此找函数自己文件夹里的 _credentials.json
    # 入口可以 import 同文件夹里的任何模块（函数文件夹在最前面），以及 functions/_shared/ 里多个函数共用的公共模块（_config、_asset_id）
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'functions', '_shared'))
    sys.path.insert(0, os.path.dirname(os.path.abspath(path)))
    spec = importlib.util.spec_from_file_location('autoflush_fn', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    if mode == 'meta':
        result = mod.META
    else:
        with open(in_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        rows = data['rows']
        # 第二个参数 ctx = {"outputs": [前端要回写的出参名], "runId": 这次点「运行」的 ID, "batchId": 这一批调用的 ID（没有就是 None）}；run 只写了 rows 一个参数的旧函数照常调用
        ctx = {'outputs': data.get('outputs') if isinstance(data.get('outputs'), list) else [o['name'] for o in mod.META.get('outputs', [])],
               'runId': data.get('runId'), 'batchId': data.get('batchId')}
        try:
            takes_ctx = len(inspect.signature(mod.run).parameters) >= 2 or any(
                p.kind == inspect.Parameter.VAR_POSITIONAL for p in inspect.signature(mod.run).parameters.values())
        except (TypeError, ValueError):
            takes_ctx = False
        outs = mod.run(rows, ctx) if takes_ctx else mod.run(rows)
        message = None
        if isinstance(outs, dict) and 'results' in outs:  # {"results": [...], "detail": "这一批的整体详情"}（旧名 message 也认）
            message = outs.get('detail', outs.get('message'))
            outs = outs['results']
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
        if message is not None:
            result['detail'] = message if isinstance(message, str) else str(message)

    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False)


main()
