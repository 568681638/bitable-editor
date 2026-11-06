# 批处理函数：扩展规则

本目录里的**文件夹**就是「批处理」面板里可以选的函数。**新增、修改、删除文件即时生效，不用重启服务。**
这份文档写给后续要往这里加函数的人（或 agent）：读完就能照着加。

## 一眼看懂

- **一个函数 = 一个文件夹**：文件夹里必须有入口文件 `function.mjs`（JS）或 `function.py`（Python），入口里写函数的定义和 `run`。函数依赖的其他文件（模块、数据、配置、`requirements`……）都放在这个文件夹里，一个函数的东西不会散落到别处。
- **分类目录**：不含入口文件的文件夹就是分类目录，可以多层嵌套（最多 8 层）。面板「函数」块里选函数时，层级和这里的目录结构一致，目录名就是层级名；所有目录、函数默认折叠。函数文件夹本身在面板里直接对应「函数」，不会再当成一层目录；放在 `functions/` 根目录下的函数显示在最外层。
- 函数文件夹里面**不再往下找函数**：里面的子目录都是这个函数的私有内容，不会被当成分类目录。
- 函数是**批量接口**：`run(rows)` 一次拿到一批行，返回等长的结果数组。
- 文件名或目录名以 `_` 或 `.` 开头的会被忽略（模板、公共模块、执行器、`__pycache__` 都用这个前缀）；`node_modules` 也会被跳过。
- **旧写法已不再加载**：直接放在目录里的单个 `xxx.mjs` / `xxx.py` 会被忽略，服务日志里会提醒一次该怎么改（放进 `xxx/function.mjs` / `xxx/function.py`）。

```
functions/
├── README.md                   本文档
├── _template/                  函数模板（复制整个文件夹改名，里面 function.mjs / function.py 二选一）
├── _python_executor.py         Python 执行器：服务用它加载并执行 function.py，不要删、不要改名
├── _asset_id.py                公共模块：资产 ID 格式检查（多个函数共用，Python 里 import _asset_id）
├── _config.py                  公共模块：读取凭证和服务地址（环境变量 > _credentials.json > 默认值）
├── _credentials.example.json   凭证模板；真实的 _credentials.json 不进 git，随 release 目录手动拷到服务器
├── text_stats/function.mjs     示例（JS）
├── url_host/function.mjs       示例（JS）
├── asset_time/function.py      资产起止时间（Python，调资产服务）
├── tte_issue/                  TTE 工单（Python，调 TTE 接口）
│   ├── function.py             入口
│   └── tte_client.py           只有这个函数用的客户端模块（和函数放在一起，function.py 里直接 import tte_client）
└── 示例/无输出/log_rows/       无输出函数示例：「示例 / 无输出」是两层分类目录，log_rows 是函数文件夹
    └── function.mjs
```

**什么放根目录的 `_xxx` 公共模块，什么放函数文件夹里**：只有一个函数用的（客户端、数据文件、辅助模块），放进它自己的文件夹；多个函数共用的（凭证读取 `_config`、资产 ID 检查 `_asset_id`），放在 `functions/` 根目录，以 `_` 开头。

## 函数的定义

无论 JS 还是 Python，都由下面几部分组成：

| 部分 | 说明 |
| --- | --- |
| `id` | 全局唯一标识。重复的会被忽略，日志里会报警。**可以省略，省略就用文件夹名** |
| `name` | 面板里显示的函数名。可以省略，省略就用 `id` |
| `inputs` | 入参列表 `[{name, label}]`。`name` 是参数名；面板里每个函数卡片各自映射入参到字段（同名参数在不同函数里互不影响，新加函数时会自动沿用别处配好的同名参数的字段，之后可单独改） |
| `outputs` | 出参列表 `[{name, label, requires?}]`。`requires` 是产出该出参需要的入参名数组，缺省为本函数的全部入参。用户选了某个出参后，面板会自动把它 `requires` 的入参补成该函数卡片里的输入行（标「必需」，只差字段要选）。**可以不写或写空数组**：这就是只调用、不写表格的函数（发通知、触发任务等），`run` 每项返回 `{}` 即可 |
| `batchSize` | 可选。`run` 每次最多拿到多少行（最后一批可能不足），默认 100，范围 1 ~ 5000（超出会被收到范围内）。下游一次能处理很多就调大，下游慢、限流、单次耗时长（调模型）就调小 |
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

`function.py` 需要提供 `META`（字典）和 `run`（函数）；`META` 里的 `id`、`name` 同样可以省略。一个函数文件夹只对应一个函数（JS 入口导出数组可以放多个，但不推荐）。

## `run(rows)` 的约定（最重要）

**入参**：`rows` 是 `[{入参名: 值}, ...]`。
- 值已经被面板转成**文本**（单元格里的内容拍平成字符串），没有映射到字段的入参不会出现在 `row` 里。
- `run` 每次最多拿到 `batchSize` 行（默认 100）；不足一批时直接按剩下的行数调用，不会等凑够，所以不要假设行数固定。同一批的行请合并成一次下游请求（查接口、跑模型），不要一行一次，这是做成批量接口的意义。
- **适配层在面板（前端）**：面板写回表格固定每 100 条提交一次；调用函数时按函数的 `batchSize` 攒批或拆分——一轮取选中的函数里最大的批大小那么多条记录，批大小大于 100 的函数把几个 100 攒成一次调用（500 = 攒 5 个 100），小于 100 的拆成几次；一轮算完，结果再按 100 条一批写回。服务端只负责把 `batchSize` 告诉面板，`/run` 接口收到多少行就一次交给函数多少行。
- 取消按钮在当前这一轮处理完后生效，所以 `batchSize` 越大，点取消后等得越久；一轮的结果要算完才开始写回。
- 用 curl 直接调用 `/run` 时，传多少行函数就一次拿到多少行，不会按 `batchSize` 拆分。

