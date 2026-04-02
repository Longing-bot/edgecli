// ─── Session Memory（CC SessionMemory 风格）─────────────────────────────
// 自动维护一个 markdown 文件记录当前会话的关键信息。
// 触发条件（类 CC）：
//   1. Token 阈值：上下文增长到一定程度后触发
//   2. 工具调用阈值：累积足够工具调用后触发
//   3. 自然断点：最后一轮没有工具调用时优先触发
//
// 与 CC 的区别：
//   - CC 用 forked subagent 提取，edgecli 用 LLM 内联提取（更轻量）
//   - CC 有 GrowthBook feature gate，edgecli 用配置文件
//   - edgecli 增加了：输出截断（控制 token 消耗）、格式化输出

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { Message } from '../config/index.js'
import { estimateMessageTokens } from './index.js'

// ─── 配置 ──────────────────────────────────────────────────────────────
interface SessionMemoryConfig {
  // 首次触发的 token 阈值（CC: minimumMessageTokensToInit）
  minimumTokensToInit: number
  // 后续触发的 token 增量阈值（CC: minimumTokensBetweenUpdate）
  minimumTokensBetweenUpdates: number
  // 工具调用累积阈值（CC: toolCallsBetweenUpdates）
  toolCallsBetweenUpdates: number
  // 摘要最大长度（edgecli 特有，控制成本）
  maxSummaryLength: number
  // 是否启用
  enabled: boolean
}

const DEFAULT_CONFIG: SessionMemoryConfig = {
  minimumTokensToInit: 10_000,
  minimumTokensBetweenUpdates: 5_000,
  toolCallsBetweenUpdates: 8,
  maxSummaryLength: 2000,
  enabled: true,
}

// ─── 状态 ──────────────────────────────────────────────────────────────
interface SessionMemoryState {
  initialized: boolean
  lastExtractionTokenCount: number
  lastExtractionTime: number
  toolCallsSinceLastExtraction: number
  lastMessageUuid: string | undefined
}

let state: SessionMemoryState = {
  initialized: false,
  lastExtractionTokenCount: 0,
  lastExtractionTime: 0,
  toolCallsSinceLastExtraction: 0,
  lastMessageUuid: undefined,
}

// ─── 文件路径 ──────────────────────────────────────────────────────────
function getSessionMemoryDir(): string {
  return join(homedir(), '.edgecli', 'sessions')
}

function getSessionMemoryPath(sessionId?: string): string {
  const dir = getSessionMemoryDir()
  mkdirSync(dir, { recursive: true })
  const id = sessionId || 'current'
  return join(dir, `${id}-memory.md`)
}

// ─── 阈值判断（CC shouldExtractMemory 逻辑）─────────────────────────────
export function shouldExtractMemory(messages: Message[]): boolean {
  const config = getConfig()
  if (!config.enabled) return false

  const currentTokenCount = estimateMessageTokens(messages)

  // 首次初始化检查
  if (!state.initialized) {
    if (currentTokenCount < config.minimumTokensToInit) {
      return false
    }
    state.initialized = true
  }

  // Token 增量检查
  const tokensSinceLast = currentTokenCount - state.lastExtractionTokenCount
  const hasMetTokenThreshold = tokensSinceLast >= config.minimumTokensBetweenUpdates

  // 工具调用检查
  const toolCallsSinceLast = countToolCallsSince(messages, state.lastMessageUuid)
  const hasMetToolCallThreshold = toolCallsSinceLast >= config.toolCallsBetweenUpdates

  // 最后一轮没有工具调用（自然断点）
  const lastMessage = messages[messages.length - 1]
  const lastTurnHasToolCalls = lastMessage?.role === 'tool' ||
    (lastMessage?.role === 'assistant' && lastMessage?.tool_calls?.length)

  // CC 触发逻辑：
  // 1. (token 达标 AND 工具调用达标) OR
  // 2. (token 达标 AND 最后一轮没有工具调用)
  const shouldExtract =
    (hasMetTokenThreshold && hasMetToolCallThreshold) ||
    (hasMetTokenThreshold && !lastTurnHasToolCalls)

  if (shouldExtract) {
    state.lastMessageUuid = lastMessage?.content?.slice(0, 50) // 简化：用内容前50字节作标识
    state.toolCallsSinceLastExtraction = 0
    return true
  }

  // 计数工具调用
  state.toolCallsSinceLastExtraction = toolCallsSinceLast

  return false
}

