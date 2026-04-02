// ─── Hook 系统（CC + Codex 混合风格）────────────────────────────────────
// 支持 5 种事件类型：PreToolUse, PostToolUse, PostToolUseFailure,
//   SessionStart, UserPromptSubmit, Stop
// 特性：
//   - turn_id 追踪（Codex 模式）
//   - HookResult 状态机：Success / FailedContinue / FailedAbort
//   - 钩子执行超时控制
//   - 钩子执行日志
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import type { ToolResult } from '../tools/index.js'
import { evaluateExecution } from './policy.js'
import { executeShellHook, HookEvent as ShellHookEvent } from './system.js'

// ─── Hook 类型（扩展版）────────────────────────────────────────────────
export type HookEventType =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'Stop'

export interface HookInput {
  hook_event_name: HookEventType
  session_id?: string
  turn_id?: string
  cwd?: string
  model?: string
  tool_name: string
  tool_input: Record<string, any>
  tool_output?: string
  tool_error?: string
  // SessionStart
  source?: 'startup' | 'resume' | 'clear'
  // UserPromptSubmit
  prompt?: string
  // Stop
  stop_hook_active?: boolean
  last_assistant_message?: string
}

// Codex 风格的 HookResult 状态机
export type HookResult =
  | { type: 'Success' }
  | { type: 'FailedContinue'; error: string }
  | { type: 'FailedAbort'; error: string }

export function hookResultShouldAbort(result: HookResult): boolean {
  return result.type === 'FailedAbort'
}

export interface HookOutput {
  hookSpecificOutput?: {
    hookEventName: HookEventType
    permissionBehavior?: 'allow' | 'deny' | 'ask'
    blockingMessage?: string
    // Codex 模式：updated_input 允许钩子修改工具输入
    updatedInput?: Record<string, any>
    // 额外上下文，注入到对话中
    additionalContext?: string
  }
  // 新增：钩子执行结果
  result?: HookResult
}

export type HookFn = (input: HookInput) => Promise<HookOutput | null>

// ─── Hook 执行配置 ─────────────────────────────────────────────────────
const HOOK_TIMEOUT_MS = 10_000  // 单个钩子最大执行时间

// ─── Hook 注册表（扩展版）────────────────────────────────────────────
const preToolHooks: HookFn[] = []
const postToolHooks: HookFn[] = []
const postToolFailureHooks: HookFn[] = []
const sessionStartHooks: HookFn[] = []
const userPromptSubmitHooks: HookFn[] = []
const stopHooks: HookFn[] = []

// ─── Turn ID 追踪（Codex 模式）─────────────────────────────────────────
let currentTurnId: string = ''

