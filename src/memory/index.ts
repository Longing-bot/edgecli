// ─── Token 预算管理（CC tokenBudget 风格）───────────────────────────────────
// CC 在 token 到达 90% 预算时发送"继续工作，不要总结"的消息

import { type Message } from '../config/index.js'

export interface BudgetTracker {
  continuationCount: number
  lastTurnTokens: number
  startedAt: number
}

export function createBudgetTracker(): BudgetTracker {
  return { continuationCount: 0, lastTurnTokens: 0, startedAt: Date.now() }
}

export type BudgetDecision = { action: 'continue' | 'stop'; nudgeMessage?: string }

// CC 风格：检测是否需要 "continue" 提示
export function checkBudget(tracker: BudgetTracker, messages: Message[], budget: number = 80000): BudgetDecision {
  const totalTokens = estimateMessageTokens(messages)
  const pct = totalTokens / budget

  // 90% 时提示继续（CC 风格）
  if (pct >= 0.9 && tracker.continuationCount < 3) {
    tracker.continuationCount++
    return {
      action: 'continue',
      nudgeMessage: `已使用 ${Math.round(pct * 100)}% 的上下文 (${totalTokens.toLocaleString()} / ${budget.toLocaleString()} tokens)。继续工作，不要总结。`
    }
  }

  // 100% 时停止
  if (pct >= 1.0) {
    return { action: 'stop' }
  }

  return { action: 'continue' }
}
export { COMPACT_PROMPT, buildCompactedMessages, shouldCompact, getCompactionRequest, autoCompactMessages } from './compact.js'
export {
  shouldExtractMemory,
  extractSessionMemory,
  loadSessionMemory,
  manuallyExtractSessionMemory,
  resetSessionMemoryState,
  getSessionMemoryState,
} from './sessionMemory.js'

// Rough token estimation
export function estimateTokens(text: string): number {
  const ascii = text.replace(/[\u4e00-\u9fff]/g, '').length
  const cjk = text.length - ascii
  return Math.ceil(ascii / 4 + cjk / 1.5)
}

export function estimateMessageTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => {
    let tokens = estimateTokens(m.content)
    if (m.tool_calls) tokens += m.tool_calls.length * 50
    return sum + tokens
  }, 0)
}

export function getContextStats(messages: Message[]): string {
  const total = estimateMessageTokens(messages)
  const userMsgs = messages.filter(m => m.role === 'user').length
  const toolCalls = messages.filter(m => m.role === 'tool').length
  return `~${total.toLocaleString()} tok (${userMsgs}u ${toolCalls}t)`
}
