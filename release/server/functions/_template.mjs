// 自动刷写函数模板：复制本文件、改名（不要以下划线开头）、改内容，保存即生效，不用重启服务。
// 以下划线开头的文件会被忽略。一个文件可以 export default 一个函数定义，也可以 export default 一个数组放多个。
//
//   id        唯一标识（全局不能重复，重复的会被忽略并在日志里报警）
//   name      面板里显示的函数名
//   inputs    入参 [{ name, label }]
//             name 是全局参数名：不同函数里同名的入参视为同一个参数，面板里只需映射一次字段
//   outputs   出参 [{ name, label, requires? }]
//             requires 是产出该出参需要的入参名数组，缺省为本函数的全部入参；
//             面板选了这个出参后，会自动把 requires 里的入参补进“输入”区
//   run       async (rows) => 结果数组（批量计算）
//             rows 是 [{ 入参名: 值 }, ...]（值已被面板转成文本，没映射到字段的入参不会出现）；
//             必须返回与 rows 等长、顺序一致的数组，每项是 { 出参名: 值 }（数字字段会把值转成数字）。
//             某一行算不出来：这一项返回一个 Error 对象（如 new Error('原因')），只让这一行失败；
//             某个出参这一行没有值、不想写入该字段：把它设为 null（不是 undefined），字段会保留原值（全部出参都是 null 则跳过这一行）。
//             run 里直接 throw 则整批失败，刷写会中断。
//             返回值要直接是目标字段类型的原生形态（数字给数字、单选给选项名、日期给毫秒时间戳、复选框给 true/false 等，不做宽松转换），详见 release/README.md。
//             一次拿到多行，可以把查询、模型推理等合并成一次请求。
//
// 注意：服务端要兼容 Node 14，不要用 ??= / ||= / replaceAll / .at() 等较新的写法。
export default {
  id: 'example',
  name: '示例函数',
  inputs: [{ name: 'text', label: '文本' }],
  outputs: [{ name: 'upper', label: '大写' }],
  async run(rows) {
    return rows.map((row) => ({ upper: String(row.text).toUpperCase() }));
  },
};
