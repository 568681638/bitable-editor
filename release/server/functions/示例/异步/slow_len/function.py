# 异步函数示例（Python）：META 里写 "async": True。Python 异步函数单批的超时默认 4 小时（环境变量 PY_ASYNC_TIMEOUT_MS 可调）
import time

META = {
    "name": "异步示例：文本长度（慢，Python）",
    "async": True,
    "inputs": [{"name": "text", "label": "文本"}],
    "outputs": [{"name": "length", "label": "长度"}],
}


def run(rows):
    time.sleep(10)  # 模拟耗时很久的处理
    return [{"length": len(str(row.get("text", "")))} for row in rows]
