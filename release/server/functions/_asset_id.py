# 资产 ID 的基本格式检查：10 位，只由数字和大小写英文字母组成。
# 格式不对的 ID 一定不是有效资产，直接报错，不必再去请求服务（无效 ID 单查会重试 3 次，每个要等几十秒）。
# 以下划线开头，不会被当成函数注册；函数文件里 `import _asset_id` 使用。
import re

_ASSET_ID_RE = re.compile(r"^[0-9A-Za-z]{10}$")


def format_error(asset_id):
    """格式正确返回 None，否则返回一个可直接作为这一行失败原因的异常对象。"""
    if not asset_id:
        return ValueError("资产ID为空")
    if not _ASSET_ID_RE.match(asset_id):
        return ValueError("资产ID格式不对（应为 10 位数字和大小写字母）：%s" % asset_id)
    return None
