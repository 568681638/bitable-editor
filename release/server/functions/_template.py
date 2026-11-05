# Python 批处理函数模板：复制本文件、改名（不要以下划线开头）、改内容，保存即生效，不用重启服务。
# 以下划线开头的文件会被忽略。每个 .py 文件对应一个函数，需要提供 META 和 run 两样东西。
#
#   META       id（全局唯一）、name（面板里显示）、inputs / outputs（参数列表）
#              inputs  : [{"name": 参数名, "label": 显示名}]，不同函数里同名入参视为同一个参数
#              outputs : [{"name": 参数名, "label": 显示名, "requires": [入参名...]}]，requires 可省略（默认本函数全部入参）
#   run(rows)  批量计算：rows 是 [{入参名: 值}, ...]（值已被面板转成文本，没映射到字段的入参不会出现），
#              必须返回与 rows 等长、顺序一致的列表，每项是 {出参名: 值}。
#              某一行算不出来：这一项返回一个异常对象（如 ValueError("原因")），只让这一行失败；
#              某个出参这一行没有值、不想写入该字段：这一项里把它设为 None，字段会保留原值（全部出参都是 None 则跳过这一行）。
#              run 里直接抛异常则整批失败，运行会中断。
#              返回值要直接是目标字段类型的原生形态（数字给数字、单选给选项名、日期给毫秒时间戳、复选框给 True/False 等，不做宽松转换），详见 release/README.md。
#              一次拿到多行，可以把查询、模型推理等合并成一次请求。
#
# 数据经临时文件传递（JSON），没有大小限制。用系统的 python3 运行（可用环境变量 PYTHON_BIN 指定其他解释器），print 的内容会进服务日志。
META = {
    "id": "py_example",
    "name": "Python 示例",
    "inputs": [{"name": "text", "label": "文本"}],
    "outputs": [{"name": "upper", "label": "大写"}],
}


def run(rows):
    return [{"upper": str(row["text"]).upper()} for row in rows]
