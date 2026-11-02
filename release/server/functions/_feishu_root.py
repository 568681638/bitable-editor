# 让函数文件能 import 到 feishu 项目里的 apis.*（asset_client、tte_client 等）。
# feishu 项目所在目录默认是下面这个，部署到服务器时用环境变量 FEISHU_ROOT 指向服务器上的实际路径。
# 以下划线开头，不会被当成函数注册；函数文件里 `import _feishu_root` 即可（执行器已把本目录加入 sys.path）。
import os
import sys

ROOT = os.environ.get('FEISHU_ROOT', r'D:\claude\projects\feishu')
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
