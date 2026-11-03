# 函数用到的凭证和服务地址：优先读环境变量，其次读同目录下的 _credentials.json（已加入 .gitignore，不进 git）。
# 以下划线开头，不会被当成函数注册；函数文件里 `import _config` 使用。
# 模板见 _credentials.example.json。部署时把含真实值的 _credentials.json 随 release 目录一起拷到服务器即可，
# 也可以不放文件，改用同名环境变量。
import json
import os

_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_credentials.json")
_file_cache = None

DEFAULTS = {
    # 资产服务网关（生产环境），用环境变量 ASSET_BASE_URL 可以改
    "ASSET_BASE_URL": "https://data.zytintra.com/gw/openapi/data/assets",
    # TTE 开放接口地址，用环境变量 TTE_BASE_URL 可以改
    "TTE_BASE_URL": "https://tte.zytintra.com/open-apis/v1",
}


def _file():
    global _file_cache
    if _file_cache is None:
        try:
            with open(_FILE, "r", encoding="utf-8") as f:
                _file_cache = json.load(f)
        except FileNotFoundError:
            _file_cache = {}
    return _file_cache


def get(name, required=True):
    """取配置：环境变量 > _credentials.json > 内置默认值。required 且都没有时抛出说明清楚的错误。"""
    value = os.environ.get(name) or _file().get(name) or DEFAULTS.get(name)
    if not value and required:
        raise RuntimeError(
            "缺少配置 %s：请设置同名环境变量，或写入 %s（模板见 _credentials.example.json）" % (name, _FILE)
        )
    return value
