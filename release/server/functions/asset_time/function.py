# 资产起止时间：按资产 ID 取资产的起始 / 结束时间戳（us，已对齐到 10Hz 整时间戳）
# 自包含：直接请求资产服务网关（GET {ASSET_BASE_URL}/v1/api/assets/{id}，请求头 apiKey），只依赖 requests。
# 资产服务没有“按多个 ID 取资产信息”的接口，只能一个资产一次请求，所以用线程池并发查询：
# 并发数用环境变量 ASSET_WORKERS 调整（默认 8）。无效 ID 服务会立刻返回错误码，不重试，不会拖慢整批。
import os
from concurrent.futures import ThreadPoolExecutor

import requests

import _asset_id
import _config

META = {
    "id": "asset_time",
    "name": "资产起止时间",
    "inputs": [{"name": "asset_id", "label": "资产ID"}],
    "outputs": [
        {"name": "asset_start_us", "label": "资产起始时间us"},
        {"name": "asset_end_us", "label": "资产结束时间us"},
    ],
}

WORKERS = max(1, int(os.environ.get("ASSET_WORKERS", "8")))
OK_CODES = (0, 200, 2000)
GRID_US = 100 * 1000  # 对齐到 10Hz


def _fetch(session, base, headers, asset_id):
    """查一个资产：网络波动、服务端 5xx 重试 2 次；业务错误（如 ID 无效）不重试，直接失败。"""
    last = None
    for _ in range(3):
        try:
            resp = session.get("%s/v1/api/assets/%s" % (base, asset_id), headers=headers, timeout=20)
            if resp.status_code >= 500:
                raise RuntimeError("服务端错误 HTTP %d" % resp.status_code)
            payload = resp.json()
        except (requests.RequestException, RuntimeError, ValueError) as e:
            last = e
            continue
        if payload.get("code") not in OK_CODES:
            return RuntimeError("资产 %s 查询失败：%s（code=%s）" % (asset_id, payload.get("msg"), payload.get("code")))
        type_prop = (payload.get("data") or {}).get("typeProp") or {}
        start, end = type_prop.get("startSensorTime"), type_prop.get("endSensorTime")
        if start is None or end is None:
            return LookupError("资产 %s 没有起止时间（startSensorTime / endSensorTime）" % asset_id)
        return {"asset_start_us": start // GRID_US * GRID_US, "asset_end_us": end // GRID_US * GRID_US}
    return RuntimeError("资产 %s 查询失败：%r" % (asset_id, last))


def run(rows):
    base = _config.get("ASSET_BASE_URL").rstrip("/")
    headers = {"apiKey": _config.get("ASSET_API_KEY")}

    ids = [str(r.get("asset_id", "")).strip() for r in rows]
    bad_format = {i: _asset_id.format_error(i) for i in set(ids)}  # 格式不对的 ID 直接判失败，不发请求
    todo = list(dict.fromkeys(i for i in ids if bad_format[i] is None))

    fetched = {}
    if todo:
        with requests.Session() as session:
            with ThreadPoolExecutor(max_workers=min(WORKERS, len(todo))) as pool:
                # 重复的 ID 只查一次
                fetched = dict(zip(todo, pool.map(lambda i: _fetch(session, base, headers, i), todo)))

    return [bad_format[i] if bad_format[i] is not None else fetched[i] for i in ids]
