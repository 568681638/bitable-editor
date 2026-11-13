# 批处理函数：扩展规则

本目录里的**文件夹**就是「批处理」面板里可以选的函数。**新增、修改、删除文件即时生效，不用重启服务。**
这份文档写给后续要往这里加函数的人（或 agent）：读完就能照着加。

## 先确认两件事（只读这份文档就够了）

这份文档在服务端的 `release/server/functions/` 目录里，**写一个函数只需要读它**，不需要读别的。动手前先确认：

1. **服务在跑**：`curl localhost:6868/api/functions` 能返回一个 JSON 数组（端口默认 6868；返回的就是现在已注册的函数）。连不上说明服务没启动，请先让服务起来（`release/README.md` 里有部署和启动方式；别在这里自己重新部署）。
2. **服务端是新版本**：返回的每个函数对象里都应该有 `async` 和 `serializeCalls` 两个字段（值是 `true` / `false`）。**如果没有这两个字段，说明服务端的 `server.mjs` 是旧版本**（缺 `jobs.mjs`、`locks.mjs` 对应的新代码；只有 `serializeRuns` 没有 `serializeCalls`，也是旧版本）：这时你在函数里写 `async` / `serializeCalls` 会被**静默忽略**，函数照样注册成功，但行为只是普通的同步函数。请先把完整的新版 `release/` 目录更新到服务端，再继续。

**新增、修改、删除函数文件夹即时生效，不用重启服务，也不用重新部署。**

> 要把**现成的** Python / JS 函数（脚本、模块里的方法、接口调用代码）接进来，可以用 Claude Code skill [`release/skills/register-function/`](../../skills/register-function/SKILL.md)：它按本文档的规则写适配层，并用 `check_function.py` 验证注册结果。规则仍以本文档为准。

## 30 秒上手

1. 复制 `_template/` 整个文件夹，改成函数名（不以下划线开头），放进 `functions/` 下想要的分类目录；`function.mjs` / `function.py` 留一个，另一个删掉。
2. 在入口里写 `inputs`、`outputs` 和 `run(rows)`（批量：一次拿到一批行，返回**等长**数组；某行失败返回错误对象）。
3. **按需**加两个可选开关（都不写就是最普通的同步函数，不用管它们）：

| 你的函数是这样 | 加这个 | JS 里写 | Python（`META` 里）写 |
| --- | --- | --- | --- |
| 一批要跑很久（几分钟到几小时），不想让面板一直等 | **异步** | `async: true` | `"async": True` |
| 函数里有多步操作，**两次执行不能交错**（多人同时点运行、连点两次、同一次运行拆出的多批同时跑都会互相踩） | **串行执行** | `serializeCalls: true` | `"serializeCalls": True` |
| 又久、又不能交错 | 两个都加 | `async: true, serializeCalls: true` | `"async": True, "serializeCalls": True` |

   两个开关**只影响函数怎么被调度**，`run` 的写法、返回值、出参格式、失败行的写法都和普通函数**完全一样**，不要为此改函数逻辑。注意 Python 里是 `True`（首字母大写，不带引号），键名区分大小写。
