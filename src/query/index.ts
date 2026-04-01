// ─── Agent Loop 重构 ─────────────────────────────────────────────────────
// 健壮的多轮循环：工具调用→结果→LLM 再思考→可能再调用工具
// 特性：
//   - 工具调用失败自动重试（最多 3 次，指数退避）
//   - 循环调用检测（同一工具+相同参数连续 3 次 → 停止）
//   - 最大工具调用轮数限制（默认 25，可配置）
//   - 工具并行调用支持
//   - 错误恢复：失败信息反馈给 LLM

import { CodoConfig, Message, detectProvider, getUsageTracker, type TokenUsage } from '../config/index.js'
import { callLLM } from '../api/index.js'
import { findTool, toOpenAI, toAnthropic, getActiveTools, activateLazyTool, CORE_TOOLS, LAZY_TOOLS, type ToolResult } from '../tools/index.js'
import { buildSystemPrompt } from '../prompts/system.js'
import { executePreToolHooks, executePostToolHooks } from '../hooks/index.js'
import { createBudgetTracker, checkBudget } from '../memory/index.js'
import { shouldFlushMemory, buildFlushMessages } from '../memory/flush.js'
import { shouldCompact, autoCompactMessages, COMPACT_PROMPT } from '../memory/compact.js'
import { checkPermission } from '../permissions/index.js'
import { collectContext, formatContextForPrompt } from '../context/index.js'
import { snapshotBefore, recordChange, formatChangeSummary } from '../tracker/index.js'
import { needsApproval, handleApprovalDecision, type ApprovalDecision, type ApprovalRequest } from '../approval/index.js'
import { saveSession as saveSessionDB, initWorkspaceSession } from '../storage/index.js'
import { getMCPTools, initMCPServers } from '../mcp/index.js'

// MCP 初始化标志
let mcpInitialized = false

// ─── 配置 ────────────────────────────────────────────────────────────
const MAX_TOOL_ROUNDS = 25          // 最大工具调用轮数
const MAX_RETRIES = 3               // 单次工具调用最大重试
const LOOP_DETECTION_THRESHOLD = 3  // 连续相同调用次数阈值
const EXPONENTIAL_BACKOFF_BASE = 1000 // 退避基础 ms

export interface QueryCallbacks {
  onText?: (text: string) => void
  onToken?: (token: string) => void
  onToolStart?: (name: string, args: string) => void
  onToolResult?: (name: string, result: ToolResult) => void
  onTurn?: (turn: number) => void
  onUsage?: (usage: TokenUsage, model: string) => void
  onError?: (error: string) => void
  onApprovalNeeded?: (request: ApprovalRequest) => Promise<ApprovalDecision>
}

// ─── 循环调用检测 ─────────────────────────────────────────────────────
interface CallRecord {
  toolName: string
  argsHash: string
  count: number
}

function hashArgs(args: Record<string, any>): string {
  // 简单哈希：对参数排序后 JSON 序列化
  const sorted = Object.keys(args).sort().reduce((acc, k) => {
    acc[k] = args[k]
    return acc
  }, {} as Record<string, any>)
  return JSON.stringify(sorted)
}

function detectLoop(record: CallRecord | null, toolName: string, args: Record<string, any>): CallRecord {
  const currentHash = hashArgs(args)
  if (record && record.toolName === toolName && record.argsHash === currentHash) {
    return { toolName, argsHash: currentHash, count: record.count + 1 }
  }
  return { toolName, argsHash: currentHash, count: 1 }
}

