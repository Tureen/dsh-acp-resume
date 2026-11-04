/**
 * Copy owned by the persistent-chat panel, registered under {@link PANEL_LOCALE}.
 * Wording follows PANEL-DESIGN §2.2/§3.5.
 * @module dsh-acp-resume/client/locales
 */

/** Locale namespace of the panel. */
export const PANEL_LOCALE = 'acpResumePanel'

/** Simplified Chinese panel copy. */
export const zh = {
  title: '持久会话',
  guideDescription: '查看并释放模型建立的持久 ACP 会话',
  refresh: '刷新',
  loading: '正在读取…',
  loadFailed: '读取失败:{message}',
  emptyTitle: '暂无持久会话',
  emptyHint: '让模型调用 {tool} 创建;之后的每一轮对话都在这里可见。',
  active: '活跃',
  released: '已释放(下次发送自动重连)',
  turns: '{count} 轮',
  noValue: '—',
  cwd: 'cwd {cwd}',
  remote: '远端 {id}',
  justNow: '刚刚',
  minutesAgo: '{count} 分钟前',
  hoursAgo: '{count} 小时前',
  daysAgo: '{count} 天前',
  release: '释放',
  releaseLabel: '释放 {chatId}',
  delete: '删除',
  deleteLabel: '删除 {chatId}',
  confirmTitle: '删除 {chatId}?',
  confirmBody: '将释放进程并删除本地记录,之后无法重连该会话。',
  cancel: '取消',
  dismiss: '关闭',
  actionFailed: '操作失败:{message}',
} satisfies Record<string, string>

/** Panel copy key. */
export type PanelCopyKey = keyof typeof zh

/** English panel copy. */
export const en: Record<PanelCopyKey, string> = {
  title: 'Persistent chats',
  guideDescription: 'View and release persistent ACP chats the model opened',
  refresh: 'Refresh',
  loading: 'Loading…',
  loadFailed: 'Could not load: {message}',
  emptyTitle: 'No persistent chats',
  emptyHint: 'Ask the model to call {tool}; every turn after that shows up here.',
  active: 'Active',
  released: 'Released (the next send reconnects)',
  turns: '{count} turns',
  noValue: '—',
  cwd: 'cwd {cwd}',
  remote: 'remote {id}',
  justNow: 'just now',
  minutesAgo: '{count} min ago',
  hoursAgo: '{count} h ago',
  daysAgo: '{count} d ago',
  release: 'Release',
  releaseLabel: 'Release {chatId}',
  delete: 'Delete',
  deleteLabel: 'Delete {chatId}',
  confirmTitle: 'Delete {chatId}?',
  confirmBody: 'This releases the process and deletes the local record. The chat cannot be reconnected afterwards.',
  cancel: 'Cancel',
  dismiss: 'Close',
  actionFailed: 'Action failed: {message}',
}

/** Structural twin of the locale `t` seat for this namespace. */
export type PanelTranslate = (key: PanelCopyKey, params?: Readonly<Record<string, string | number>>) => string
