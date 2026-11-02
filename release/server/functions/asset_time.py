# 资产起止时间：按资产 ID 取资产的起始 / 结束时间戳（us，已对齐到 10Hz 整时间戳）
# 数据来源：feishu/apis/asset_client/get_asset_start_end_us.py
# 资产服务没有“按多个 ID 取资产信息”的接口，只能一个资产一次请求（GET /v1/api/assets/{id}）。
# 所以这里做两件事来降低开销：
#   1.（默认关闭）先用 check_asset_ids 一次请求筛掉无效的资产 ID。无效 ID 单查会重试 3 次，每个要等几十秒，
#      预检能省掉这部分时间。但“有效”的判定是资产【存在，并且属于指定的资产类型】（默认 original_data），
#      存在但属于别的类型的资产也会被判为无效，所以只有确定资产类型单一时才建议开启：
#      ASSET_PRECHECK=1 开启，ASSET_TYPE_NAME 指定类型
#   2. 有效的资产用线程池并发查询，并发数用环境变量 ASSET_WORKERS 调整（默认 8）
import os
from concurrent.futures import ThreadPoolExecutor

import _asset_id
import _feishu_root  # noqa: F401  让下面的 apis.* 可以 import

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
ASSET_TYPE_NAME = os.environ.get("ASSET_TYPE_NAME", "original_data")
PRECHECK = os.environ.get("ASSET_PRECHECK", "0") == "1"  # 默认关闭：资产类型不确定时预检会误伤


def run(rows):
    # 放到函数里再 import：模块导入慢或依赖缺失时，不影响函数注册（元信息仍能读出来）
    from apis.asset_client.get_asset_start_end_us import asset_client, get_asset_start_end_us

    ids = [str(r.get("asset_id", "")).strip() for r in rows]
    # 格式不对的 ID 直接判失败，不发请求；只查格式正确的
    bad_format = {i: _asset_id.format_error(i) for i in set(ids)}
    unique = list(dict.fromkeys(i for i in ids if bad_format[i] is None))

    valid = set(unique)
    if unique and PRECHECK:
        try:
            valid = set(asset_client.check_asset_ids(unique, ASSET_TYPE_NAME).get("correctAssetIdList") or [])
        except Exception as e:
            # 预检失败不影响取数：退回成逐个查，无效的 ID 会在单查时报错
            print("check_asset_ids 失败，跳过预检：%r" % (e,))
            valid = set(unique)

    def fetch(asset_id):
        try:
            start_us, end_us = get_asset_start_end_us(asset_id)
            return {"asset_start_us": start_us, "asset_end_us": end_us}
        except Exception as e:  # 只让这一个资产失败
            return RuntimeError("查询资产 %s 失败：%r" % (asset_id, e))

    todo = [i for i in unique if i in valid]
    with ThreadPoolExecutor(max_workers=min(WORKERS, max(1, len(todo)))) as pool:
        fetched = dict(zip(todo, pool.map(fetch, todo)))  # 同一个资产出现多次只查一次

    results = []
    for asset_id in ids:
        if bad_format[asset_id] is not None:
            results.append(bad_format[asset_id])
        elif asset_id not in valid:
            results.append(LookupError("资产 %s 不存在，或不是 %s 类型的资产" % (asset_id, ASSET_TYPE_NAME)))
        else:
            results.append(fetched[asset_id])
    return results
