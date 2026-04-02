// ─── Agent Loop 重构 ─────────────────────────────────────────────────────
// CC-inspired while(true) loop with State + transition tracking
// 特性：
//   - while(true) 循环，模型通过 needsFollowUp 控制退出
//   - State 对象 + transition 记录（可观测、可调试）
//   - 工具调用失败自动重试（最多 3 次，指数退避）
//   - 循环调用检测（同一工具+相同参数连续 3 次 → 停止）
//   - 最大工具调用轮数限制（默认 25，可配置）
//   - 工具并行调用支持
//   - 错误恢复：失败信息反馈给 LLM
//   - 自动 commit 工具修改的文件
//   - 自动调试（失败时收集错误上下文反馈给 LLM）
//   - 成本追踪

import { CodoConfig, Message, detectProvider, getUsageTracker, type TokenUsage, type ToolCall } from '../config/index.js'
import { callLLM, warmupCache } from '../api/index.js'
import { findTool, toOpenAI, toAnthropic, getActiveTools, activateLazyTool, CORE_TOOLS, LAZY_TOOLS, type ToolResult } from '../tools/index.js'
import { buildSystemPrompt } from '../prompts/system.js'
import { executePreToolHooks, executePostToolHooks, executeStopHooks } from '../hooks/index.js'
import { createBudgetTracker, checkBudget } from '../memory/index.js'
import { shouldFlushMemory, buildFlushMessages } from '../memory/flush.js'
import { shouldCompact, autoCompactMessages, COMPACT_PROMPT, runCompactionPipeline } from '../memory/compact.js'
import { checkPermission } from '../permissions/index.js'
import { collectContext, formatContextForPrompt } from '../context/index.js'
import { snapshotBefore, recordChange, formatChangeSummary } from '../tracker/index.js'
import { needsApproval, handleApprovalDecision, type ApprovalDecision, type ApprovalRequest } from '../approval/index.js'
import { saveSession as saveSessionDB, initWorkspaceSession, createTask, addTaskStep, updateTaskStatus, updateTaskStep, getLatestUnfinishedTask, getTaskSteps, formatTaskProgress, getWorkspaceSessionId, type TaskStep } from '../storage/index.js'
import { getMCPTools, initMCPServers } from '../mcp/index.js'
import { autoCommit, trackAICommit, stageFile } from '../git/index.js'
import { collectDebugContext, shouldAutoRetry, buildDebugFeedback, formatDebugSummary } from '../debug/index.js'
import { recordCost, checkBudgetLimit, getDowngradedModel } from '../budget/index.js'

// MCP 初始化标志
let mcpInitialized = false

// ─── 配置 ────────────────────────────────────────────────────────────
const MAX_TOOL_ROUNDS = 25          // 最大工具调用轮数
const MAX_RETRIES = 3               // 单次工具调用最大重试
const LOOP_DETECTION_THRESHOLD = 3  // 连续相同调用次数阈值
const EXPONENTIAL_BACKOFF_BASE = 1000 // 退避基础 ms

// ─── State + Transition（CC-inspired）────────────────────────────────
type TransitionReason =
  | 'next_turn'                       // 正常：有工具调用，继续下一轮
  | 'completed'                       // 正常退出：模型不再调用工具
  | 'loop_detected'                   // 循环检测停止
  | 'max_turns'                       // 达到最大轮数
  | 'budget_exceeded'                 // Token 预算用尽
  | 'model_error'                     // 模型调用失败
  | 'reflection_retry'                // 反思后重试
  | 'self_check'                      // 自我检查注入
  | 'stop_hook_blocking'              // Stop hook 注入继续信号

interface StreamingToolResult {
  toolCallId: string
  toolName: string
  args: Record<string, any>
  result: ToolResult
}

