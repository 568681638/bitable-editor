# TTE 工单：按资产 ID 批量查工单，取工单描述和问题语录
# 自包含：用同文件夹里 tte_client.py 的 query_issues（一次请求查整批资产），只依赖 requests，不依赖其他项目
import _asset_id

META = {
    "id": "tte_issue",
    "name": "TTE 工单",
    "inputs": [{"name": "asset_id", "label": "资产ID"}],
    "outputs": [
        {"name": "tte_description", "label": "tte_description"},
        {"name": "tte_quote", "label": "问题语录"},
    ],
}


def run(rows):
    # 放到函数里再 import：依赖缺失时不影响函数注册，错误会在运行时明确报出
    from tte_client import query_issues  # 同文件夹里的模块，服务会把函数文件夹加入 sys.path

    ids = [str(r.get("asset_id", "")).strip() for r in rows]
    issues = {}
    valid_ids = [i for i in ids if _asset_id.format_error(i) is None]  # 格式不对的 ID 不发请求
    for rec in (query_issues(valid_ids) if valid_ids else []):
        issues[str(rec.get("assetId"))] = rec  # 同一资产多条工单，取最后一条

    results = []
    for asset_id in ids:
        err = _asset_id.format_error(asset_id)
        if err is not None:
            results.append(err)
            continue
        issue = issues.get(asset_id)
        if issue is None:
            results.append(LookupError("TTE 没有查到资产 %s 的工单" % asset_id))
            continue
        # 问题语录：语音转写文本，优先取人工校对后的 annotatedDesc，没有则用 asrDesc；都为空返回 None，表示不写入该字段
        audio = issue.get("audioInfo") or {}
        results.append({
            "tte_description": issue.get("description"),  # None = 工单没有描述，不写入
            "tte_quote": audio.get("annotatedDesc") or audio.get("asrDesc") or None,
        })
    return results