4. 保存，用 `curl localhost:6868/api/functions` 确认它在列表里，并核对返回里它的 `async` / `serializeCalls` 字段和你声明的一致（服务日志里也会有 `[functions] 已加载 <路径>` 一行）。**没出现在列表里**时先看服务日志：语法错误、定义不合法（缺 `inputs`、`run` 不是函数等）、`id` 重复都会在日志里报错，只影响这一个函数。
5. 用 curl 调一次试试（见最后的“本地怎么测”），再去面板里点运行。

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
├── 示例/无输出/log_rows/       无输出函数示例：「示例 / 无输出」是两层分类目录，log_rows 是函数文件夹
│   └── function.mjs
├── 示例/异步/slow_upper/       异步函数示例（JS，async: true，模拟耗时 15 秒）
├── 示例/异步/slow_len/         异步函数示例（Python，"async": True，模拟耗时 10 秒）
├── 示例/串行锁/locked_demo/    串行执行示例（同步，serializeCalls: true）
├── 示例/串行锁/locked_async_demo/   串行执行 + 异步示例
└── 示例/手动入参/manual_demo/  不来自字段的入参示例（单选 / 多选 / 文本）
```

（服务端支撑这两个开关的代码在上一级目录：`../jobs.mjs` 是异步任务存储，`../locks.mjs` 是串行锁，加函数时不用动它们。）

**什么放根目录的 `_xxx` 公共模块，什么放函数文件夹里**：只有一个函数用的（客户端、数据文件、辅助模块），放进它自己的文件夹；多个函数共用的（凭证读取 `_config`、资产 ID 检查 `_asset_id`），放在 `functions/` 根目录，以 `_` 开头。

## 函数的定义

无论 JS 还是 Python，都由下面几部分组成：

| 部分 | 说明 |
| --- | --- |
| `id` | 全局唯一标识。重复的会被忽略，日志里会报警。**可以省略，省略就用文件夹名** |
| `name` | 面板里显示的函数名。可以省略，省略就用 `id` |
| `inputs` | 入参列表 `[{name, label}]`。`name` 是参数名；面板里每个函数卡片各自映射入参到字段（同名参数在不同函数里互不影响，新加函数时会自动沿用别处配好的同名参数的字段，之后可单独改）。入参也可以**不来自字段**，而是在卡片里直接选 / 填（单选、多选、文本），见下面“不来自字段的入参”一节 |
| `outputs` | 出参列表 `[{name, label, requires?}]`。`requires` 是产出该出参需要的入参名数组，缺省为本函数的全部入参。用户选了某个出参后，面板会自动把它 `requires` 的入参补成该函数卡片里的输入行（标「必需」，只差字段要选）。**可以不写或写空数组**：这就是只调用、不写表格的函数（发通知、触发任务等），`run` 每项返回 `{}` 即可。出参还可以写 `type: 'detail'`，把它声明成**执行详情**（不写进字段、面板直接展示），见下面“执行详情”一节 |
| `async` | 可选，默认不写（= 同步）。`true` 表示异步函数：耗时很久，面板下发完就算完成，服务端后台执行，完成后插件取回结果写回。见下面“异步函数”一节 |
| `serializeCalls` | 可选，默认不写（= 不限制）。`true` 表示串行执行：这个函数同一时间最多只有一个 `run` 在跑（不管来自哪次运行、是同步的一批还是异步的一个任务），按到达先后排队。见下面“串行执行”一节 |
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

## 不来自字段的入参（单选 / 多选 / 文本）

有些入参不是每行不同的数据，而是**一次运行的设置**（模式、语言、阈值、提示词……），不该去表格里找一个字段。给这种入参写上 `type`，面板的函数卡片里这一行箭头右边就不再是字段下拉，而是按 `type` 显示的值选择框 / 输入框：

| `type` | 面板里右边是 | `run` 里每行拿到 | 必须写 |
| --- | --- | --- | --- |
| 不写（或 `'field'`） | 字段下拉（原来的方式） | 那一格的文本 | — |
| `'select'` | 单选下拉 | 选中的值（字符串） | `options` |
| `'multiSelect'` | 多选下拉框（点开是勾选列表，可多选） | 勾选的值组成的**数组**（按 `options` 的顺序） | `options` |
| `'text'` | 文本输入框 | 填的文字（字符串） | — |

这些入参可以额外写（字段入参也可以写 `description`）：

| 键 | 说明 |
| --- | --- |
| `options` | 可选值。`['a', 'b']`，或 `[{ value: 'a', label: '显示名' }]`（`value` 传给 `run`，`label` 显示在面板里）。`select` / `multiSelect` 必须写，且不能为空 |
| `default` | 面板里的初始值：`select` 写一个 `options` 里的值，`multiSelect` 写这些值组成的数组，`text` 写字符串。不写就是空，等用户自己选 / 填 |
| `description` | 给填写的人看的说明，显示在这一行输入下面（也是参数下拉的悬停提示）。**建议都写**：这种入参的含义只能靠它说明 |

```js
inputs: [
  { name: 'text', label: '文本' },                                       // 来自字段
  { name: 'mode', label: '大小写', type: 'select',
    options: [{ value: 'upper', label: '转大写' }, { value: 'lower', label: '转小写' }],
    default: 'upper', description: '对文本做的大小写转换' },
  { name: 'tags', label: '附加标记', type: 'multiSelect', options: ['长度', '首字母'], default: ['长度'] },
  { name: 'prefix', label: '前缀', type: 'text', default: '>> ', description: '加在结果最前面的文字' },
],
```

Python 一样写在 `META["inputs"]` 里（`"type": "multiSelect"` 这类键名、值都区分大小写）。完整示例见 `示例/手动入参/manual_demo`。

- **整次运行每一行都是同一个值**：面板把卡片里填的值放进每一行的 `row` 里，`run` 的写法和字段入参没有区别（多选拿到的是数组，别当字符串处理）。
- **必需 / 可选的规则和字段入参一样**（由 `outputs` 的 `requires` 决定）；必需的输入行会自动出现在卡片里并填上 `default`。运行前面板会检查：单选要选了值，多选至少勾一个，文本不能为空；选的值不在 `options` 里（函数改了可选值）也会被拦住，让用户重新选。想让它可以不填，就别让它成为必需入参，用户不需要时可以删掉这一行（这时 `row` 里没有这个键）。
- 声明不合法（`type` 写错、`select` / `multiSelect` 没写 `options`、`default` 不在 `options` 里）时，这个函数不会注册，服务日志里会写明是哪个入参、哪里不对。
- 用 curl 直接调 `/run`、`/jobs` 时，请求里没带的这类入参，服务端会用 `default` 补上（没有 `default` 就不补）。

## `run(rows)` 的约定（最重要）

**入参**：`rows` 是 `[{入参名: 值}, ...]`。
- 值已经被面板转成**文本**（单元格里的内容拍平成字符串），没有映射到字段的入参不会出现在 `row` 里。**不来自字段的入参**（`type` 为 `select` / `multiSelect` / `text`）每行都是卡片里填的同一个值，`multiSelect` 是字符串数组。
- `run` 每次最多拿到 `batchSize` 行（默认 100）；不足一批时直接按剩下的行数调用，不会等凑够，所以不要假设行数固定。同一批的行请合并成一次下游请求（查接口、跑模型），不要一行一次，这是做成批量接口的意义。
- **适配层在面板（前端）**：面板写回表格固定每 100 条提交一次；调用函数时按函数的 `batchSize` 攒批或拆分——一轮取选中的函数里最大的批大小那么多条记录，批大小大于 100 的函数把几个 100 攒成一次调用（500 = 攒 5 个 100），小于 100 的拆成几次；一轮算完，结果再按 100 条一批写回。服务端只负责把 `batchSize` 告诉面板，`/run` 接口收到多少行就一次交给函数多少行。
- 取消按钮在当前这一轮处理完后生效，所以 `batchSize` 越大，点取消后等得越久；一轮的结果要算完才开始写回。
- 用 curl 直接调用 `/run` 时，传多少行函数就一次拿到多少行，不会按 `batchSize` 拆分。

**返回值**：必须是**与 `rows` 等长、顺序一致**的数组，每一项是 `{出参名: 值}`。长度对不上整批报错。（也可以返回 `{results: 这个数组, detail: '这一批的详情'}`，见“执行详情”一节。）

**某一行失败**：在那个位置返回一个错误对象，只让这一行失败，其他行照常写入，失败原因会出现在面板的失败明细里。
- JS：`return new Error('原因')`
- Python：`ValueError('原因')`（返回，不是 raise）

**没有输出的函数**：`outputs` 为空时，`run` 每项返回 `{}`（或 `None`）表示这一行成功，返回错误对象表示这一行失败；面板里添加这个函数（点函数右侧的 ＋ ）就行，不用选字段，运行后统计「已调用 N 条」。

**整批失败**：`run` 里直接抛异常（JS `throw` / Python `raise`），整批失败，运行中断，并提示原因。适合下游服务整个不可用这类系统性错误。

**某个出参这一行没有值、不想覆盖字段**：把它设为 `null`（JS）/ `None`（Python），该字段保留原值；一行里所有出参都是空，则整行跳过。注意 JS 里必须是 `null`，不能是 `undefined`（JSON 会丢掉 undefined，会被当成没返回）。

## 执行详情（给人看的文本）

有的函数除了返回值，还想告诉使用者“这次执行得怎么样”（命中缓存、重试了几次、哪些行被截断、整批的统计……）。这类文本用**执行详情**返回，面板拿到后直接展示，不用写进表格。有两种粒度，可以单独用，也可以一起用：

**每行一条**：在 `outputs` 里加一个 `type: 'detail'` 的出参（每个函数最多一个），`run` 在每项里返回它：

```python
"outputs": [
    {"name": "length", "label": "长度"},
    {"name": "report", "label": "执行详情", "type": "detail"},
]
# run 的每项：{"length": 23, "report": "文本较长，已截断"}；这一行没有可说的就返回 None（或不写这个键）
```

**每批一条**：`run` 不返回列表，改返回 `{results: [...与 rows 等长...], detail: '这一批的整体说明'}`（Python 是 `{"results": [...], "detail": "..."}`）。`results` 的约定和原来的返回值完全一样。不需要的函数继续返回列表就行。

规则：
- 执行详情是**纯文本**（面板按文本显示，保留换行，不解析 HTML），单条最多 2 万字，超出会被截断。返回值不是字符串会被转成字符串。
- 执行详情出参**不会**出现在面板的“＋输出”里，也不用映射字段；函数只要被加到面板，每次调用都会收集。没有详情（`None` / 空串 / 不返回）就什么都不显示。失败的行请用错误对象，原因本来就会展示，不用再写详情。
- **面板怎么展示**：详情收进「函数」块右上角的「历史」里，按「批次 → 函数 → 每次调用」分层；有详情的那一次调用行尾有「详情」按钮，点击弹出悬浮窗查看（可复制）。有新的结果时，「历史」按钮上会亮一个结果颜色的状态点引导点击（点开历史后消失），不会自动弹窗。每行的详情标注了记录在视图里的序号；所有行详情一样时只显示一次。异步函数要等插件取回结果写回表格时才有。同步调用的记录和详情保存在浏览器本地（每张表最近 200 条），异步任务的详情随任务存在服务端。
- 说明所有能运行该函数的人都看得到，**不要写凭证、内部地址等敏感信息**。
- 旧版面板（不认识 `type: 'detail'`）会把它当成普通出参，用户可以把它写进文本字段，不会报错。
- 示例：`示例/执行详情/function.py`。

## 异步函数（耗时很久的函数）

默认的函数是**同步**的：面板调用 `run`、等结果、再写回表格，一批要几分钟以上就不合适了。耗时很久的函数可以声明成**异步函数**：

- JS：定义里加 `async: true`；Python：`META` 里加 `"async": True`。**`run(rows)` 的写法、返回值、出参格式、失败行的写法都和普通函数完全一样**，不用改函数逻辑。
- 面板里选函数、映射入参、选输出字段的方式也一样。点「运行」后，面板只负责把数据**下发**给服务端，下发完这一步就算完成（状态区显示“已下发 N 条”）；函数在服务端后台执行。
- 函数跑完后，**打开着这张表的插件页面**会自动取回结果，按你映射的字段写回表格（和同步函数一样覆盖写入，格式要求见下面“出参值的格式”）。函数名右边有「异步」标记；执行情况在「函数」块右上角的「历史」里：按「批次（一次点运行）→ 函数 → 任务（按函数的 `batchSize` 拆出来的每一段）」分层，每个任务写明第几个 / 共几个、对应哪几条记录和当前状态，失败明细折叠在函数下，不占面板版面（按钮右上角的状态点：红 = 有失败，橙 = 执行中，绿 = 全部完成）。
- 不用异步的函数完全不受影响：服务端不会为它们保存任何东西。

注意：
- **回写需要插件页面开着**。任务跑完时如果没人打开这张表的插件，结果会先存在服务端（默认保留 7 天），下次有人打开插件时自动补写。
- 任务和结果存在 `release/server/data/jobs/`（环境变量 `JOBS_DIR` 可改），**服务重启时还没跑完的任务会被标记为失败（“服务重启，任务中断，请重新运行”）**，不会自动续跑。已回写 / 已取消的任务保留 1 天后清理。
- 服务端同时最多跑 4 个异步任务（环境变量 `ASYNC_MAX_RUNNING` 可调），其余排队。一个任务对应面板按函数 `batchSize` 切出来的一批行。
- Python 异步函数单批的超时默认 4 小时（环境变量 `PY_ASYNC_TIMEOUT_MS` 可调）；普通 Python 函数仍是 5 分钟。
- 已经开始运行的任务无法中断：面板里点取消，只是这个任务的结果不会再写回。
- 失败的行（返回 Error 的行、整批失败）在回写时汇报到面板的「异步失败明细」，存在浏览器本地，可以复制 / 导出 CSV。
- 示例：`示例/异步/slow_upper`（JS）、`示例/异步/slow_len`（Python）。

接口（给面板用，一般不需要直接调）：`POST /api/functions/<id>/jobs` 下发；`GET /api/jobs?scope=` 列任务；`POST /api/jobs/<id>/claim | ack | release | cancel`。

## 串行执行（`serializeCalls`）

函数里有多步操作、两次执行不能交错时（比如每一批都要读取—判断—写入同一份外部数据，同时跑两批会互相踩），在函数定义里声明 `serializeCalls: true`（Python 在 `META` 里写 `"serializeCalls": True`）。旧名字 `serializeRuns` 仍然有效，含义完全相同，已有的函数不用改；新写的函数请用 `serializeCalls`。

- **同一时间最多一个 `run` 在跑**：不管调用来自哪次运行（一次点「运行」= 一个运行）、哪个人，也不管是同步函数的一批还是异步函数的一个任务，上一次 `run` 返回了，下一次才开始。每一次 `run` 都是原子的，不会和这个函数的另一次执行交错。
- **按到达先后排队**：锁只在 `run` 执行期间占着，执行完立刻交给最早排队的那个。轮不到的同步调用在面板状态栏提示“正在排队等待其他调用完成…”，可以点取消。
- **不同运行的批次可以交替执行**：两个人同时运行，执行顺序可能是 A 的第 1 批、B 的第 1 批、A 的第 2 批……任何两批都不会同时在跑，但**一次运行的各批之间可能插进别的运行的批**。如果你需要的是“一整次运行做完，别人才能进来”，就要让那一次运行只有一批（调大 `batchSize`，最大 5000），或者在函数自己的逻辑里处理。
- **代价是变慢**：同一函数的各批不再并行，异步任务也要一个跑完再跑下一个。一批的固定开销大（每次都要建连接、登录、加载模型）的话，可以适当调大 `batchSize`，减少批数。
- 和 `async: true` 可以一起用：这个函数的任务一个接一个跑；排队的任务留在队列里，不占服务端的并发槽位，也不会挡住别的函数的任务。
- 只对声明了 `serializeCalls` 的函数生效；不声明的函数完全不受影响（并行照旧）。函数之间的锁互相独立，不跨函数。

注意：
- 同步函数排队时，服务端一次请求最多等 `LOCK_WAIT_MS`（默认 25 秒）就回“还在排队”，面板自动重试，所以不会被网关的超时掐断；面板的第一次请求只等 1.5 秒，所以排队的人很快就能在状态栏看到“正在排队”的提示；排队时关掉页面，会自动退出排队。
- 锁只在 `run` 执行期间占着，执行完（返回、抛异常都算）就放开，页面关了、运行中断都不会让锁卡住，不需要通知服务端“运行结束”。
- 锁只在单个服务进程内有效（目前的部署就是一个进程）；服务重启锁就清零。如果以后部署成多个实例，需要换成外部的锁（Redis 或数据库）。
- 函数的 `run` 里不要再去调用自己（或等这个函数的另一次执行的结果），会死等。
- 示例：`示例/串行锁/locked_demo`（同步）、`示例/串行锁/locked_async_demo`（异步），都把每批的开始 / 结束时间作为输出，方便核对各批之间有没有交错。

## 出参值的格式

面板按目标字段的类型把返回值写进表格，**函数要直接返回该类型的原生形态**，基本不做宽松转换（不解析日期字符串、不拆分隔符），类型不对只会让这一行失败。只有下面几种没有歧义的转换由面板代劳：任意类型写文本字段 → 转成字符串（数字、布尔值用 `String`，数组 / 对象写成 JSON 字符串）；布尔值写单选字段 → 当作名为 `true` / `false` 的选项名（选项要已存在）；字符串 `"true"` / `"false"`（不分大小写）写复选框 → 转成布尔值。

| 目标字段类型 | 函数返回 |
| --- | --- |
| 文本 | 任意类型：字符串原样写，数字 / 布尔值转成字符串，数组 / 对象写成 JSON 字符串 |
| 数字 / 货币 / 进度 / 评分 | 数字 |
| 单选 | 选项名（字符串；布尔值当作 "true" / "false" 选项名）。选项必须已存在，不会自动新增 |
| 多选 | 选项名数组，如 `["紧急", "普通"]` |
| 日期 | 毫秒时间戳（数字） |
| 复选框 | `true` / `false`（字符串 "true" / "false" 也行） |
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
| `PY_RUN_TIMEOUT_MS` | Python 同步函数单批执行超时（毫秒） | 300000（5 分钟） |
| `PY_ASYNC_TIMEOUT_MS` | Python 异步函数（`async`）单批执行超时（毫秒） | 14400000（4 小时） |
| `ASYNC_MAX_RUNNING` | 服务端同时执行的异步任务数，其余排队 | 4 |
| `JOBS_DIR` | 异步任务和结果落盘的目录 | `release/server/data/jobs`（运行时自动创建，不入库） |
| `LOCK_WAIT_MS` | `serializeCalls` 函数的同步调用排队时，一次请求最多等多久就回“还在排队”（面板自动重试） | 25000 |
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

**异步函数**（`async: true`）用 `/run` 调也能直接同步执行（调试时方便，结果当场返回，不走任务存储）；要测它**作为异步任务**的行为，用 `/jobs` 下发任务、轮询、取结果：

```bash
# 1. 下发：scope 是任意字符串（插件用“多维表格 ID/数据表 ID”）；meta 随便放，取结果时原样还给你
curl -X POST localhost:6868/api/functions/slow_len/jobs -H "Content-Type: application/json"   -d '{"rows":[{"text":"hello"}],"scope":"test","meta":{}}'
# 返回：{"job":{"id":"<任务 id>","status":"queued"或"running",...}}

