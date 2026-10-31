import type { FieldMeta, FieldOption, RecordData } from './common';

// 侧边栏插件（持有飞书 SDK）与双栏面板页之间的 postMessage 协议。
// 面板页由插件 window.open 打开，通过 window.opener 回传命令。

export type MessageStatus = { kind: 'loading' | 'empty' | 'error'; text: string } | null;

// 插件 → 面板
export interface SnapshotMessage {
  type: 'snapshot';
  status: MessageStatus;
  fields: FieldMeta[];
  options: Record<string, FieldOption[]>;
  index: number;
  total: number;
  record: RecordData | null;
}

export interface AckMessage {
  type: 'ack';
  id: number;
  ok: boolean;
  error?: string;
}

export interface PongMessage {
  type: 'pong';
}

export type HostMessage = SnapshotMessage | AckMessage | PongMessage;

// 面板 → 插件
export type PanelCommand =
  // session：面板页每次加载生成的随机 ID。同名窗口被复用并重新加载时窗口对象不变，只能靠它区分新旧页面
  | { type: 'panel-ready'; session: string }
  | { type: 'navigate'; index: number }
  | { type: 'refresh' }
  | { type: 'save'; id: number; recordId: string; fields: Record<string, any> };
