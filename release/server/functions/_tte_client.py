# TTE 工单查询的最小客户端（自包含，只依赖 requests，不依赖任何其他项目）。
# 接口：POST {TTE_BASE_URL}/issue/list，用 assetIdList 批量查询；SHA1 签名鉴权。
# 以下划线开头，不会被当成函数注册。
import hashlib
import time
import uuid

import requests

import _config

BATCH_SIZE = 500
OK_CODES = (0, 200, 2000, "0", "200", "2000")


def _headers():
    """每次请求都重新生成 nonce / timestamp 并签名。"""
    key = _config.get("TTE_APP_KEY")
    secret = _config.get("TTE_APP_SECRET")
    nonce = str(uuid.uuid4())
    ts = str(int(time.time() * 1000))
    raw = "AppKey%sNonce%sTimestamp%s%s" % (key, nonce, ts, secret)
    return {
        "AppKey": key,
        "Nonce": nonce,
        "Timestamp": ts,
        "Sign": hashlib.sha1(raw.encode("utf-8")).hexdigest().upper(),
        "Content-Type": "application/json",
    }


def _post(url, body, timeout=30.0):
    with requests.Session() as session:
        session.trust_env = False  # 不使用环境变量里的代理
        resp = session.post(url, json=body, headers=_headers(), timeout=timeout)
    resp.raise_for_status()
    payload = resp.json()
    code = payload.get("code")
    if code is not None and code not in OK_CODES:
        raise RuntimeError("TTE 查询失败: code=%s, msg=%s" % (code, payload.get("msg") or payload.get("message")))
    return payload


def _records(payload):
    data = payload.get("data")
    if isinstance(data, dict):
        return data.get("list") or data.get("records") or data.get("items") or []
    if isinstance(data, list):
        return data
    return []


def _query_batch(batch):
    """查一批资产的工单；命中条数超过单页时按 total 翻页取全。"""
    url = _config.get("TTE_BASE_URL").rstrip("/") + "/issue/list"
    page_size = max(len(batch), 10)
    records, page = [], 1
    while True:
        payload = _post(url, {"page": page, "size": page_size, "assetIdList": batch})
        got = [r for r in _records(payload) if isinstance(r, dict)]
        records.extend(got)
        data = payload.get("data")
        total = data.get("total") if isinstance(data, dict) else None
        if not got or total is None or len(records) >= total:
            return records
        page += 1


def query_issues(asset_ids):
    """批量查工单，返回接口原始记录列表；查不到的资产不会出现在结果里。超过 500 个自动分批。"""
    ids = list(dict.fromkeys(a for a in asset_ids if a))
    result = []
    for i in range(0, len(ids), BATCH_SIZE):
        result.extend(_query_batch(ids[i:i + BATCH_SIZE]))
    return result
