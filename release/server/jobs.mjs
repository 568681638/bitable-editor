// 异步函数的任务存储。只有声明了 async: true 的函数才会用到，普通函数的调用不经过这里、也不落盘。
//
// 流程：插件下发一批行 → 创建任务（立刻返回任务 ID）→ 服务端后台执行函数 → 结果存在磁盘上 →
// 插件开着的时候取走结果（认领），用前端 SDK 写回表格，再确认（ack）。
//   queued → running → done / failed → applied（已回写）
//   任意未完成状态可以 cancelled（已开始的任务无法中断，跑完的结果会被丢弃）
// 任务按 scope（多维表格 ID / 数据表 ID）归属，插件只会看到并认领自己当前这张表的任务。
// 要兼容 Node 14：不用 ||= / ??= / replaceAll / Array.prototype.at / structuredClone。
import { randomBytes } from 'crypto';
import { mkdir, readdir, readFile, writeFile, rename, unlink } from 'fs/promises';
import { join } from 'path';

const MAX_RUNNING = Number(process.env.ASYNC_MAX_RUNNING) || 4; // 同时在跑的异步任务数，其余排队
const CLAIM_TTL = 5 * 60 * 1000; // 认领后超过这么久还没确认，视为那边挂了，别人可以重新认领
const KEEP_FINISHED = 24 * 3600 * 1000; // 已回写 / 已取消的任务保留多久
const KEEP_PENDING = 7 * 24 * 3600 * 1000; // 已完成但一直没人回写的任务保留多久
const SWEEP_EVERY = 3600 * 1000;

const now = () => Date.now();
const errText = (e) => (e instanceof Error ? e.message : String(e));

