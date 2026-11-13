// 函数的串行锁：声明了 serializeCalls: true 的函数，同一时间最多只执行一次 run（执行实例级别的原子化）。
//   · 不管调用来自哪个运行（一次点「运行」= 一个运行）、是同步的一批还是异步的一个任务，上一次 run 返回了，下一次才开始；
//   · 锁只在 run 执行期间占着，执行完立刻交给下一个，按到达的先后排队。不同运行的批次可以交替执行（A 的第 1 批、B 的第 1 批、A 的第 2 批……），
//     但任何两次 run 都不会同时在跑。
// 同步调用走 enter（排队等锁，可超时 / 取消，服务端到点回 202 让前端重试，免得请求挂太久被网关掐断）；
// 异步任务走 tryStart（任务调度器跳过拿不到锁的任务，排队的任务不占并发槽位）。两种调用执行完都要 leave。
// 同一个函数同时有同步调用和异步任务在等时（只有 curl 直接调异步函数的 /run 才会这样），先给同步调用。
// 只在单个服务进程内有效；服务重启锁就清零（在途的异步任务本来也会被标记为失败）。要兼容 Node 14。
export function createFnLocks() {
  const states = new Map(); // 函数 id → { busy, waiters: [按到达顺序排队的同步调用的 grant 回调] }
  const listeners = [];

  function stateOf(fnId) {
    let s = states.get(fnId);
    if (!s) { s = { busy: false, waiters: [] }; states.set(fnId, s); }
    return s;
  }
  function tidy(fnId, s) { if (!s.busy && s.waiters.length === 0) states.delete(fnId); }

  return {
    // 同步调用：排队等锁。返回 { promise, cancel }，promise 为 'ok'（拿到了，执行完要 leave）/ 'timeout'（等了 waitMs 还没轮到，已退出排队）/ 'cancelled'
    enter(fnId, waitMs) {
      const s = stateOf(fnId);
      let resolveFn;
      const promise = new Promise((resolve) => { resolveFn = resolve; });
      if (!s.busy && s.waiters.length === 0) { s.busy = true; resolveFn('ok'); return { promise, cancel: () => {} }; }
      let done = false;
      const grant = () => { done = true; clearTimeout(timer); resolveFn('ok'); }; // leave 时直接把锁交过来（busy 保持 true）
      const giveUp = (result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const i = s.waiters.indexOf(grant);
        if (i >= 0) s.waiters.splice(i, 1);
        resolveFn(result);
        tidy(fnId, s);
      };
      s.waiters.push(grant);
      const timer = setTimeout(() => giveUp('timeout'), waitMs);
      return { promise, cancel: () => giveUp('cancelled') };
    },
    // 任务调度器问：这个函数现在能开始执行一个任务吗；能就直接占上锁，跑完要 leave
    tryStart(fnId) {
      const s = stateOf(fnId);
      if (s.busy || s.waiters.length > 0) return false;
      s.busy = true;
      return true;
    },
    // 一次 run 执行完：有排队的同步调用就直接交给最早的那个，没有就放开，并通知任务调度器
    leave(fnId) {
      const s = states.get(fnId);
      if (!s) return;
      const next = s.waiters.shift();
      if (next) { next(); return; }
      s.busy = false;
      tidy(fnId, s);
      for (const cb of listeners) cb();
    },
    onChange(cb) { listeners.push(cb); },
    // 调试 / 状态查看：每个函数有没有 run 在执行、几个同步调用在排队
    snapshot() {
      return [...states].map(([fnId, s]) => ({ fnId, busy: s.busy, waiting: s.waiters.length }));
    },
  };
}
