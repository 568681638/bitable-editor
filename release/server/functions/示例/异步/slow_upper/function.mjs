// 异步函数示例（JS）：声明 async: true 后，面板下发完就算完成，函数在服务端后台执行，
// 跑完后结果由打开着的插件取走并写回表格。run 的写法和普通函数完全一样。
// 这里用等待模拟耗时很久的处理；某行文本是 bad 时让这一行失败，演示失败明细。
export default {
  name: '异步示例：转大写（慢）',
  async: true,
  inputs: [{ name: 'text', label: '文本' }],
  outputs: [{ name: 'upper', label: '大写' }],
  batchSize: 50,
  async run(rows) {
    await new Promise((resolve) => setTimeout(resolve, 15000));
    return rows.map((row) => (row.text === 'bad' ? new Error('示例：这一行故意失败') : { upper: String(row.text).toUpperCase() }));
  },
};