export function createJobStore(dir) {
  const jobs = new Map(); // id → 任务（落盘的内容）
  const rowsOf = new Map(); // id → 下发的行（只在内存里，任务开始执行后就释放）
  const execOf = new Map(); // id → 执行函数
  const saving = new Map(); // id → 上一次写盘的 promise，同一个任务的写盘按顺序来
  const queue = [];
  let running = 0;

  const fileOf = (id) => join(dir, id + '.json');

  function save(job) {
    const prev = saving.get(job.id) || Promise.resolve();
    const next = prev.then(async () => {
      const tmp = fileOf(job.id) + '.tmp';
      await writeFile(tmp, JSON.stringify(job), 'utf8');
      await rename(tmp, fileOf(job.id)); // 先写临时文件再改名，进程中途退出也不会留下写了一半的文件
    }).catch((e) => console.error('[jobs] 保存任务失败 ' + job.id + ':', errText(e)));
    saving.set(job.id, next);
    return next;
  }

  async function remove(id) {
    jobs.delete(id);
    rowsOf.delete(id);
    execOf.delete(id);
    await (saving.get(id) || Promise.resolve());
    saving.delete(id);
    await unlink(fileOf(id)).catch(() => {});
  }

  // 摘要：列表接口用，不带结果和元数据
  function summary(j) {
    return {
      id: j.id, fnId: j.fnId, fnName: j.fnName, status: j.status, count: j.count,
      createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt, appliedAt: j.appliedAt,
      error: j.error, result: j.result, run: j.run, claimed: !!(j.claim && now() - j.claim.at < CLAIM_TTL),
    };
  }

  async function runOne(job) {
    const rows = rowsOf.get(job.id);
    const exec = execOf.get(job.id);
    rowsOf.delete(job.id);
    execOf.delete(job.id);
    job.status = 'running';
    job.startedAt = now();
    save(job);
    let results = null;
    let error = '';
    try { results = await exec(rows); } catch (e) { error = errText(e); }
    if (job.status === 'cancelled') return; // 运行期间被取消：结果丢弃
    job.finishedAt = now();
    if (error) { job.status = 'failed'; job.error = error; }
    else { job.status = 'done'; job.results = results; }
    await save(job);
  }

  function pump() {
    while (running < MAX_RUNNING && queue.length) {
      const id = queue.shift();
      const job = jobs.get(id);
      if (!job || job.status !== 'queued') continue;
      running++;
      runOne(job).catch((e) => console.error('[jobs] 执行出错 ' + id + ':', errText(e))).then(() => { running--; pump(); });
    }
  }

  return {
    async init() {
      await mkdir(dir, { recursive: true });
      for (const name of await readdir(dir)) {
        if (!name.endsWith('.json')) { if (name.endsWith('.tmp')) await unlink(join(dir, name)).catch(() => {}); continue; }
        try {
          const job = JSON.parse(await readFile(join(dir, name), 'utf8'));
          if (!job || typeof job.id !== 'string') continue;
          // 服务重启时还没跑完的任务没法接着跑（行没落盘，重跑还可能重复产生副作用）：标记失败，让插件如实告诉用户
          if (job.status === 'queued' || job.status === 'running') {
            job.status = 'failed';
            job.error = '服务重启，任务中断，请重新运行';
            job.finishedAt = now();
            await save(job);
          }
          jobs.set(job.id, job);
        } catch (e) { console.error('[jobs] 读取 ' + name + ' 失败:', errText(e)); }
      }
      await this.sweep();
      setInterval(() => { this.sweep().catch(() => {}); }, SWEEP_EVERY).unref();
      console.log('[jobs] 已加载 ' + jobs.size + ' 个异步任务（' + dir + '）');
    },

    // exec(rows) → 与 rows 等长的 [{ ok, outputs } | { ok: false, error }]，整批失败就抛异常
    create({ fnId, fnName, scope, rows, meta }, exec) {
      const id = randomBytes(12).toString('hex');
      const job = { id, fnId, fnName, scope, status: 'queued', count: rows.length, createdAt: now(), meta: meta === undefined ? null : meta, run: meta && typeof meta.run === 'object' ? meta.run : undefined, claim: null };
      jobs.set(id, job);
      rowsOf.set(id, rows);
      execOf.set(id, exec);
      queue.push(id);
      save(job);
      pump();
      return summary(job);
    },

    list(scope) {
      return [...jobs.values()].filter(j => j.scope === scope).sort((a, b) => a.createdAt - b.createdAt).map(summary);
    },

    get(id) { const j = jobs.get(id); return j ? summary(j) : null; },

    // 认领：只有已完成 / 失败、且没被别人认领的任务才能认领，返回带结果和元数据的完整任务
    // 单进程里判断和设置之间没有 await，所以两个插件同时来认领，只有一个会成功
    claim(id, scope) {
      const j = jobs.get(id);
      if (!j || j.scope !== scope) return { error: '任务不存在', status: 404 };
      if (j.status !== 'done' && j.status !== 'failed') return { error: '任务当前状态不能回写：' + j.status, status: 409 };
      if (j.claim && now() - j.claim.at < CLAIM_TTL) return { error: '任务已被其他页面认领', status: 409 };
      j.claim = { token: randomBytes(8).toString('hex'), at: now() };
      save(j);
      return { job: { ...summary(j), meta: j.meta, results: j.results || null }, token: j.claim.token };
    },

    // 回写完成后确认：任务转为已回写，结果释放掉（只留一句摘要）
    ack(id, token, result) {
      const j = jobs.get(id);
      if (!j) return { error: '任务不存在', status: 404 };
      if (!j.claim || j.claim.token !== token) return { error: '认领已失效', status: 409 };
      j.status = 'applied';
      j.appliedAt = now();
      j.result = typeof result === 'string' ? result.slice(0, 500) : '';
      j.results = undefined;
      j.meta = undefined;
      j.claim = null;
      save(j);
      return { ok: true };
    },

    // 回写没成功（比如页面出错）：放开认领，之后可以重试
    release(id, token) {
      const j = jobs.get(id);
      if (j && j.claim && j.claim.token === token) { j.claim = null; save(j); }
      return { ok: true };
    },

    // 取消：排队中的直接不跑；已经在跑的无法中断，跑完结果丢弃；已完成没回写的结果直接丢弃
    cancel(id, scope) {
      const j = jobs.get(id);
      if (!j || j.scope !== scope) return { error: '任务不存在', status: 404 };
      if (j.status === 'applied' || j.status === 'cancelled') return { ok: true };
      j.status = 'cancelled';
      j.finishedAt = now();
      j.results = undefined;
      j.claim = null;
      rowsOf.delete(id);
      execOf.delete(id);
      save(j);
      return { ok: true };
    },

    async sweep() {
      const t = now();
      for (const j of [...jobs.values()]) {
        const end = j.appliedAt || j.finishedAt || j.createdAt;
        const done = j.status === 'applied' || j.status === 'cancelled';
        if (done ? t - end > KEEP_FINISHED : (j.status === 'done' || j.status === 'failed') && t - end > KEEP_PENDING) await remove(j.id);
      }
    },
  };
}
