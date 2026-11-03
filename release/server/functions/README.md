# 自动刷写函数：扩展规则

本目录里的文件就是「自动刷写」面板里可以选的函数。**新增、修改、删除文件即时生效，不用重启服务。**
这份文档写给后续要往这里加函数的人（或 agent）：读完就能照着加。

## 一眼看懂

- 一个 `.mjs`（JS）或 `.py`（Python）文件 = 一个函数（JS 也可以导出数组，一个文件放多个）。
- 函数是**批量接口**：`run(rows)` 一次拿到一批行，返回等长的结果数组。
- 文件名以 `_` 开头的会被忽略（模板、公共模块、执行器都用这个前缀）。
- 其他扩展名（比如本文件 `.md`）不会被当成函数。

```
functions/
├── README.md               本文档
├── _template.mjs           JS 函数模板（复制它开始写）
├── _template.py            Python 函数模板（复制它开始写）
├── _python_executor.py     Python 执行器：服务用它加载并执行 .py 函数，不要删、不要改名
├── _asset_id.py            公共模块：资产 ID 格式检查（Python 函数里 import _asset_id）
├── _config.py              公共模块：读取凭证和服务地址（环境变量 > _credentials.json > 默认值）
├── _credentials.example.json  凭证模板；真实的 _credentials.json 不进 git，随 release 目录手动拷到服务器
├── _tte_client.py          公共模块：TTE 工单查询客户端（自包含，只依赖 requests）
├── text_stats.mjs          示例（JS）
├── url_host.mjs            示例（JS）
├── asset_time.py           资产起止时间（Python，调资产服务）
└── tte_issue.py            TTE 工单（Python，调 TTE 接口）
```

## 函数的定义

无论 JS 还是 Python，都由下面几部分组成：

| 部分 | 说明 |
| --- | --- |
| `id` | 全局唯一标识。重复的会被忽略，日志里会报警 |
| `name` | 面板里显示的函数名 |
| `inputs` | 入参列表 `[{name, label}]`。`name` 是**全局参数名**：不同函数里同名的入参视为同一个参数，用户在面板里只需把它映射到字段一次 |
| `outputs` | 出参列表 `[{name, label, requires?}]`。`requires` 是产出该出参需要的入参名数组，缺省为本函数的全部入参。用户选了某个出参后，面板会自动把它 `requires` 的入参补进「输入」区 |
| `run(rows)` | 批量计算，见下 |

### JS（`.mjs`）

```js
export default {
  id: 'example',
  name: '示例函数',
  inputs: [{ name: 'text', label: '文本' }],
  outputs: [{ name: 'upper', label: '大写' }],
  async run(rows) {
    return rows.map((row) => ({ upper: String(row.text).toUpperCase() }));
  },
};
```

### Python（`.py`）

```python
META = {
    "id": "py_example",
    "name": "Python 示例",
    "inputs": [{"name": "text", "label": "文本"}],
    "outputs": [{"name": "upper", "label": "大写"}],
}

def run(rows):
    return [{"upper": str(row["text"]).upper()} for row in rows]
```

Python 文件需要提供 `META`（字典）和 `run`（函数）。一个 `.py` 文件只对应一个函数。

## `run(rows)` 的约定（最重要）

**入参**：`rows` 是 `[{入参名: 值}, ...]`。
- 值已经被面板转成**文本**（单元格里的内容拍平成字符串），没有映射到字段的入参不会出现在 `row` 里。
- 一批最多 100 行，面板每批调用一次。同一批的行请合并成一次下游请求（查接口、跑模型），不要一行一次，这是做成批量接口的意义。

**返回值**：必须是**与 `rows` 等长、顺序一致**的数组，每一项是 `{出参名: 值}`。长度对不上整批报错。

**某一行失败**：在那个位置返回一个错误对象，只让这一行失败，其他行照常写入，失败原因会出现在面板的失败明细里。
- JS：`return new Error('原因')`
- Python：`ValueError('原因')`（返回，不是 raise）

**整批失败**：`run` 里直接抛异常（JS `throw` / Python `raise`），整批失败，刷写中断，并提示原因。适合下游服务整个不可用这类系统性错误。

**某个出参这一行没有值、不想覆盖字段**：把它设为 `null`（JS）/ `None`（Python），该字段保留原值；一行里所有出参都是空，则整行跳过。注意 JS 里必须是 `null`，不能是 `undefined`（JSON 会丢掉 undefined，会被当成没返回）。

## 出参值的格式

面板按目标字段的类型把返回值写进表格，**函数要直接返回该类型的原生形态**，不做宽松转换（不解析日期字符串、不拆分隔符），类型不对只会让这一行失败。

| 目标字段类型 | 函数返回 |
| --- | --- |
| 文本 | 字符串（数字也行） |
| 数字 / 货币 / 进度 / 评分 | 数字 |
| 单选 | 选项名（字符串）。选项必须已存在，不会自动新增 |
| 多选 | 选项名数组，如 `["紧急", "普通"]` |
| 日期 | 毫秒时间戳（数字） |
| 复选框 | `true` / `false` |
| 电话 / 邮箱 | 字符串 |
| 超链接 | 链接字符串，或 `{"link": "...", "text": "..."}` |
| 人员 | 人员数组 `[{"id": "..."}]` |

公式、附件、关联、地理位置、群组、自动编号等暂不支持写入，用户选了会在刷写前被拦住。

