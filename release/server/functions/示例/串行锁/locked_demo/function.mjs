// 串行锁示例（同步函数）：声明 serializeCalls: true 后，这个函数同一时间最多只执行一次 run。
//   · 不管调用来自哪次运行（不同的人 / 多次同时点运行）、是同一次运行拆出的第几批，都按到达先后一个接一个执行，轮不到的在面板状态栏显示“排队…”；
//   · 不同运行的批次可能交替执行，但任何两批都不会同时在跑。
// 适合函数里有多步操作、两次执行不能交错的情况（比如每一批都要读取—判断—写入同一份外部数据）。
// 这里用等待模拟耗时，并把每批的开始 / 结束时间（毫秒时间戳）作为输出，方便肉眼核对各批之间有没有交错。
export default {
  name: '串行锁示例：记录批次起止时间',
  serializeCalls: true,
  inputs: [{ name: 'text', label: '文本' }],
  outputs: [{ name: 'started', label: '开始时间' }, { name: 'ended', label: '结束时间' }],
  batchSize: 10,
  async run(rows) {
    const started = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const ended = Date.now();
    return rows.map(() => ({ started, ended }));
  },
};
