# TTE 工单：按资产 ID 批量查工单，取工单描述和问题语录
# 数据来源：feishu/apis/tte_client/tte_query.py 的 query_issues（一次请求查整批资产）
import _asset_id
import _feishu_root  # noqa: F401  让下面的 apis.* 可以 import

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
    from apis.tte_client.tte_query import query_issues

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