interface QueryState {
  turn: number
  messages: Message[]
  toolUseBlocks: Array<{ id: string; name: string; args: Record<string, any> }>
  needsFollowUp: boolean
  transition: { reason: TransitionReason; detail?: string } | undefined
  totalToolRounds: number
  lastCallRecord: CallRecord | null
  taskId: string | null
  // StreamingToolExecutor：流式接收期间已完成的工具结果
  streamingResults: Map<string, Promise<StreamingToolResult>>
}

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
  const sorted = Object.keys(args).sort().reduce<Record<string, any>>((acc, k) => {
    acc[k] = args[k]
    return acc
  }, {})
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
    } catch (ex: unknown) {
      lastError = ex instanceof Error ? ex.message : String(ex)
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

// ─── 反思消息注入 ──────────────────────────────────────────────────────
const REFLECTION_PROMPT = `回顾刚才的操作，检查是否有错误或遗漏。如果有问题，主动修正。特别注意：
- 工具调用是否成功返回？
- 结果是否符合预期？
- 是否遗漏了必要的步骤？
- 输出是否完整？`

const SELF_CHECK_PROMPT = `在回复用户之前，进行最终自我检查：
1. 所有工具调用是否成功？
2. 任务是否完整完成？
3. 是否有遗漏的步骤需要补充？
4. 如果发现问题，立即修正，不需要用户提醒。
回复"SELF_CHECK_PASS"如果一切正常，否则描述问题并修正。`

// ─── Plan-Execute-Verify 检测 ──────────────────────────────────────────
// 判断是否为复杂任务（需要计划模式）
function isComplexTask(userMessage: string, toolCallCount: number): boolean {
  // 多个工具调用 → 复杂
  if (toolCallCount > 1) return true

  // 关键词检测
  const complexPatterns = [
    /重构|refactor/i,
    /迁移|migrate/i,
    /实现.*功能|implement.*feature/i,
    /修复.*多个|fix.*multiple/i,
    /创建.*文件.*并|create.*files.*and/i,
    /修改.*多个|modify.*multiple/i,
    /搜索.*然后|search.*then/i,
    /查找.*修改|find.*modify/i,
    /分析.*修复|analyze.*fix/i,
    /全面|comprehensive/i,
    /整个|entire|whole/i,
    /所有|all\s+/i,
  ]
  return complexPatterns.some(p => p.test(userMessage))
}

// 动态工具选择：根据任务类型暴露不同工具集
function selectToolsForTask(toolCalls: Array<{ function: { name: string } }>): string[] {
  const names = toolCalls.map(tc => tc.function.name)

  // 读取类任务
  if (names.every(n => ['read_file', 'glob', 'grep', 'lsp_hover', 'lsp_references', 'lsp_definition'].includes(n))) {
    return ['read_file', 'glob', 'grep', 'think', 'lsp_hover', 'lsp_references', 'lsp_definition']
  }

  // 修改类任务
  if (names.some(n => ['write_file', 'edit_file', 'patch_file'].includes(n))) {
    return ['read_file', 'write_file', 'edit_file', 'patch_file', 'glob', 'grep', 'think']
  }

  // 命令执行类
  if (names.some(n => n === 'bash' || n === 'test_runner')) {
    return ['bash', 'test_runner', 'read_file', 'glob', 'grep', 'think']
  }

  // 搜索类
  if (names.some(n => n === 'web_search' || n === 'fetch')) {
    return ['web_search', 'fetch', 'read_file', 'think']
  }

  // 默认：返回所有活跃工具
  return []
}

// ─── 自动验证：编辑后自动 lint/typecheck ────────────────────────────────
interface AutoVerifyResult {
  hasErrors: boolean
  output: string
}

async function autoVerifyEdit(filePath: string): Promise<AutoVerifyResult> {
  const { resolve: pathResolve, extname, basename, join, dirname } = await import('path')
  const { existsSync, readFileSync } = await import('fs')
  const { execSync } = await import('child_process')

  const absPath = pathResolve(filePath)
  const ext = extname(absPath)
  const dir = dirname(absPath)

  // 检测项目类型
  const isNode = existsSync(join(dir, 'package.json')) || existsSync('package.json')
  const isPython = ext === '.py' || existsSync(join(dir, 'pyproject.toml')) || existsSync('pyproject.toml')
  const isGo = ext === '.go' || existsSync(join(dir, 'go.mod')) || existsSync('go.mod')
  const isTS = ['.ts', '.tsx'].includes(ext)

  const results: string[] = []

  try {
    // TypeScript 类型检查
    if (isTS && isNode) {
      try {
        execSync(`npx tsc --noEmit --skipLibCheck ${absPath}`, {
          encoding: 'utf-8',
          timeout: 10000,
          cwd: dir,
        })
        results.push('✅ tsc: 无类型错误')
      } catch (ex: any) {
        const stderr = (ex.stderr || '').trim()
        const stdout = (ex.stdout || '').trim()
        const errOutput = stderr || stdout
        if (errOutput) {
          // 只取前 5 行错误
          const errLines = errOutput.split('\n').slice(0, 5).join('\n')
          results.push(`⚠️ tsc 错误:\n${errLines}`)
        }
      }
    }

    // ESLint
    if ((isTS || ext === '.js' || ext === '.jsx') && isNode) {
      try {
        const eslintPath = join(dir, 'node_modules', '.bin', 'eslint')
        if (existsSync(eslintPath)) {
          execSync(`npx eslint ${absPath} --format compact --no-error-on-unmatched-pattern 2>/dev/null`, {
            encoding: 'utf-8',
            timeout: 10000,
            cwd: dir,
          })
          results.push('✅ eslint: 无错误')
        }
      } catch (ex: any) {
        const output = (ex.stdout || '').trim()
        if (output && !output.includes('not found') && !output.includes('Cannot find')) {
          const errLines = output.split('\n').slice(0, 5).join('\n')
          results.push(`⚠️ eslint:\n${errLines}`)
        }
      }
    }

    // Python syntax check
    if (isPython) {
      try {
        execSync(`python3 -m py_compile ${absPath}`, {
          encoding: 'utf-8',
          timeout: 10000,
        })
        results.push('✅ py_compile: 语法正确')
      } catch (ex: any) {
        const errOutput = (ex.stderr || ex.stdout || '').trim()
        if (errOutput) {
          const errLines = errOutput.split('\n').slice(0, 5).join('\n')
          results.push(`⚠️ Python 语法错误:\n${errLines}`)
        }
      }
    }

    // Go vet
    if (isGo) {
      try {
        execSync(`go vet ${absPath}`, {
          encoding: 'utf-8',
          timeout: 10000,
        })
        results.push('✅ go vet: 无问题')
      } catch (ex: any) {
        const errOutput = (ex.stderr || '').trim()
        if (errOutput) {
          const errLines = errOutput.split('\n').slice(0, 5).join('\n')
          results.push(`⚠️ go vet:\n${errLines}`)
        }
      }
    }
  } catch {
    // 验证过程出错不影响主流程
  }

  if (results.length === 0) {
    return { hasErrors: false, output: '' }
  }

  const hasErrors = results.some(r => r.startsWith('⚠️'))
  return { hasErrors, output: results.join('\n') }
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

  // CC-inspired State tracking
  const state: QueryState = {
    turn: 0,
    messages,
    toolUseBlocks: [],
    needsFollowUp: false,
    transition: undefined,
    totalToolRounds: 0,
    lastCallRecord: null,
    taskId: null,
    streamingResults: new Map(),
  }

  // 缓存预热（首次请求前，预填 KV cache）
  warmupCache(config).catch(() => {})

  // eslint-disable-next-line no-constant-condition
  while (true) {
    state.turn++
    const turn = state.turn
    onTurn?.(turn)

    // ─── 上下文管理 ───────────────────────────────────────────────
    // 刷新 git 状态（每轮开始时）
    if (turn > 1) {
      collectContext(true)
    }

    // Token 预算检查
    const decision = checkBudget(budget, messages)
    if (decision.action === 'stop') {
      state.transition = { reason: 'budget_exceeded', detail: '上下文已满' }
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

    // 5层压缩流水线（CC-inspired）
    // Layer 1: 每轮截断超大工具结果
    // Layer 2: 超过16条消息时 microcompact
    // Layer 3: 超过200K时 auto compact
    const { messages: compacted, stagesRun } = runCompactionPipeline(messages)
    if (stagesRun.length > 0) {
      messages.length = 0
      messages.push(...compacted)
      onText?.(`\n📝 压缩流水线: ${stagesRun.join(' → ')}，继续工作...\n`)
    }

    // ─── LLM 调用（带 StreamingToolExecutor）──────────────────────
    // 重置流式工具结果
    state.streamingResults = new Map()

    const streamingCallbacks = onToken || true ? {
      onToken: onToken || (() => {}),
      onToolUse: (tc: ToolCall) => {
        // StreamingToolExecutor：工具块完成，立即开始执行
        let args: Record<string, any>
        try { args = JSON.parse(tc.function.arguments) } catch { args = {} }
        onToolStart?.(tc.function.name, tc.function.arguments)

        // 异步执行，不阻塞流式接收
        const promise = (async (): Promise<StreamingToolResult> => {
          // 权限检查
          const perm = checkPermission(tc.function.name)
          if (!perm.allowed) {
            return { toolCallId: tc.id, toolName: tc.function.name, args, result: { content: perm.reason!, isError: true } }
          }
          // 执行
          const result = await executeToolWithRetry(tc.function.name, args, callbacks)
          onToolResult?.(tc.function.name, result)
          return { toolCallId: tc.id, toolName: tc.function.name, args, result }
        })()

        state.streamingResults.set(tc.id, promise)
      },
    } : undefined

    let response
    try {
      response = await callLLM(messages, tools, config, streamingCallbacks)
    } catch (ex: unknown) {
      state.transition = { reason: 'model_error', detail: ex instanceof Error ? ex.message : String(ex) }
      onError?.(ex instanceof Error ? ex.message : String(ex))
      break
    }

    // 记录 token 用量
    if (response.usage) {
      tracker.recordTurn(response.usage)
      onUsage?.(response.usage, config.model)
      recordCost(response.usage, config.model, 'chat')
    }

    // 非流式时回调文本
    if (!onToken && response.content) onText?.(response.content)

    // ─── needsFollowUp 判断（CC-inspired）──────────────────────
    // 核心：模型有工具调用 → needsFollowUp=true → 循环继续
    //       模型没有工具调用 → needsFollowUp=false → 准备退出
    state.toolUseBlocks = response.toolCalls?.length
      ? response.toolCalls.map(tc => ({
          id: tc.id,
          name: tc.function.name,
          args: JSON.parse(tc.function.arguments || '{}'),
        }))
      : []

    state.needsFollowUp = state.toolUseBlocks.length > 0

    if (!state.needsFollowUp) {
      // 自我检查：如果之前有工具调用且没有做自我检查，做一次最终验证
      if (state.totalToolRounds > 0 && !response.content?.includes('SELF_CHECK_PASS')) {
        const lastMsg = messages[messages.length - 1]
        if (lastMsg?.content !== SELF_CHECK_PROMPT) {
          messages.push({ role: 'user', content: SELF_CHECK_PROMPT })
          state.transition = { reason: 'self_check', detail: '注入自我检查' }
          continue
        }
      }

      // ─── Stop Hooks（CC-inspired）──────────────────────────────
      // 模型停止调用工具时，hooks 可以注入 blocking error 强制继续
      if (state.totalToolRounds > 0) {
        const stopResult = await executeStopHooks({
          messages: messages as any,
          turnCount: state.turn,
          totalToolRounds: state.totalToolRounds,
        })

        if (stopResult.blockingErrors.length > 0 && !stopResult.preventContinuation) {
          // 注入 blocking error 为用户消息，循环继续
          for (const error of stopResult.blockingErrors) {
            messages.push({ role: 'user', content: error, isMeta: true } as any)
          }
          state.transition = { reason: 'stop_hook_blocking', detail: `${stopResult.blockingErrors.length} 个 stop hook 注入` }
          continue  // ← 循环不退出！
        }
      }

      // ─── Token Budget 强制继续（CC-inspired）─────────────────
      // 模型想停，但还有预算？注入 nudge 强制继续
      // 比 stop hooks 更底层：stop hooks 检查任务完成度，这里检查资源余额
      if (state.totalToolRounds > 0) {
        const budgetDecision = checkBudget(budget, messages)
        if (budgetDecision.nudgeMessage && budgetDecision.action === 'continue') {
          messages.push({ role: 'user', content: `[Token Budget] ${budgetDecision.nudgeMessage}` })
          state.transition = { reason: 'next_turn', detail: 'token budget 强制继续' }
          continue  // ← 还有预算，不让它停
        }
      }

      // 清理 SELF_CHECK_PASS 标记
      const cleanContent = response.content?.replace('SELF_CHECK_PASS', '').trim() || response.content
      messages.push({ role: 'assistant', content: cleanContent })

      // 标记任务完成
      if (state.taskId) {
        updateTaskStatus(state.taskId, 'completed')
      }

      state.transition = { reason: 'completed', detail: `共 ${state.totalToolRounds} 轮工具调用` }
      break
    }

    // 有工具调用
    messages.push({ role: 'assistant', content: response.content, tool_calls: response.toolCalls })

    // ─── 循环调用检测 ─────────────────────────────────────────────
    if (response.toolCalls.length === 1) {
      const tc = response.toolCalls[0]
      const args = JSON.parse(tc.function.arguments)
      const newRecord = detectLoop(state.lastCallRecord, tc.function.name, args)

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
        state.lastCallRecord = null
        state.transition = { reason: 'loop_detected', detail: `${tc.function.name} x${newRecord.count}` }
        continue
      }
      state.lastCallRecord = newRecord
    } else {
      state.lastCallRecord = null
    }

    // ─── 并行工具执行 ─────────────────────────────────────────────
    state.totalToolRounds++
    if (state.totalToolRounds > MAX_TOOL_ROUNDS) {
      state.transition = { reason: 'max_turns', detail: `已达 ${MAX_TOOL_ROUNDS} 轮上限` }
      onError?.(`已达到最大工具调用轮数（${MAX_TOOL_ROUNDS}）。请使用 /compact 压缩后继续。`)
      break
    }

    // 创建任务记录（首次工具调用时）
    const sessionId = getWorkspaceSessionId()
    if (!state.taskId && response.toolCalls.length > 0) {
      const planJson = JSON.stringify({ turn, toolCalls: response.toolCalls.map(tc => tc.function.name) })
      state.taskId = createTask(sessionId, planJson, response.toolCalls.length)
      if (state.taskId) {
        updateTaskStatus(state.taskId, 'running')
      }
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

    // ─── 并行工具执行（StreamingToolExecutor 优先使用流式结果）────────
    const toolPromises = response.toolCalls.map(async (tc) => {
      // 如果流式接收期间已执行过，直接用结果
      const streamingResult = state.streamingResults.get(tc.id)
      if (streamingResult) {
        const resolved = await streamingResult
        // 已处理的工具需要补充文件变更追踪、自动 commit 等
        return { toolCallId: resolved.toolCallId, result: resolved.result, toolName: resolved.toolName, args: resolved.args }
      }

      // 非流式执行（兜底）
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
      const isFileEdit = toolName === 'write_file' || toolName === 'edit_file' || toolName === 'patch_file'
      if (isFileEdit) {
        beforeSnapshot = snapshotBefore(args.file_path)
      }

      // 执行工具（带重试 + 自动调试）
      let result = await executeToolWithRetry(toolName, args, callbacks)

      // 自动调试：失败时收集错误信息并反馈给 LLM
      if (result.isError && toolName !== 'think' && toolName !== 'tool_search') {
        const debugCtx = collectDebugContext(toolName, args, result, 0, 3)
        if (debugCtx) {
          const debugResult = shouldAutoRetry(debugCtx)
          if (debugResult.shouldRetry) {
            // 将调试上下文附加到结果中，让 LLM 看到
            const feedback = buildDebugFeedback(debugCtx)
            result = { ...result, content: result.content + '\n\n' + feedback }
            onText?.(`\n${formatDebugSummary(debugCtx)}\n`)
          }
        }
      }

      // 文件变更追踪：记录变更
      if (isFileEdit) {
        const change = recordChange(args.file_path, toolName, beforeSnapshot)
        if (change && !result.isError) {
          const summary = formatChangeSummary(change)
          result = { ...result, content: result.content + ` [${summary}]` }

          // 自动 stage 修改的文件
          try { stageFile(args.file_path) } catch {}
        }
      }

      // Post-tool hooks
      result = await executePostToolHooks(toolName, args, result)

      // 自动验证：编辑文件后自动 lint/typecheck
      if (isFileEdit && !result.isError) {
        const verifyResult = await autoVerifyEdit(args.file_path)
        if (verifyResult.output) {
          if (verifyResult.hasErrors) {
            // 有错误，附加到结果中让 LLM 看到并修复
            result = { ...result, content: result.content + '\n\n🔍 自动验证:\n' + verifyResult.output }
            onText?.(`\n⚠️ 编辑验证发现问题:\n${verifyResult.output}\n`)
          } else {
            // 无错误，静默通过
            onText?.(`\n${verifyResult.output}\n`)
          }
        }
      }

      // 任务步进追踪
      if (state.taskId) {
        const stepNum = toolResults.length + 1
        addTaskStep(state.taskId, {
          step: stepNum,
          tool: toolName,
          args: JSON.stringify(args).slice(0, 200),
          result: result.content.slice(0, 200),
          status: result.isError ? 'failed' : 'completed',
          duration: 0,
        })
        updateTaskStep(state.taskId, stepNum)
      }

      onToolResult?.(toolName, result)
      return { toolCallId: tc.id, result, toolName, args }
    })

    // 等待所有工具完成
    const toolResults = await Promise.all(toolPromises)

    // 自动 commit：如果有文件修改，自动提交
    const modifiedFiles = toolResults
      .filter(r => !r.result.isError && (r.toolName === 'write_file' || r.toolName === 'edit_file' || r.toolName === 'patch_file'))
      .map(r => r.args.file_path)
      .filter(Boolean)

    if (modifiedFiles.length > 0) {
      const commitResult = autoCommit(modifiedFiles)
      if (commitResult.success && commitResult.hash) {
        trackAICommit(commitResult.hash)
        onText?.(`\n${commitResult.message}\n`)
      }
    }

    // 将结果加入消息
    for (const { toolCallId, result } of toolResults) {
      messages.push({ role: 'tool', tool_call_id: toolCallId, content: result.content })
    }

    // 反思机制：注入反思提示（在工具结果之后，下一轮 LLM 调用之前）
    const hasErrors = toolResults.some(r => r.result.isError)
    if (hasErrors || toolResults.length > 1) {
      // 有错误或多个工具调用时，注入反思消息
      messages.push({
        role: 'system',
        content: REFLECTION_PROMPT,
      })
    }

    // 任务完成/失败时更新状态
    if (state.taskId) {
      if (hasErrors) {
        updateTaskStatus(state.taskId, 'failed', toolResults.find(r => r.result.isError)?.result.content.slice(0, 200))
      }
    }

    // 成本追踪
    if (response.usage) {
      recordCost(response.usage, config.model, 'tool')
      const alert = checkBudgetLimit()
      if (alert) {
        onText?.(`\n${alert.message}\n`)
        if (alert.level === 'exceeded') {
          // 尝试降级模型
          const downgraded = getDowngradedModel(config.model)
          if (downgraded) {
            config.model = downgraded
            onText?.(`\n📉 模型已降级到: ${downgraded}\n`)
          } else {
            state.transition = { reason: 'budget_exceeded', detail: '预算用尽且无降级模型' }
            onError?.('预算已用尽且无可用降级模型。请增加预算或明天再试。')
            break
          }
        }
      }
    }

    // 下一轮
    state.transition = { reason: 'next_turn', detail: `${toolResults.length} 个工具结果` }
  } // while (true)

  // 输出 transition 日志（调试用）
  if (state.transition) {
    onText?.(`\n[loop] 退出原因: ${state.transition.reason}${state.transition.detail ? ` — ${state.transition.detail}` : ''}\n`)
  }

  // 保存会话到 SQLite
  saveSessionDB(undefined, messages)
  return messages
}
