// 串行锁示例（异步函数）：serializeCalls: true 和 async: true 可以一起用。
// 这个函数的任务一个跑完再跑下一个（不管来自哪次运行），按下发的先后排队。
// 排队的任务留在队列里，不占服务端的并发槽位。
export default {
  name: '串行锁示例：异步任务起止时间',
  serializeCalls: true,
  async: true,
  inputs: [{ name: 'text', label: '文本' }],
  outputs: [{ name: 'started', label: '开始时间' }, { name: 'ended', label: '结束时间' }],
  batchSize: 10,
  async run(rows) {
    const started = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const ended = Date.now();
    return rows.map(() => ({ started, ended }));
  },
};
