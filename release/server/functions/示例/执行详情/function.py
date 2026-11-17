# 示例：带「执行详情」的函数。
#   - 执行详情是一批一条汇总：run 不返回列表，改返回 {"results": [...与 rows 等长], "detail": "这一批的整体执行情况"}
#   - 不写进表格字段；面板在「函数」块右上角的「历史」里，点那一次调用的「详情」查看
#   - 不需要逐行说明：把整批的情况（总数、失败数、被截断数等）汇总成几行文字即可
META = {
    "id": "note_demo",
    "name": "执行详情示例",
    "inputs": [{"name": "text", "label": "文本"}],
    "outputs": [
        {"name": "length", "label": "长度"},
    ],
}


def run(rows):
    results = []
    empty = 0
    long_ = 0
    for row in rows:
        text = (row.get("text") or "").strip()
        if not text:
            empty += 1
            results.append(ValueError("文本为空"))
        elif len(text) > 20:
            long_ += 1
            results.append({"length": len(text)})
        else:
            results.append({"length": len(text)})
    return {"results": results, "detail": "本批共 %d 行，空文本 %d 行（失败），超过 20 字 %d 行" % (len(rows), empty, long_)}