// ─── 工具执行（带重试）────────────────────────────────────────────────
async function executeToolWithRetry(
  toolName: string,
  args: Record<string, any>,
  callbacks: QueryCallbacks
): Promise<ToolResult> {
  const tool = findTool(toolName)
  if (!tool) {
    return { content: `未知工具: ${toolName}。用 tool_search 查找可用工具。`, isError: true }
  }

  let lastError: string = ''
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const result = await tool.execute(args)
      return result
    } catch (ex: any) {
      lastError = ex.message || String(ex)
      if (attempt < MAX_RETRIES - 1) {
        const delay = EXPONENTIAL_BACKOFF_BASE * Math.pow(2, attempt)
        await sleep(delay)
      }
    }
  }

  return {
    content: `工具 ${toolName} 执行失败（已重试 ${MAX_RETRIES} 次）: ${lastError}`,
    isError: true,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

// ─── 格式化工具结果为用户友好的消息 ─────────────────────────────────────
function formatToolResultForDisplay(toolName: string, result: ToolResult): string {
  if (result.isError) {
    return result.content
  }

  const lines = result.content.split('\n')
  switch (toolName) {
    case 'read_file':
      if (lines.length > 1) {
        return lines.slice(0, 8).join('\n') + (lines.length > 8 ? `\n… (${lines.length} 行)` : '')
      }
      return result.content
    case 'bash':
      return lines[0].slice(0, 70) || '(空输出)'
    default:
      return lines[0].slice(0, 70) || '(空输出)'
  }
}

// ─── 主循环 ───────────────────────────────────────────────────────────
export async function runQuery(
  userMessage: string,
  config: CodoConfig,
  messages: Message[],
  callbacks: QueryCallbacks = {},
): Promise<Message[]> {
  const { onText, onToken, onToolStart, onToolResult, onTurn, onUsage, onError, onApprovalNeeded } = callbacks

  // 初始化 MCP servers（仅首次）
  if (!mcpInitialized) {
    mcpInitialized = true
    initMCPServers().catch(() => {}) // 静默失败
  }

  // 初始化 workspace session
  initWorkspaceSession(config.model)

  // 系统提示词（带上下文感知）
  if (!messages.length || messages[0].role !== 'system') {
    const context = collectContext(true)
    const contextStr = formatContextForPrompt(context)
    const systemPrompt = buildSystemPrompt()
    // 将上下文注入系统提示
    messages.unshift({ role: 'system', content: systemPrompt.replace('</environment>', `${contextStr}\n</environment>`) })
  }

  messages.push({ role: 'user', content: userMessage })

  const tracker = getUsageTracker()
  let tools = detectProvider(config) === 'anthropic'
    ? toAnthropic(CORE_TOOLS)
    : toOpenAI(CORE_TOOLS)

  const budget = createBudgetTracker()
  let lastCallRecord: CallRecord | null = null
  let totalToolRounds = 0

  for (let turn = 1; turn <= MAX_TOOL_ROUNDS; turn++) {
    onTurn?.(turn)

    // ─── 上下文管理 ───────────────────────────────────────────────
    // 刷新 git 状态（每轮开始时）
    if (turn > 1) {
      collectContext(true)
    }

    // Token 预算检查
    const decision = checkBudget(budget, messages)
    if (decision.action === 'stop') {
      onError?.('上下文已满。请使用 /clear 清除历史或 /compact 压缩。')
      break
    }

    // 记忆刷新
    if (shouldFlushMemory(messages)) {
      const flushMsgs = buildFlushMessages()
      for (const m of flushMsgs) {
        if (!messages.some(existing => existing.content === m.content)) {
          messages.push(m)
        }
      }
    }

    // Continue 提示
    if (decision.nudgeMessage && !messages.some(m => m.content === decision.nudgeMessage)) {
      messages.push({ role: 'user', content: decision.nudgeMessage })
    }

    // 自动压缩（200K 阈值）
    if (shouldCompact(messages, 200_000)) {
      const compacted = autoCompactMessages(messages)
      messages.length = 0
      messages.push(...compacted)
      onText?.('\n📝 上下文已自动压缩，继续工作...\n')
    }

    // ─── LLM 调用 ───────────────────────────────────────────────
    let response
    try {
      response = await callLLM(messages, tools as any, config, onToken ? { onToken } : undefined)
    } catch (ex: any) {
      onError?.(ex.message)
      break
    }

    // 记录 token 用量
    if (response.usage) {
      tracker.recordTurn(response.usage)
      onUsage?.(response.usage, config.model)
    }

    // 非流式时回调文本
    if (!onToken && response.content) onText?.(response.content)

    // 没有工具调用 → 结束
    if (!response.toolCalls?.length) {
      messages.push({ role: 'assistant', content: response.content })
      break
    }

    // 有工具调用
    messages.push({ role: 'assistant', content: response.content, tool_calls: response.toolCalls })

    // ─── 循环调用检测 ─────────────────────────────────────────────
    if (response.toolCalls.length === 1) {
      const tc = response.toolCalls[0]
      const args = JSON.parse(tc.function.arguments)
      const newRecord = detectLoop(lastCallRecord, tc.function.name, args)

      if (newRecord.count >= LOOP_DETECTION_THRESHOLD) {
        const msg = `⚠️ 检测到循环调用：${tc.function.name} 已连续执行 ${newRecord.count} 次（相同参数）。已自动停止。`
        onError?.(msg)
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: msg,
        })
        // 让 LLM 重新思考
        messages.push({
          role: 'user',
          content: '你刚才重复调用了相同的工具。请换一种方式解决问题，或者告诉用户当前状态。',
        })
        lastCallRecord = null
        continue
      }
      lastCallRecord = newRecord
    } else {
      lastCallRecord = null
    }

    // ─── 并行工具执行 ─────────────────────────────────────────────
    totalToolRounds++
    if (totalToolRounds > MAX_TOOL_ROUNDS) {
      onError?.(`已达到最大工具调用轮数（${MAX_TOOL_ROUNDS}）。请使用 /compact 压缩后继续。`)
      break
    }

    // 检查是否需要延迟工具激活
    for (const tc of response.toolCalls) {
      const lazyTool = LAZY_TOOLS.find(t => t.name === tc.function.name)
      if (lazyTool && !getActiveTools().find(t => t.name === tc.function.name)) {
        activateLazyTool(tc.function.name)
        const activeTools = [...getActiveTools()]
        // 添加 MCP 工具
        const mcpTools = getMCPTools()
        const allTools = [...activeTools, ...mcpTools]
        tools = detectProvider(config) === 'anthropic'
          ? toAnthropic(allTools)
          : toOpenAI(allTools)
      }

      // MCP 工具调用（mcp_ 前缀）
      if (tc.function.name.startsWith('mcp_')) {
        const mcpTools = getMCPTools()
        const allActive = [...getActiveTools(), ...mcpTools]
        tools = detectProvider(config) === 'anthropic'
          ? toAnthropic(allActive)
          : toOpenAI(allActive)
      }
    }

    // 并行执行所有工具调用
    const toolPromises = response.toolCalls.map(async (tc) => {
      const toolName = tc.function.name
      let args: Record<string, any>
      try {
        args = JSON.parse(tc.function.arguments)
      } catch {
        return {
          toolCallId: tc.id,
          result: { content: `参数解析失败: ${tc.function.arguments}`, isError: true },
          toolName,
          args: {} as Record<string, any>,
        }
      }

      onToolStart?.(toolName, tc.function.arguments)

      // 权限检查
      const perm = checkPermission(toolName)
      if (!perm.allowed) {
        const result: ToolResult = { content: perm.reason!, isError: true }
        onToolResult?.(toolName, result)
        return { toolCallId: tc.id, result, toolName, args }
      }

      // 审批检查
      const approvalRequest = needsApproval(toolName, args)
      if (approvalRequest && onApprovalNeeded) {
        const decision = await onApprovalNeeded(approvalRequest)
        const { allowed, message } = handleApprovalDecision(approvalRequest, decision)
        if (!allowed) {
          const result: ToolResult = { content: message || '用户拒绝执行', isError: true }
          onToolResult?.(toolName, result)
          return { toolCallId: tc.id, result, toolName, args }
        }
        if (message) {
          onText?.(`\n${message}\n`)
        }
      }

      // Pre-tool hooks
      const preCheck = await executePreToolHooks(toolName, args)
      if (!preCheck.allowed) {
        const result: ToolResult = { content: preCheck.reason!, isError: true }
        onToolResult?.(toolName, result)
        return { toolCallId: tc.id, result, toolName, args }
      }

      // 文件变更追踪：操作前快照
      let beforeSnapshot = null
      if (toolName === 'write_file' || toolName === 'edit_file') {
        beforeSnapshot = snapshotBefore(args.file_path)
      }

      // 执行工具（带重试）
      let result = await executeToolWithRetry(toolName, args, callbacks)

      // 文件变更追踪：记录变更
      if (toolName === 'write_file' || toolName === 'edit_file') {
        const change = recordChange(args.file_path, toolName, beforeSnapshot)
        if (change && !result.isError) {
          const summary = formatChangeSummary(change)
          result = { ...result, content: result.content + ` [${summary}]` }
        }
      }

      // Post-tool hooks
      result = await executePostToolHooks(toolName, args, result)

      onToolResult?.(toolName, result)
      return { toolCallId: tc.id, result, toolName, args }
    })

    // 等待所有工具完成
    const toolResults = await Promise.all(toolPromises)

    // 将结果加入消息
    for (const { toolCallId, result } of toolResults) {
      messages.push({ role: 'tool', tool_call_id: toolCallId, content: result.content })
    }
  }

  // 保存会话到 SQLite
  saveSessionDB(undefined, messages)
  return messages
}