**返回值**：必须是**与 `rows` 等长、顺序一致**的数组，每一项是 `{出参名: 值}`。长度对不上整批报错。

**某一行失败**：在那个位置返回一个错误对象，只让这一行失败，其他行照常写入，失败原因会出现在面板的失败明细里。
- JS：`return new Error('原因')`
- Python：`ValueError('原因')`（返回，不是 raise）

**没有输出的函数**：`outputs` 为空时，`run` 每项返回 `{}`（或 `None`）表示这一行成功，返回错误对象表示这一行失败；面板里添加这个函数（点函数右侧的 ＋ ）就行，不用选字段，运行后统计「已调用 N 条」。

**整批失败**：`run` 里直接抛异常（JS `throw` / Python `raise`），整批失败，运行中断，并提示原因。适合下游服务整个不可用这类系统性错误。

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

公式、附件、关联、地理位置、群组、自动编号等暂不支持写入，用户选了会在运行前被拦住。

## Python 函数的运行方式

- 服务用系统的 `python3` 执行（Windows 本机默认 `python`），可以用环境变量 `PYTHON_BIN` 指定别的解释器。
- 每批调用启动一次 Python 进程；数据经临时目录里的 JSON 文件进出，没有大小限制，用完自动清理。
- 函数里 `print` 的内容进服务日志，不会弄坏返回结果。
- 服务把**函数文件夹**设为 Python 的工作目录并加入 `sys.path`：函数里可以直接 `import` 同文件夹里的模块、按相对路径读同文件夹里的数据文件；根目录下以 `_` 开头的公共模块（`_asset_id`、`_config`）同样可以 `import`。每次调用都是新进程，所以改了函数文件夹里的任何 `.py`，下一次调用就生效。
- 函数要**自包含**：只依赖本目录里的文件和 PyPI 上的第三方库（如 `requests`），**不要 import 其他项目的代码**，否则部署到服务器就找不到。需要的客户端逻辑直接写进函数自己的文件夹（参考 `tte_issue/tte_client.py`）。
- 依赖放在**函数的 `run` 里再 import**（参考 `tte_issue/function.py`）：模块导入慢或依赖缺失时，函数仍能注册成功、出现在列表里，错误会在运行时明确报出，而不是让函数从列表里消失。
- 单批执行超时默认 300 秒，可用 `PY_RUN_TIMEOUT_MS` 调大；读取元信息超时 15 秒。

## 环境变量

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `PYTHON_BIN` | Python 解释器路径 | Linux `python3` / Windows `python` |
| `PY_RUN_TIMEOUT_MS` | Python 单批执行超时（毫秒） | 300000 |
| `ASSET_WORKERS` | `asset_time` 并发查询资产的线程数 | 8 |
| `ASSET_BASE_URL` | 资产服务网关地址 | `https://data.zytintra.com/gw/openapi/data/assets` |
| `ASSET_API_KEY` | 资产服务的 apiKey | 无，写在 `_credentials.json` |
| `TTE_BASE_URL` | TTE 开放接口地址 | `https://tte.zytintra.com/open-apis/v1` |
| `TTE_APP_KEY` / `TTE_APP_SECRET` | TTE 开放接口的签名凭证 | 无，写在 `_credentials.json` |

**凭证**：`ASSET_API_KEY`、`TTE_APP_KEY`、`TTE_APP_SECRET` 优先读同名环境变量，其次读本目录的 `_credentials.json`（模板见 `_credentials.example.json`）。`_credentials.json` 已加入 `.gitignore`，**不会进 git**，所以部署时要把本机这个文件随 `release/` 目录一起拷到服务器，或者在服务器上改用环境变量。缺少配置时函数会报出明确的错误，提示缺哪一项。

依赖：服务器上的 `python3` 只需要装 `requests`。

## 热加载的细节

- 服务每次收到请求都会重新扫描本目录。每个函数文件夹有一个「指纹」（里面所有文件的最新修改时间 + 文件数），**文件夹里任何文件变了**（入口、依赖的模块、数据文件……）、新增、删除，都会重新加载这个函数；其他函数不受影响。
- 某个函数语法错误或定义不合法：只在服务日志里报错，不影响其他函数；它上一次加载成功的版本会继续保留。
- **JS 函数有一个限制**：入口文件会重新加载，但入口 `import` 的其他 `.mjs` 模块被 Node 缓存住了，改了它们仍然需要重启服务（或者同时改一下入口文件也没用，缓存的是被引用的模块本身）。Python 函数没有这个限制，每次调用都是新进程。
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

1. 复制 `_template/` 整个文件夹，改成函数名（**不要**以下划线开头），放到 `functions/` 下想要的分类目录里（要新分类就新建一层文件夹）；`function.mjs` 和 `function.py` 留一个，另一个删掉。
2. 定好 `inputs`、`outputs`（需要时写 `requires`）；`id`、`name` 不写就用文件夹名。
3. 实现 `run(rows)`：批量处理，返回等长数组；单行失败返回错误对象；没有值返回 `null`/`None`。
4. 出参值按上面的表格给目标字段类型的原生形态。
5. 这个函数依赖的其他文件（模块、数据）放进同一个文件夹；多个函数共用的才放根目录的 `_xxx`。
6. 保存。看服务日志里有没有 `[functions] 已加载 <路径>` 一行；用 `curl localhost:6868/api/functions` 确认它出现在列表里，`path` 是它所在的分类目录。
7. 用 `curl` 调一次，确认结果等长、格式对，再去面板里试。
