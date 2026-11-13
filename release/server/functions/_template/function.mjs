// 批处理函数模板：复制整个 _template 文件夹，改成函数名（不要以下划线开头），入口文件保持叫 function.mjs，改内容，保存即生效，不用重启服务。
// 一个函数 = 一个文件夹：入口文件 function.mjs（Python 是 function.py）+ 它依赖的其他文件（模块、数据、配置）都放在这个文件夹里。
// 文件夹可以放在 functions/ 的任意分类目录下（不含入口文件的文件夹就是分类目录，可多层），面板里选函数时的层级和目录结构一致。
// 以下划线或点开头的文件 / 目录会被忽略。入口文件可以 export default 一个函数定义，也可以 export default 一个数组放多个。
// 读自己文件夹里的数据文件：用 new URL('./data.json', import.meta.url)（服务的工作目录不是函数文件夹）。
//
//   id        唯一标识（全局不能重复，重复的会被忽略并在日志里报警）；可以省略，省略就用文件夹名
//   name      面板里显示的函数名；可以省略，省略就用 id
//   inputs    入参 [{ name, label }]
//             name 是参数名；面板里每个函数卡片各自把入参映射到字段（新加函数时会沿用别处配好的同名参数的字段，之后可单独改）
//             入参也可以不来自字段，在卡片里直接选 / 填（整次运行每行同一个值），加 type 即可：
//               { name, label, type: 'select',      options: ['a', 'b'] 或 [{ value, label }], default?: 'a',  description? }  → row 里是字符串
//               { name, label, type: 'multiSelect', options: [...],                          default?: ['a'], description? }  → row 里是字符串数组
//               { name, label, type: 'text',                                                default?: '',    description? }  → row 里是字符串
//             description 是给填写的人看的说明（显示在卡片里），建议都写；细节见 functions/README.md 的“不来自字段的入参”一节
//   outputs   出参 [{ name, label, requires? }]
//             requires 是产出该出参需要的入参名数组，缺省为本函数的全部入参；
//             面板选了这个出参后，会自动把 requires 里的入参补成该函数卡片里的输入行（标“必需”）
//             outputs 可以不写 / 写 []：只调用、不往表格写值的函数（发通知、触发任务等），面板里直接选这个函数即可，不用选输出字段
//   batchSize 可选。run 每次最多拿到多少行（最后一批可能不足），默认 100，范围 1 ~ 5000。面板读取 / 写回表格固定每 100 条一批，
//             调用函数时由面板按这个数攒批或拆分（比如 500 = 攒 5 个 100 一次调用）。
//             下游一次能处理很多（本地查表、纯计算）可以调大；下游慢、限流、单次耗时长（调模型）就调小
//   —— 下面两个开关都是可选的：都不写就是最普通的同步函数。run 的写法、返回值、出参格式完全不受影响，只改变函数怎么被调度 ——
//   async     可选，默认不写（同步）。true 表示异步函数：一批要跑很久（几分钟到几小时）时用。面板下发完就算完成，函数在服务端后台执行，
//             跑完后由打开着这张表的插件取回结果并写回字段；细节见 functions/README.md 的“异步函数”一节
//   serializeCalls 可选，默认不写（不限制）。true 表示串行执行：这个函数同一时间最多只有一个 run 在跑（不管来自哪次运行、是同步的一批还是异步的一个任务），按到达先后排队。
//             函数里有多步操作、两次执行不能交错时用（多人同时点运行、同一运行的多批同时跑都会互相踩）；细节见 functions/README.md 的“串行执行”一节
//             两个开关可以一起用：async: true, serializeCalls: true
//   run       async (rows) => 结果数组（批量计算）
//             rows 是 [{ 入参名: 值 }, ...]（值已被面板转成文本，没映射到字段的入参不会出现）；
//             必须返回与 rows 等长、顺序一致的数组，每项是 { 出参名: 值 }（数字字段会把值转成数字）。
//             某一行算不出来：这一项返回一个 Error 对象（如 new Error('原因')），只让这一行失败；
//             某个出参这一行没有值、不想写入该字段：把它设为 null（不是 undefined），字段会保留原值（全部出参都是 null 则跳过这一行）。
//             run 里直接 throw 则整批失败，运行会中断。没有输出的函数，每项返回 {} 即可。
//             返回值要直接是目标字段类型的原生形态（数字给数字、单选给选项名、日期给毫秒时间戳、复选框给 true/false 等，不做宽松转换），详见 functions/README.md 的“出参值的格式”一节。
//             一次拿到多行，可以把查询、模型推理等合并成一次请求。
//
// 注意：服务端要兼容 Node 14，不要用 ??= / ||= / replaceAll / .at() 等较新的写法。
export default {
  id: 'example',
  name: '示例函数',
  inputs: [{ name: 'text', label: '文本' }],
  outputs: [{ name: 'upper', label: '大写' }],
  // 执行详情（可选）：outputs 里加 { name: 'report', label: '执行详情', type: 'detail' }，run 每项里返回 report: '文本'（没有就 null）；
  // 或者 run 不返回数组，改返回 { results: [...], detail: '这一批的整体详情' }。面板会收集并在「历史」里展示，见 README“执行详情”
  // batchSize: 100, // 可选：每次调用传多少行，默认 100
  // async: true,          // 可选：异步函数（一批要跑很久时）
  // serializeCalls: true,  // 可选：串行执行（同一时间最多一个 run 在跑，多步操作不能交错时）
  async run(rows) {
    return rows.map((row) => ({ upper: String(row.text).toUpperCase() }));
  },
};
