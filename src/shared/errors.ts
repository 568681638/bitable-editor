// 把各种来源的错误（飞书 SDK 的 OpenError、跨 iframe 传回来的普通对象、浏览器的网络错误、字符串）
// 统一翻译成用户能看懂的中文：先说“怎么回事”，再给“怎么办”，最后括号里附原始信息便于排查。

export type ErrorAction = 'read' | 'write';

interface RawError { message: string; code?: number }

// SDK 抛出的错误经过 bridge 序列化后，可能不再是 Error 实例，而是 { e: 'bte', code, message } 之类的对象
function normalize(error: unknown): RawError {
  if (error instanceof Error) return { message: error.message, code: numericCode((error as any).code) };
  if (typeof error === 'string') return { message: error };
  if (error && typeof error === 'object') {
    const o = error as Record<string, any>;
    const message = [o.message, o.msg, o.errMsg, o.error].find(m => typeof m === 'string' && m) || '';
    return { message, code: numericCode(o.code ?? o.errCode ?? o.errorCode) };
  }
  return { message: error === undefined || error === null ? '' : String(error) };
}

function numericCode(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && isFinite(n) ? n : undefined;
}

// 错误码结构：<范围码><三位细节码>，如 10214997 = 记录(10214) + 权限拒绝(997)
const SCOPES: Record<number, string> = {
  10212: '数据表', 10213: '字段', 10214: '记录', 10215: '视图', 10216: '单元格', 10217: '仪表盘',
};

function byCode(code: number, action: ErrorAction): string | null {
  const scope = SCOPES[Math.floor(code / 1000)];
  const detail = code % 1000;
  if (!scope) return null;
  if (code === 10214001) return '一次操作涉及的记录数超过了飞书的上限，请缩小范围后重试';
  switch (detail) {
    case 997:
      if (action === 'write') {
        return `没有编辑权限：你对当前${scope === '记录' || scope === '单元格' ? '表格里的这条记录' : scope}没有编辑权限，无法保存修改。请联系表格所有者或管理员，给你开通“可编辑”权限（如果表格设置了高级权限，也可能是该字段/记录被限制为只读）`;
      }
      return `没有查看权限：你无权查看当前${scope}的内容，请联系表格所有者或管理员开通权限`;
    case 998:
      return `${scope}已不存在（可能已被删除或移动），请点击右上角 ↻ 刷新后重试`;
    case 999:
      return `飞书在处理${scope}时返回了未知错误，请稍后重试；反复出现请联系表格管理员`;
    case 992:
      return `提交的${scope}数据格式不符合要求，请检查填写的内容`;
    case 993: case 994:
      return `${scope}的数据超出了飞书允许的范围，请检查填写的内容`;
    case 995:
      return `${scope}名称重复`;
    case 996:
      return '当前飞书客户端版本不支持这个操作，请升级飞书后重试';
    case 991:
      return `该${scope}的类型暂不支持这个操作`;
  }
  return null;
}

// 没有错误码时，按消息内容兜底（SDK 的消息是英文，如 “record permission denied error”）
function byMessage(message: string, action: ErrorAction): string | null {
  const m = message.toLowerCase();
  if (/permission denied|no permission|not allowed|forbidden|无权限|没有权限/.test(m)) {
    return action === 'write'
      ? '没有编辑权限：你对当前表格没有编辑权限，无法保存修改。请联系表格所有者或管理员，给你开通“可编辑”权限'
      : '没有查看权限：你无权查看当前表格的内容，请联系表格所有者或管理员开通权限';
  }
  if (/not found|不存在/.test(m)) return '要操作的数据已不存在（可能已被删除或移动），请点击右上角 ↻ 刷新后重试';
  if (/failed to fetch|networkerror|network error|load failed|err_network|err_internet/.test(m)) {
    return '网络请求失败：无法连接到服务，请检查网络（或确认后端服务是否在运行）后重试';
  }
  if (/timeout|timed out|超时/.test(m)) return '请求超时，请检查网络后重试';
  if (/unknown error/.test(m)) return '飞书返回了未知错误，请稍后重试；反复出现请联系表格管理员';
  return null;
}

/**
 * 把任意错误变成给用户看的中文说明。
 * - 认得的错误：中文说明 +（原始信息）
 * - 不认得的：原始信息原样返回（已是中文的消息不会被重复包装）；完全没有信息时给出通用提示
 */
export function describeError(error: unknown, action: ErrorAction = 'write'): string {
  if (error instanceof Error && (error as any).described) return error.message; // 已经翻译过（比如侧边栏翻译后经 ack 传给面板页）
  const { message, code } = normalize(error);
  const friendly = (code !== undefined ? byCode(code, action) : null) || byMessage(message, action);
  const raw = [code !== undefined ? `错误码 ${code}` : '', message].filter(Boolean).join('：');
  if (friendly) return raw && friendly !== message ? `${friendly}（${raw}）` : friendly;
  if (message) return code !== undefined ? `${message}（错误码 ${code}）` : message;
  return code !== undefined ? `操作失败（错误码 ${code}），请稍后重试` : '操作失败，原因未知，请稍后重试；反复出现请联系管理员';
}

/** 给已经翻译好的说明打上标记，之后再经过 describeError 不会被重复包装 */
export function describedError(message: string): Error {
  const e = new Error(message);
  (e as any).described = true;
  return e;
}