# 2. 轮询：status 依次是 queued → running → done（或 failed）
curl "localhost:6868/api/jobs?scope=test"

# 3. 取结果（状态为 done / failed 时）：返回 results 和一个 token
curl -X POST localhost:6868/api/jobs/<任务 id>/claim -H "Content-Type: application/json" -d '{"scope":"test"}'

# 4. 确认已处理（不确认的话认领 5 分钟后失效，别人可以再认领）
curl -X POST localhost:6868/api/jobs/<任务 id>/ack -H "Content-Type: application/json" -d '{"token":"<上一步的 token>","result":"ok"}'
```

**`serializeCalls` 函数**用 `/run` 调时，同时发出的几次调用会一个接一个执行，按到达先后排队；不需要带运行 ID，也不需要在结束时通知服务端。

> ⚠️ 排队中的请求最多等 `LOCK_WAIT_MS`（默认 25 秒）就回 `{"waiting": true}`（HTTP 202），**调用方要自己重试**（面板自动重试；手写脚本里别把它当成失败或结果）。

可以用示例 `locked_demo`（每批耗时 1.5 秒）试：它把每批的开始 / 结束时间（毫秒时间戳）作为输出，核对各批有没有交错。例如：模拟两个运行 A、B 同时开始，各自一批接一批地调两次，应该看到四批一个接一个执行、互不重叠（A、B 的批次可能交替出现）：

```python
import json, urllib.request, threading
B = 'http://127.0.0.1:6868'                      # Windows 上用 localhost 每次连接可能多等约 2 秒（先试 IPv6），会让时间看起来有空档

