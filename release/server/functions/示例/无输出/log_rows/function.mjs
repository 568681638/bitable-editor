// 无输出函数示例：只调用、不往表格写值。把收到的行打到服务日志里，文本为空的行判失败。
// 没有 outputs，面板里点函数右侧的 ＋ 添加这个函数就行（不用选字段）。batchSize: 500 用来演示面板的攒批：
// 面板把 5 个 100 条攒成一次调用，日志里能看到“收到 500 行”。
export default {
  id: 'log_rows',
  name: '记录到服务日志（无输出示例）',
  inputs: [{ name: 'text', label: '文本' }],
  batchSize: 500,
  async run(rows) {
    console.log('[log_rows] 收到 ' + rows.length + ' 行，首行：' + JSON.stringify(rows[0]));
    return rows.map((row) => (String(row.text == null ? '' : row.text).trim() ? {} : new Error('文本为空')));
  },
};