## Python 函数的运行方式

- 服务用系统的 `python3` 执行（Windows 本机默认 `python`），可以用环境变量 `PYTHON_BIN` 指定别的解释器。
- 每批调用启动一次 Python 进程；数据经临时目录里的 JSON 文件进出，没有大小限制，用完自动清理。
- 函数里 `print` 的内容进服务日志，不会弄坏返回结果。
- 执行器会把本目录加入 `sys.path`，所以 Python 函数里可以直接 `import _asset_id`、`import _config` 这类以 `_` 开头的公共模块。
- 函数要**自包含**：只依赖本目录里的文件和 PyPI 上的第三方库（如 `requests`），**不要 import 其他项目的代码**，否则部署到服务器就找不到。需要的客户端逻辑直接写进本目录的公共模块（参考 `_tte_client.py`）。
- 依赖放在**函数的 `run` 里再 import**（参考 `tte_issue.py`）：模块导入慢或依赖缺失时，函数仍能注册成功、出现在列表里，错误会在运行时明确报出，而不是让函数从列表里消失。
- 单批执行超时默认 300 秒，可用 `PY_RUN_TIMEOUT_MS` 调大；读取元信息超时 15 秒。

## 环境变量

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `PYTHON_BIN` | Python 解释器路径 | Linux `python3` / Windows `python` |
| `PY_RUN_TIMEOUT_MS` | Python 单批执行超时（毫秒） | 300000 |
| `ASSET_WORKERS` | `asset_time.py` 并发查询资产的线程数 | 8 |
| `ASSET_BASE_URL` | 资产服务网关地址 | `https://data.zytintra.com/gw/openapi/data/assets` |
| `ASSET_API_KEY` | 资产服务的 apiKey | 无，写在 `_credentials.json` |
| `TTE_BASE_URL` | TTE 开放接口地址 | `https://tte.zytintra.com/open-apis/v1` |
| `TTE_APP_KEY` / `TTE_APP_SECRET` | TTE 开放接口的签名凭证 | 无，写在 `_credentials.json` |

**凭证**：`ASSET_API_KEY`、`TTE_APP_KEY`、`TTE_APP_SECRET` 优先读同名环境变量，其次读本目录的 `_credentials.json`（模板见 `_credentials.example.json`）。`_credentials.json` 已加入 `.gitignore`，**不会进 git**，所以部署时要把本机这个文件随 `release/` 目录一起拷到服务器，或者在服务器上改用环境变量。缺少配置时函数会报出明确的错误，提示缺哪一项。

依赖：服务器上的 `python3` 只需要装 `requests`。

## 热加载的细节

- 服务每次收到请求都会重新扫描本目录，按文件修改时间决定是否重新加载。
- 某个文件语法错误或定义不合法：只在服务日志里报错，不影响其他函数；它上一次加载成功的版本会继续保留。
- 热加载只针对本目录下的函数文件本身。函数文件 `import` 的其他模块（比如另一个 `.mjs`、npm 包）改了，仍然需要重启服务。
- 服务端要**兼容 Node 14**：JS 函数里不要用 `??=`、`||=`、`replaceAll`、`.at()` 等较新的写法。

## 资产 ID 的基本检查

涉及资产 ID 的函数，请先过一遍 `_asset_id.format_error`：资产 ID 是 **10 位，字符只能是数字和大小写英文字母**（不要求三种都出现）。格式不对的 ID 直接判这一行失败，不要再发请求，因为无效 ID 去查资产服务会重试 3 次，每个要等几十秒。

```python
import _asset_id

err = _asset_id.format_error(asset_id)   # 格式对返回 None，否则返回一个异常对象
if err is not None:
    results.append(err)                  # 直接作为这一行的失败原因
    continue
```

## 本地怎么测

服务启动后（默认端口 6868），不用打开多维表格，直接用 curl 调：

```bash
# 列出所有已注册的函数
curl localhost:6868/api/functions

# 调用某个函数：body 里的 rows 就是 run(rows) 的入参
curl -X POST localhost:6868/api/functions/text_stats/run \
  -H "Content-Type: application/json" \
  -d '{"rows":[{"text":"hello"},{"text":"a\nb"}]}'
# 返回：{"results":[{"ok":true,"outputs":{...}},{"ok":false,"error":"..."}]}
```

`results` 与 `rows` 等长；`ok:false` 的是返回了错误对象的行。接口出错（函数不存在、整批失败）会返回 HTTP 4xx/5xx 加 `{"error": "原因"}`。

> 在 Windows 的 Git Bash 里用 curl 传中文，终端编码可能让中文乱码，这是 shell 的问题，不是服务的问题；要测中文可以用 Python 的 `urllib` 发请求。

## 加一个新函数的清单

1. 复制 `_template.mjs` 或 `_template.py`，改名（**不要**以下划线开头）。
2. 定好 `id`（唯一）、`name`、`inputs`、`outputs`（需要时写 `requires`）。
3. 实现 `run(rows)`：批量处理，返回等长数组；单行失败返回错误对象；没有值返回 `null`/`None`。
4. 出参值按上面的表格给目标字段类型的原生形态。
5. 保存。看服务日志里有没有 `[functions] 已加载 xxx` 一行；用 `curl localhost:6868/api/functions` 确认它出现在列表里。
6. 用 `curl` 调一次，确认结果等长、格式对，再去面板里试。
