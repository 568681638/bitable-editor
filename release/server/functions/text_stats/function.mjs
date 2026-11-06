export default {
  id: 'text_stats',
  name: '文本统计',
  inputs: [{ name: 'text', label: '文本' }],
  outputs: [
    { name: 'length', label: '字数' },
    { name: 'lines', label: '行数' },
  ],
  async run(rows) {
    return rows.map((row) => {
      const s = String(row.text == null ? '' : row.text);
      return { length: s.length, lines: s ? s.split(/\r?\n/).length : 0 };
    });
  },
};