export function generateTurnId(): string {
  currentTurnId = `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  return currentTurnId
}

export function getCurrentTurnId(): string {
  return currentTurnId
}

// ─── 注册函数（扩展版）────────────────────────────────────────────────
export function registerPreToolHook(hook: HookFn) { preToolHooks.push(hook) }
export function registerPostToolHook(hook: HookFn) { postToolHooks.push(hook) }
export function registerPostToolFailureHook(hook: HookFn) { postToolFailureHooks.push(hook) }
export function registerSessionStartHook(hook: HookFn) { sessionStartHooks.push(hook) }
export function registerUserPromptSubmitHook(hook: HookFn) { userPromptSubmitHooks.push(hook) }
export function registerStopHook(hook: HookFn) { stopHooks.push(hook) }

// ─── 带超时的钩子执行 ─────────────────────────────────────────────────
async function executeHookWithTimeout(hook: HookFn, input: HookInput): Promise<HookOutput | null> {
  return Promise.race([
    hook(input),
    new Promise<null>((resolve) => {
      setTimeout(() => {
        console.error(`[hook] 钩子 ${hook.name || 'anonymous'} 执行超时 (${HOOK_TIMEOUT_MS}ms)`)
        resolve(null)
      }, HOOK_TIMEOUT_MS)
    }),
  ])
}

// ─── 构建通用 HookInput ───────────────────────────────────────────────
function buildBaseInput(event: HookEventType, extra: Partial<HookInput> = {}): HookInput {
  return {
    hook_event_name: event,
    session_id: extra.session_id,
    turn_id: getCurrentTurnId(),
    cwd: process.cwd(),
    tool_name: extra.tool_name || '',
    tool_input: extra.tool_input || {},
    ...extra,
  }
}

// ─── PreToolUse Hooks ──────────────────────────────────────────────────
export async function executePreToolHooks(
  toolName: string,
  toolInput: Record<string, any>
): Promise<{ allowed: boolean; reason?: string }> {
  const input: HookInput = {
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
  }

  // 内置 hook：bash 执行策略（Codex AskForApproval 风格）
  if (toolName === 'bash') {
    const policy = evaluateExecution(toolInput.command)
    if (!policy.allowed) {
      return { allowed: false, reason: `🚫 ${policy.reason}: ${toolInput.command}` }
    }
  }

  // 内置 hook：文件验证
  if (toolName === 'edit_file') {
    const path = resolve(toolInput.file_path)
    if (!existsSync(path)) return { allowed: false, reason: `文件不存在: ${toolInput.file_path}` }
    try {
      const content = readFileSync(path, 'utf-8')
      const count = content.split(toolInput.old_string).length - 1
      if (count === 0) return { allowed: false, reason: 'old_string 未找到。文件可能已变更。' }
      if (count > 1) return { allowed: false, reason: `找到 ${count} 处匹配。需要更多上下文。` }
    } catch { return { allowed: false, reason: '无法读取文件。' } }
  }

  if (toolName === 'read_file') {
    const path = resolve(toolInput.file_path)
    if (!existsSync(path)) return { allowed: false, reason: `文件不存在: ${toolInput.file_path}` }
  }

  // 运行用户注册的 hooks（带超时）
  for (const hook of preToolHooks) {
    const output = await executeHookWithTimeout(hook, input)
    if (!output) continue

    // Codex 模式：FailedAbort → 立即拒绝
    if (output.result && output.result.type === 'FailedAbort') {
      return { allowed: false, reason: output.result.error }
    }
    if (output.hookSpecificOutput?.permissionBehavior === 'deny') {
      return { allowed: false, reason: output.hookSpecificOutput.blockingMessage }
    }
    // Codex 模式：updatedInput 允许钩子修改工具输入
    if (output.hookSpecificOutput?.updatedInput) {
      Object.assign(toolInput, output.hookSpecificOutput.updatedInput)
    }
  }

  // 运行 shell hook（~/.edgecli/hooks/pre-tool-use.sh）
  const shellResult = executeShellHook(ShellHookEvent.PreToolUse, {
    toolName,
    toolInput,
  })
  if (shellResult && !shellResult.allowed) {
    return { allowed: false, reason: shellResult.message || `Shell hook 拒绝了 ${toolName}` }
  }
  if (shellResult?.message && shellResult.allowed) {
    // 警告信息，附加到结果但不阻止
    process.stderr.write(`\n${shellResult.message}\n`)
  }

  return { allowed: true }
}

// ─── PostToolUse Hooks ─────────────────────────────────────────────────
export async function executePostToolHooks(
  toolName: string,
  toolInput: Record<string, any>,
  result: ToolResult
): Promise<ToolResult> {
  const input: HookInput = {
    hook_event_name: result.isError ? 'PostToolUseFailure' : 'PostToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    tool_output: result.content,
    tool_error: result.isError ? result.content : undefined,
  }

  // 内置 hook：错误检测
  if (!result.isError) {
    if (toolName === 'bash') {
      if (result.content.includes('command not found') || result.content.includes('No such file')) {
        return { ...result, content: `⚠️ ${result.content}` }
      }
    }
  }

  // 运行用户注册的 hooks
  for (const hook of result.isError ? postToolFailureHooks : postToolHooks) {
    const output = await hook(input)
    if (output?.hookSpecificOutput?.blockingMessage) {
      return { ...result, content: output.hookSpecificOutput.blockingMessage }
    }
  }

  // 运行 shell hook（~/.edgecli/hooks/post-tool-use.sh）
  const shellResult = executeShellHook(ShellHookEvent.PostToolUse, {
    toolName,
    toolInput,
    toolOutput: result.content,
    toolError: result.isError ? result.content : undefined,
  })
  if (shellResult?.message && !result.isError) {
    return { ...result, content: result.content + '\n' + shellResult.message }
  }

  return result
}

// ─── SessionStart Hooks（Codex 模式）───────────────────────────────────
// 会话启动时触发。可以注入额外上下文。
export interface SessionStartResult {
  additionalContexts: string[]
  aborted: boolean
  abortReason?: string
}

export async function executeSessionStartHooks(source: 'startup' | 'resume' | 'clear' = 'startup'): Promise<SessionStartResult> {
  const additionalContexts: string[] = []
  let aborted = false
  let abortReason: string | undefined

  const input = buildBaseInput('SessionStart', {
    tool_name: '',
    tool_input: {},
    source,
  })

  for (const hook of sessionStartHooks) {
    const output = await executeHookWithTimeout(hook, input)
    if (!output) continue

    if (output.result && output.result.type === 'FailedAbort') {
      aborted = true
      abortReason = output.result.error
      break
    }
    if (output.hookSpecificOutput?.additionalContext) {
      additionalContexts.push(output.hookSpecificOutput.additionalContext)
    }
  }

  // Shell hook
  const shellResult = executeShellHook(ShellHookEvent.PreToolUse, {
    toolName: 'session_start',
    toolInput: { source },
  })
  if (shellResult?.message && shellResult.allowed) {
    additionalContexts.push(shellResult.message)
  }

  return { additionalContexts, aborted, abortReason }
}

// ─── UserPromptSubmit Hooks（Codex 模式）───────────────────────────────
// 用户提交提示时触发。可以修改提示或阻止提交。
export interface UserPromptSubmitResult {
  additionalContexts: string[]
  blocked: boolean
  blockReason?: string
}

export async function executeUserPromptSubmitHooks(prompt: string): Promise<UserPromptSubmitResult> {
  const additionalContexts: string[] = []
  let blocked = false
  let blockReason: string | undefined

  const input = buildBaseInput('UserPromptSubmit', {
    tool_name: '',
    tool_input: {},
    prompt,
  })

  for (const hook of userPromptSubmitHooks) {
    const output = await executeHookWithTimeout(hook, input)
    if (!output) continue

    if (output.hookSpecificOutput?.permissionBehavior === 'deny') {
      blocked = true
      blockReason = output.hookSpecificOutput.blockingMessage || 'UserPromptSubmit hook 拒绝'
      break
    }
    if (output.hookSpecificOutput?.additionalContext) {
      additionalContexts.push(output.hookSpecificOutput.additionalContext)
    }
  }

  return { additionalContexts, blocked, blockReason }
}

// ─── Stop Hooks（增强版）──────────────────────────────────────────────
export interface StopHookResult {
  blockingErrors: string[]     // 注入到 messages 的错误信息
  preventContinuation: boolean // 是否阻止继续
  additionalContexts: string[] // 额外上下文
}

export async function executeStopHooks(context: {
  messages: Array<{ role: string; content: string }>
  turnCount: number
  totalToolRounds: number
  lastAssistantMessage?: string
}): Promise<StopHookResult> {
  const blockingErrors: string[] = []
  const additionalContexts: string[] = []
  let preventContinuation = false

  const input = buildBaseInput('Stop', {
    tool_name: '',
    tool_input: { turnCount: context.turnCount, totalToolRounds: context.totalToolRounds },
    stop_hook_active: false,
    last_assistant_message: context.lastAssistantMessage,
  })

  for (const hook of stopHooks) {
    const output = await executeHookWithTimeout(hook, input)
    if (!output) continue

    if (output.result && output.result.type === 'FailedAbort') {
      preventContinuation = true
      blockingErrors.push(output.result.error)
      break
    }
    if (output.hookSpecificOutput?.blockingMessage) {
      blockingErrors.push(output.hookSpecificOutput.blockingMessage)
    }
    if (output.hookSpecificOutput?.permissionBehavior === 'deny') {
      preventContinuation = true
    }
    if (output.hookSpecificOutput?.additionalContext) {
      additionalContexts.push(output.hookSpecificOutput.additionalContext)
    }
  }

  // Shell hook
  const shellResult = executeShellHook(ShellHookEvent.Stop, {
    toolName: '',
    toolInput: { turnCount: context.turnCount, totalToolRounds: context.totalToolRounds },
  })
  if (shellResult?.message) {
    blockingErrors.push(shellResult.message)
  }

  return { blockingErrors, preventContinuation, additionalContexts }
}
