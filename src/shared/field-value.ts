import { FType, FieldMeta, FieldOption } from './common';

// ── 自动刷写：把函数返回的值，转成各类型字段在“多维表格插件 SDK”里写入所需的单元格结构 ──
// 写入结构（见 SDK 类型定义）：文本 [{type:'text',text}]、数字 number、单选 {id,text}、多选 [{id,text}]、
// 日期 毫秒时间戳 number、复选框 boolean、电话/邮箱 string、超链接 [{type:'url',text,link}]、人员 [{id}]。
// 函数返回值就按该类型在多维表格里的原生形态给（数字给数字、复选框给 true/false、日期给毫秒时间戳……），
// 这里不做宽松兼容（不解析日期字符串、不拆分隔符、不猜真假词），类型不对直接报错。
// 唯一的转换是单选/多选：函数给选项名，这里换成选项 ID（函数不可能知道选项 ID）。

/** 当前支持写入的字段类型（其余类型，如公式、附件、关联，选了会在刷写前被拦住并提示） */
export const WRITABLE_TYPES = new Set<number>([
  FType.TEXT, FType.NUMBER, FType.CURRENCY, FType.PROGRESS, FType.RATING,
  FType.SINGLE_SELECT, FType.MULTI_SELECT, FType.DATE_TIME, FType.CHECKBOX,
  FType.PHONE, FType.EMAIL, FType.URL, FType.USER,
]);

export const FIELD_TYPE_NAMES: Record<number, string> = {
  [FType.TEXT]: '文本', [FType.NUMBER]: '数字', [FType.SINGLE_SELECT]: '单选', [FType.MULTI_SELECT]: '多选',
  [FType.DATE_TIME]: '日期', [FType.CHECKBOX]: '复选框', [FType.USER]: '人员', [FType.PHONE]: '电话',
  [FType.URL]: '超链接', [FType.ATTACHMENT]: '附件', [FType.SINGLE_LINK]: '单向关联', [FType.FORMULA]: '公式',
  [FType.DUPLEX_LINK]: '双向关联', [FType.LOCATION]: '地理位置', [FType.GROUP_CHAT]: '群组',
  [FType.AUTO_NUMBER]: '自动编号', [FType.PROGRESS]: '进度', [FType.CURRENCY]: '货币', [FType.RATING]: '评分',
  [FType.EMAIL]: '邮箱', [FType.OBJECT]: '对象',
};

/** 选择类字段需要先取到选项，才能把名字换成选项 ID */
export const needsOptions = (type: number) => type === FType.SINGLE_SELECT || type === FType.MULTI_SELECT;

const show = (v: any) => (typeof v === 'string' ? `“${v}”` : JSON.stringify(v));
const typeName = (f: FieldMeta) => FIELD_TYPE_NAMES[f.type] || '该';
const wrong = (field: FieldMeta, want: string, v: any) =>
  new Error(`“${field.name}”是${typeName(field)}字段，需要${want}，实际得到：${show(v)}`);

function pickOption(field: FieldMeta, options: FieldOption[], v: any): { id: string; text: string } {
  if (typeof v !== 'string') throw wrong(field, '选项名（字符串）', v);
  const hit = options.find(o => o.name === v);
  if (!hit) {
    const sample = options.slice(0, 10).map(o => o.name).join('、');
    throw new Error(`“${field.name}”里没有名为${show(v)}的选项（不会自动新增选项）。现有选项：${sample || '（空）'}${options.length > 10 ? '…' : ''}`);
  }
  return { id: hit.id, text: hit.name };
}

/**
 * 把函数返回的值转成字段的写入值；类型不对就抛出带字段名和原因的错误（只会让这一行失败）。
 * 选择类字段需要传 options（该字段的全部选项）。
 */
export function toFieldValue(field: FieldMeta, v: any, options: FieldOption[] = []): any {
  switch (field.type) {
    case FType.NUMBER:
    case FType.CURRENCY:
    case FType.PROGRESS:
    case FType.RATING:
      if (typeof v !== 'number' || !isFinite(v)) throw wrong(field, '数字', v);
      return v;
    case FType.SINGLE_SELECT:
      return pickOption(field, options, v);
    case FType.MULTI_SELECT:
      if (!Array.isArray(v)) throw wrong(field, '选项名数组', v);
      return v.map(x => pickOption(field, options, x));
    case FType.DATE_TIME:
      if (typeof v !== 'number' || !isFinite(v)) throw wrong(field, '毫秒时间戳（数字）', v);
      return v;
    case FType.CHECKBOX:
      if (typeof v !== 'boolean') throw wrong(field, 'true / false', v);
      return v;
    case FType.PHONE:
    case FType.EMAIL:
      if (typeof v !== 'string') throw wrong(field, '字符串', v);
      return v;
    case FType.URL: {
      // 链接字符串，或 { link, text }
      const link = typeof v === 'string' ? v : v && typeof v === 'object' ? v.link : undefined;
      if (typeof link !== 'string' || !link) throw wrong(field, '链接字符串或 {link, text}', v);
      const text = v && typeof v === 'object' && typeof v.text === 'string' && v.text ? v.text : link;
      return [{ type: 'url', text, link }];
    }
    case FType.USER:
      if (!Array.isArray(v) || v.length === 0 || !v.every(x => x && typeof x.id === 'string' && x.id)) throw wrong(field, '人员数组 [{id}]', v);
      return v.map(x => ({ id: x.id }));
    default: // 文本
      if (typeof v !== 'string' && typeof v !== 'number') throw wrong(field, '字符串', v);
      return [{ type: 'text', text: String(v) }];
  }
}
