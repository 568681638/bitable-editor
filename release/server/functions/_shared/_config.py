# 函数读取自己的配置（服务地址、密钥）的公共小工具：函数里 `import _config`，`_config.get("NAME", default="...")`。
# 配置属于函数本身：默认值写在函数代码里（default=），密钥放在函数自己文件夹里的 _credentials.json（已加入 .gitignore，不进 git，模板见各函数文件夹里的 _credentials.example.json）。
# 查找顺序：同名环境变量 > 函数文件夹里的 _credentials.json > 本次调用传的 default。新函数不需要改这个文件。
# 以下划线开头，不会被当成函数注册。
import json
import os

_cache = {}


def _fn_dir():
    # 执行器启动时把函数文件夹写进这个环境变量（一个进程只跑一个函数）
    return os.environ.get("AUTOFLOW_FN_DIR") or os.getcwd()


def _file():
    path = os.path.join(_fn_dir(), "_credentials.json")
    if path not in _cache:
        try:
            with open(path, "r", encoding="utf-8") as f:
                _cache[path] = json.load(f)
        except FileNotFoundError:
            _cache[path] = {}
    return _cache[path]


def get(name, default=None, required=True):
    """取配置：环境变量 > 函数文件夹里的 _credentials.json > default。required 且都没有时抛出说明清楚的错误。"""
    value = os.environ.get(name) or _file().get(name) or default
    if not value and required:
        raise RuntimeError(
            "缺少配置 %s：请设置同名环境变量，或写入 %s（模板见同目录的 _credentials.example.json）"
            % (name, os.path.join(_fn_dir(), "_credentials.json"))
        )
    return value
