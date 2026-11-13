// 不来自字段的入参示例：text 来自字段（每行不同）；mode / tags / prefix 在面板的函数卡片里直接选 / 填（整次运行每行都一样）
export default {
  id: 'manual_demo',
  name: '手动入参示例',
  inputs: [
    { name: 'text', label: '文本' }, // 不写 type：映射到字段，和以前一样
    {
      name: 'mode', label: '大小写', type: 'select',
      options: [{ value: 'upper', label: '转大写' }, { value: 'lower', label: '转小写' }, { value: 'keep', label: '不变' }],
      default: 'upper',
      description: '对文本做的大小写转换',
    },
    {
      name: 'tags', label: '附加标记', type: 'multiSelect',
      options: ['长度', '首字母'],
      default: ['长度'],
      description: '在结果后面附加哪些信息（可多选，run 拿到的是数组）',
    },
    { name: 'prefix', label: '前缀', type: 'text', default: '>> ', description: '加在结果最前面的文字' },
  ],
  outputs: [{ name: 'result', label: '结果' }],
  async run(rows) {
    return rows.map((row) => {
      const text = String(row.text || '');
      let out = row.mode === 'upper' ? text.toUpperCase() : row.mode === 'lower' ? text.toLowerCase() : text;
      const tags = Array.isArray(row.tags) ? row.tags : [];
      if (tags.indexOf('长度') >= 0) out += '（' + text.length + ' 字）';
      if (tags.indexOf('首字母') >= 0) out += '[' + text.charAt(0) + ']';
      return { result: row.prefix + out };
    });
  },
};
