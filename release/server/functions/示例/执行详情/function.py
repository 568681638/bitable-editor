# 示例：带「执行详情」的函数。
#   - 出参里 type 为 "detail" 的那个是执行详情：不写进表格字段，面板每调用一批就收集它，在「函数」块右上角的「历史」里，点那一次调用的「详情」查看
#   - 每行一条：在每项里返回这个出参；这一行没什么可说的就返回 None
#   - 每批一条：run 不返回列表，改返回 {"results": [...与 rows 等长], "detail": "这一批的整体详情"}
META = {
    "id": "note_demo",
    "name": "执行详情示例",
    "inputs": [{"name": "text", "label": "文本"}],
    "outputs": [
        {"name": "length", "label": "长度"},
        {"name": "report", "label": "执行详情", "type": "detail"},
    ],
}


def run(rows):
    results = []
    empty = 0
    for row in rows:
        text = (row.get("text") or "").strip()
        if not text:
            empty += 1
            results.append(ValueError("文本为空"))
        elif len(text) > 20:
            results.append({"length": len(text), "report": "文本较长（%d 字），已按前 20 字处理" % len(text)})
        else:
            results.append({"length": len(text), "report": None})  # 没什么可说的：None
    return {"results": results, "detail": "本批共 %d 行，空文本 %d 行" % (len(rows), empty)}
