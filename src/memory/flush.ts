// ─── 压缩前自动记忆刷新（OpenClaw 风格）───────────────────────────────────
// OpenClaw 在接近压缩阈值时，触发一个静默的 agentic turn，
// 提醒模型在上下文丢失前将持久化记忆写入磁盘。

import { estimateMessageTokens } from './index.js'
import { type Message } from '../config/index.js'

export interface FlushConfig {
  enabled: boolean
  softThresholdTokens: number  // 距离上限还剩多少 token 时触发
  systemPrompt: string
  prompt: string
}

const DEFAULT_FLUSH_CONFIG: FlushConfig = {
  enabled: true,
  softThresholdTokens: 4000,
  systemPrompt: '会话即将压缩。请立即保存持久化记忆。',
  prompt: `将重要的记忆写入 memory/YYYY-MM-DD.md（日志）或 MEMORY.md（长期记忆）。
如果没有需要保存的，请回复 NO_REPLY。
不要在这里添加对话性的回复。只写入值得记录的内容。`,
}

// 检查是否需要触发记忆刷新
export function shouldFlushMemory(
  messages: Message[],
  budget: number = 80000,
  config: FlushConfig = DEFAULT_FLUSH_CONFIG
): boolean {
  if (!config.enabled) return false

  const totalTokens = estimateMessageTokens(messages)
  const remaining = budget - totalTokens

  // 距离上限还剩 softThresholdTokens 时触发
  return remaining <= config.softThresholdTokens && remaining > 0
}

// 构建记忆刷新的消息（发送给模型）
export function buildFlushMessages(config: FlushConfig = DEFAULT_FLUSH_CONFIG): Message[] {
  return [
    { role: 'system', content: config.systemPrompt },
    { role: 'user', content: config.prompt },
  ]
}
