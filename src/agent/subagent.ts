// ─── 子代理系统（OpenClaw Sub-agent 风格）───────────────────────────────────
// OpenClaw 的子代理：隔离会话、独立上下文、异步执行
// 子代理有独立的 token 预算和系统提示词

import { type Message } from '../config/index.js'
import { callLLM, type LLMResponse } from '../api/index.js'
import { toOpenAI, toAnthropic, findTool, type ToolResult } from '../tools/index.js'
import { detectProvider } from '../config/index.js'

export interface SubAgentResult {
  content: string
  messages: Message[]
  tokensUsed: number
  error?: string
}

export interface SubAgentOptions {
  task: string
  maxTurns?: number
  allowedTools?: string[]  // 白名单（OpenClaw 风格）
  blockedTools?: string[]  // 黑名单
  systemPromptSuffix?: string
}

// 子代理的精简系统提示词（OpenClaw minimal 模式）
const MINIMAL_SYSTEM_PROMPT = `你是一个子代理，负责执行一个特定任务。
专注于完成分配的任务，不要执行其他操作。
完成后返回结果。`

// 运行子代理
export async function runSubAgent(
  options: SubAgentOptions,
  config: any
): Promise<SubAgentResult> {
  const { task, maxTurns = 10, allowedTools, blockedTools, systemPromptSuffix } = options

  const messages: Message[] = [
    { role: 'system', content: MINIMAL_SYSTEM_PROMPT + (systemPromptSuffix ? '\n' + systemPromptSuffix : '') },
    { role: 'user', content: task },
  ]

  // 过滤工具（白名单/黑名单）
  let allTools = detectProvider(config) === 'anthropic' ? toAnthropic() : toOpenAI()
  if (allowedTools) {
    allTools = allTools.filter((t: any) => {
      const name = t.name || t.function?.name
      return allowedTools.includes(name)
    })
  }
  if (blockedTools) {
    allTools = allTools.filter((t: any) => {
      const name = t.name || t.function?.name
      return !blockedTools.includes(name)
    })
  }

  for (let turn = 1; turn <= maxTurns; turn++) {
    let response: LLMResponse
    try {
      response = await callLLM(messages, allTools as any, config)
    } catch (ex: any) {
      return { content: '', messages, tokensUsed: 0, error: ex.message }
    }

    // 没有工具调用 → 完成
    if (!response.toolCalls?.length) {
      messages.push({ role: 'assistant', content: response.content })
      return { content: response.content, messages, tokensUsed: 0 }
    }

    messages.push({ role: 'assistant', content: response.content, tool_calls: response.toolCalls })

    // 执行工具
    for (const tc of response.toolCalls) {
      const tool = findTool(tc.function.name)
      let result: ToolResult

      if (!tool) {
        result = { content: `未知工具: ${tc.function.name}`, isError: true }
      } else {
        try { result = await tool.execute(JSON.parse(tc.function.arguments)) }
        catch (ex: any) { result = { content: ex.message, isError: true } }
      }

      messages.push({ role: 'tool', tool_call_id: tc.id, content: result.content })
    }
  }

  return { content: '子代理达到最大轮次限制', messages, tokensUsed: 0, error: 'max_turns' }
}