def post(path, body):
    req = urllib.request.Request(B + path, json.dumps(body).encode(), {'Content-Type': 'application/json'}, method='POST')
    r = urllib.request.urlopen(req, timeout=60)
    return json.loads(r.read())

def run(tag, out):                               # 一个“运行”：像面板一样，一批返回了再发下一批
    for i in range(2):
        while True:
            d = post('/api/functions/locked_demo/run', {'rows': [{'text': 'x'}]})
            if d.get('waiting'): continue        # 202：还在排队，重试
            o = d['results'][0]['outputs']; out.append((tag + str(i), o['started'], o['ended'])); break

res = []
ts = [threading.Thread(target=run, args=(t, res)) for t in 'AB']
[t.start() for t in ts]; [t.join() for t in ts]
for r in sorted(res, key=lambda x: x[1]): print(r)
```

> 在 Windows 的 Git Bash 里用 curl 传中文，终端编码可能让中文乱码，这是 shell 的问题，不是服务的问题；要测中文可以用 Python 的 `urllib` 发请求。

## 加一个新函数的清单

1. 复制 `_template/` 整个文件夹，改成函数名（**不要**以下划线开头），放到 `functions/` 下想要的分类目录里（要新分类就新建一层文件夹）；`function.mjs` 和 `function.py` 留一个，另一个删掉。
2. 定好 `inputs`、`outputs`（需要时写 `requires`）；`id`、`name` 不写就用文件夹名。入参是“一次运行的设置”而不是每行的数据时，写成 `select` / `multiSelect` / `text`，并写上 `description`（见“不来自字段的入参”）。
3. 实现 `run(rows)`：批量处理，返回等长数组；单行失败返回错误对象；没有值返回 `null`/`None`。
4. 出参值按上面的表格给目标字段类型的原生形态。
5. 这个函数依赖的其他文件（模块、数据）放进同一个文件夹；多个函数共用的才放根目录的 `_xxx`。
6. **判断要不要开关**（按上面“30 秒上手”里的表）：一批要跑很久就加 `async`；两次执行不能交错（多步操作会互相踩）就加 `serializeCalls`；都不是就什么都不加。
7. 保存。看服务日志里有没有 `[functions] 已加载 <路径>` 一行；用 `curl localhost:6868/api/functions` 确认它出现在列表里，`path` 是它所在的分类目录，`async` / `serializeCalls` 和你声明的一致。
8. 用 `curl` 调一次，确认结果等长、格式对，再去面板里试（异步函数的 curl 测法见“本地怎么测”）。