// ─── 提取会话记忆（CC buildSessionMemoryUpdatePrompt 逻辑）────────────────
export function buildSessionMemoryPrompt(
  currentMemory: string,
  recentMessages: Message[]
): string {
  // 取最近的消息（限制 token 消耗）
  const recent = recentMessages.slice(-20)
  const conversationParts = recent.map(m => {
    const role = m.role === 'user' ? '👤 User' :
                 m.role === 'assistant' ? '🤖 Assistant' :
                 m.role === 'tool' ? '🔧 Tool' : '⚙️ System'
    // 截断长内容
    const content = m.content?.slice(0, 500) || ''
    return `${role}: ${content}`
  })

  return `你是一个会话记忆提取器。根据以下对话，更新会话记忆文件。

## 当前记忆
${currentMemory || '(空)'}

## 最近对话
${conversationParts.join('\n')}

## 指令
1. 提取关键信息：用户的目标、做出的决定、遇到的问题、解决方案
2. 更新记忆文件，保留仍然相关的信息，添加新发现
3. 去重：不要重复已有的信息
4. 格式：markdown，分类组织
5. 如果没有新信息需要记录，返回 "NO_CHANGES"

请直接输出更新后的记忆内容（markdown 格式），不要加解释。`
}

// ─── 执行提取 ──────────────────────────────────────────────────────────
export async function extractSessionMemory(
  messages: Message[],
  callLLM: (messages: Message[]) => Promise<string>,
  sessionId?: string
): Promise<{ success: boolean; memoryPath: string; changed: boolean }> {
  const memoryPath = getSessionMemoryPath(sessionId)

  // 读取当前记忆
  let currentMemory = ''
  if (existsSync(memoryPath)) {
    currentMemory = readFileSync(memoryPath, 'utf-8')
  }

  // 构建提取提示
  const prompt = buildSessionMemoryPrompt(currentMemory, messages)

  try {
    // 调用 LLM 提取
    const extractionMessages: Message[] = [
      { role: 'user', content: prompt },
    ]
    const result = await callLLM(extractionMessages)

    // 检查是否有变更
    if (result.trim() === 'NO_CHANGES') {
      state.lastExtractionTokenCount = estimateMessageTokens(messages)
      state.lastExtractionTime = Date.now()
      return { success: true, memoryPath, changed: false }
    }

    // 截断超长输出
    const config = getConfig()
    let content = result.trim()
    if (content.length > config.maxSummaryLength) {
      content = content.slice(0, config.maxSummaryLength) + '\n\n...(截断)'
    }

    // 写入记忆文件
    writeFileSync(memoryPath, content, 'utf-8')

    // 更新状态
    state.lastExtractionTokenCount = estimateMessageTokens(messages)
    state.lastExtractionTime = Date.now()

    return { success: true, memoryPath, changed: true }
  } catch (error) {
    console.error('[sessionMemory] 提取失败:', (error as Error).message)
    return { success: false, memoryPath, changed: false }
  }
}

// ─── 加载会话记忆（注入到系统提示中）─────────────────────────────────────
export function loadSessionMemory(sessionId?: string): string | null {
  const memoryPath = getSessionMemoryPath(sessionId)
  if (!existsSync(memoryPath)) return null

  const content = readFileSync(memoryPath, 'utf-8').trim()
  if (!content) return null

  return `## 会话记忆\n${content}`
}

// ─── 手动触发（/memory 命令）───────────────────────────────────────────
export async function manuallyExtractSessionMemory(
  messages: Message[],
  callLLM: (messages: Message[]) => Promise<string>,
  sessionId?: string
): Promise<string> {
  const { success, memoryPath, changed } = await extractSessionMemory(messages, callLLM, sessionId)

  if (!success) {
    return '❌ 记忆提取失败。'
  }

  if (!changed) {
    return '📝 没有新的信息需要记录。'
  }

  const content = existsSync(memoryPath) ? readFileSync(memoryPath, 'utf-8') : ''
  return `✅ 会话记忆已更新 → ${memoryPath}\n\n${content.slice(0, 500)}`
}

// ─── 重置状态（新会话时调用）────────────────────────────────────────────
export function resetSessionMemoryState() {
  state = {
    initialized: false,
    lastExtractionTokenCount: 0,
    lastExtractionTime: 0,
    toolCallsSinceLastExtraction: 0,
    lastMessageUuid: undefined,
  }
}

// ─── 辅助函数 ──────────────────────────────────────────────────────────
function countToolCallsSince(messages: Message[], sinceUuid: string | undefined): number {
  let count = 0
  let foundStart = !sinceUuid

  for (const msg of messages) {
    if (!foundStart) {
      if (msg.content?.startsWith(sinceUuid!)) {
        foundStart = true
      }
      continue
    }

    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      count += msg.tool_calls.length
    }
  }

  return count
}

function getConfig(): SessionMemoryConfig {
  // 可从配置文件读取，目前用默认值
  return { ...DEFAULT_CONFIG }
}

// ─── 导出状态检查（调试用）─────────────────────────────────────────────
export function getSessionMemoryState() {
  return { ...state }
}
