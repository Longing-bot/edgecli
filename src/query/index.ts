// ─── Query Engine（CC 流式循环）────────────────────────────────────────────
import { CodoConfig, Message, detectProvider, saveSession } from '../config/index.js'
import { callLLM } from '../api/index.js'
import { findTool, toOpenAI, toAnthropic, ToolResult } from '../tools/index.js'
import { buildSystemPrompt } from '../prompts/system.js'
import { executePreToolHooks, executePostToolHooks } from '../hooks/index.js'
import { createBudgetTracker, checkBudget } from '../memory/index.js'
import { shouldFlushMemory, buildFlushMessages } from '../memory/flush.js'

const MAX_TURNS = 80

export interface QueryCallbacks {
  onText?: (text: string) => void
  onToken?: (token: string) => void   // 流式逐字回调
  onToolStart?: (name: string, args: string) => void
  onToolResult?: (name: string, result: ToolResult) => void
  onTurn?: (turn: number) => void
  onError?: (error: string) => void
}

export async function runQuery(
  userMessage: string,
  config: CodoConfig,
  messages: Message[],
  callbacks: QueryCallbacks = {},
): Promise<Message[]> {
  const { onText, onToken, onToolStart, onToolResult, onTurn, onError } = callbacks

  if (!messages.length || messages[0].role !== 'system') {
    messages.unshift({ role: 'system', content: buildSystemPrompt() })
  }

  messages.push({ role: 'user', content: userMessage })

  const tools = detectProvider(config) === 'anthropic' ? toAnthropic() : toOpenAI()
  const budget = createBudgetTracker()

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    onTurn?.(turn)

    // CC 风格：检查 token 预算
    const decision = checkBudget(budget, messages)
    if (decision.action === 'stop') {
      onError?.('上下文已满。请使用 /clear 清除历史或 /compact 压缩。')
      break
    }

    // OpenClaw 风格：压缩前自动记忆刷新
    if (shouldFlushMemory(messages)) {
      const flushMsgs = buildFlushMessages()
      // 将刷新消息注入到当前对话（模型会自动保存记忆）
      for (const m of flushMsgs) {
        if (!messages.some(existing => existing.content === m.content)) {
          messages.push(m)
        }
      }
    }

    // 如果需要 continue 提示，加入系统消息
    if (decision.nudgeMessage && !messages.some(m => m.content === decision.nudgeMessage)) {
      messages.push({ role: 'user', content: decision.nudgeMessage })
    }

    let response
    try {
      // 流式调用：有 onToken 就走流式
      response = await callLLM(messages, tools as any, config, onToken ? { onToken } : undefined)
    } catch (ex: any) {
      onError?.(ex.message)
      break
    }

    // 流式已经逐字输出，这里只在非流式时回调 onText
    if (!onToken && response.content) onText?.(response.content)

    // 没有 tool_calls → 结束
    if (!response.toolCalls?.length) {
      messages.push({ role: 'assistant', content: response.content })
      break
    }

    // 有 tool_calls → 执行工具
    messages.push({ role: 'assistant', content: response.content, tool_calls: response.toolCalls })

    for (const tc of response.toolCalls) {
      onToolStart?.(tc.function.name, tc.function.arguments)

      const tool = findTool(tc.function.name)
      let result: ToolResult

      if (!tool) {
        result = { content: `未知工具: ${tc.function.name}`, isError: true }
      } else {
        const args = JSON.parse(tc.function.arguments)
        const preCheck = await executePreToolHooks(tc.function.name, args)
        if (!preCheck.allowed) {
          result = { content: preCheck.reason!, isError: true }
        } else {
          try { result = await tool.execute(args) }
          catch (ex: any) { result = { content: ex.message, isError: true } }
          result = await executePostToolHooks(tc.function.name, args, result)
        }
      }

      onToolResult?.(tc.function.name, result)
      messages.push({ role: 'tool', tool_call_id: tc.id, content: result.content })
    }
  }

  saveSession(messages)
  return messages
}
