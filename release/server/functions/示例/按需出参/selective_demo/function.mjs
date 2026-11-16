// 按需计算出参示例：run 的第二个参数 ctx.outputs 是这次前端要回写的出参名，只算被选中的出参（没选的不算也不用返回）。
// 入参 salt 只有选了 slow_hash 才是必需的（出参的 requires）：只选 upper / length 时面板里它是「可选」，row 里可能没有 salt。
// slow_hash 故意算得很慢，用来看出“只选 upper 时它不会被执行”；每批实际算了哪些出参写进执行详情
import { createHash } from 'crypto';

function slowHash(text) {
  let h = text;
  for (let i = 0; i < 20000; i++) h = createHash('sha256').update(h).digest('hex');
  return h.slice(0, 16);
}

export default {
  id: 'selective_demo',
  name: '按需出参示例',
  inputs: [
    { name: 'text', label: '文本' },
    { name: 'salt', label: '盐（慢哈希用）' },
  ],
  outputs: [
    { name: 'upper', label: '大写', requires: ['text'] },
    { name: 'length', label: '长度', requires: ['text'] },
    { name: 'slow_hash', label: '慢哈希（开销大）', requires: ['text', 'salt'] },
    { name: 'report', label: '执行详情', type: 'detail' },
  ],
  async run(rows, ctx) {
    const want = new Set(ctx.outputs);
    const results = rows.map((row) => {
      const text = String(row.text || '');
      const o = {};
      if (want.has('upper')) o.upper = text.toUpperCase();
      if (want.has('length')) o.length = text.length;
      if (want.has('slow_hash')) o.slow_hash = slowHash(String(row.salt || '') + text); // salt 只有选了 slow_hash 才保证有
      return o;
    });
    return { results, detail: '本批实际计算的出参：' + (ctx.outputs.filter(n => n !== 'report').join('、') || '（无）') };
  },
};
