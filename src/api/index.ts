// ─── API 层：SDK 流式输出 ───────────────────────────────────────────────────
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { CodoConfig, Message, ToolCall, getApiKey, detectProvider } from '../config/index.js'

export interface LLMResponse { content: string; toolCalls: ToolCall[] }

const MAX_RETRIES = 3

// 流式回调接口
export interface StreamCallbacks {
  onToken: (token: string) => void
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)) }

function isRetryable(err: any): boolean {
  const status = err?.status
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 529
}

// ─── Anthropic 格式（SDK）─────────────────────────────────────────────
async function callAnthropic(
  messages: Message[], tools: any[], config: CodoConfig, stream?: StreamCallbacks, thinking?: boolean
): Promise<LLMResponse> {
  const key = getApiKey(config)
  if (!key) throw new Error('未配置 API Key')

  const isLC = config.baseUrl.includes('longcat')
  const client = new Anthropic({
    apiKey: key,
    baseURL: config.baseUrl.replace(/\/$/, ''),
    defaultHeaders: isLC ? { Authorization: `Bearer ${key}` } : undefined,
    dangerouslyAllowBrowser: true,
  })

  // 转换消息格式
  let system = ''
  const chat: any[] = []
  for (const m of messages) {
    if (m.role === 'system') { system = m.content; continue }
    if (m.role === 'tool') {
      chat.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }] })
      continue
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const parts: any[] = []
      if (m.content) parts.push({ type: 'text', text: m.content })
      for (const tc of m.tool_calls) {
        parts.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: JSON.parse(tc.function.arguments) })
      }
      chat.push({ role: 'assistant', content: parts })
      continue
    }
    chat.push(m)
  }

  // tools 已经是 Anthropic 格式：{ name, description, input_schema }
  const toolDefs = tools?.length ? tools as any[] : undefined

  // 带重试的流式调用
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (stream) {
        const response = await client.messages.create({
          model: config.model, max_tokens: config.maxTokens, system, messages: chat,
          tools: toolDefs,
          ...(thinking ? { thinking: { type: 'enabled', budget_tokens: 10000 } } : {}),
          stream: true,
        })

        let content = ''
        const toolCalls: ToolCall[] = []
        let currentTool: any = null

        for await (const event of response) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            content += event.delta.text
            stream.onToken(event.delta.text)
          }
          if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
            currentTool = { id: event.content_block.id, type: 'function', function: { name: event.content_block.name, arguments: '' } }
          }
          if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta' && currentTool) {
            currentTool.function.arguments += event.delta.partial_json
          }
          if (event.type === 'content_block_stop' && currentTool) {
            toolCalls.push(currentTool)
            currentTool = null
          }
        }
        return { content, toolCalls }
      }

      // 非流式
      const msg = await client.messages.create({
        model: config.model, max_tokens: config.maxTokens, system, messages: chat,
        tools: toolDefs,
        ...(thinking ? { thinking: { type: 'enabled', budget_tokens: 10000 } } : {}),
      })
      let content = ''
      const toolCalls: ToolCall[] = []
      for (const b of msg.content) {
        if (b.type === 'text') content += b.text
        if (b.type === 'tool_use') toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) } })
      }
      return { content, toolCalls }

    } catch (ex: any) {
      if (isRetryable(ex) && attempt < MAX_RETRIES) {
        const delay = 1000 * Math.pow(2, attempt) + Math.random() * 500
        const waitSec = Math.round(delay / 1000)
        process.stderr.write(`\n⏳ API ${ex.status}，${waitSec}秒后重试（${attempt + 1}/${MAX_RETRIES}）\n`)
        await sleep(delay)
        continue
      }
      throw new Error(`API 错误: ${ex.message}`)
    }
  }
  throw new Error('重试次数耗尽')
}

// ─── OpenAI 格式（SDK）─────────────────────────────────────────────────
async function callOpenAI(
  messages: Message[], tools: any[], config: CodoConfig, stream?: StreamCallbacks
): Promise<LLMResponse> {
  const key = getApiKey(config)
  if (!key) throw new Error('未配置 API Key')

  const client = new OpenAI({
    apiKey: key,
    baseURL: config.baseUrl.replace(/\/$/, ''),
  })

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (stream) {
        const response = await client.chat.completions.create({
          model: config.model, messages, tools, max_tokens: config.maxTokens,
          stream: true,
        } as any)

        let content = ''
        const toolCallMap: Record<number, ToolCall> = {}

        for await (const chunk of response) {
          const delta = chunk.choices?.[0]?.delta
          if (delta?.content) {
            content += delta.content
            stream.onToken(delta.content)
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index
              if (!toolCallMap[idx]) {
                toolCallMap[idx] = { id: tc.id || '', type: 'function', function: { name: tc.function?.name || '', arguments: '' } }
              }
              if (tc.function?.arguments) toolCallMap[idx].function.arguments += tc.function.arguments
            }
          }
        }
        return { content, toolCalls: Object.values(toolCallMap) }
      }

      // 非流式
      const resp = await client.chat.completions.create({
        model: config.model, messages, tools, max_tokens: config.maxTokens,
      })
      const m = resp.choices?.[0]?.message ?? {}
      return { content: m.content ?? '', toolCalls: m.tool_calls?.map((tc: any) => ({
        id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments }
      })) ?? [] }

    } catch (ex: any) {
      if (isRetryable(ex) && attempt < MAX_RETRIES) {
        const delay = 1000 * Math.pow(2, attempt) + Math.random() * 500
        process.stderr.write(`\n⏳ API ${ex.status}，${Math.round(delay/1000)}秒后重试（${attempt + 1}/${MAX_RETRIES}）\n`)
        await sleep(delay)
        continue
      }
      throw new Error(`API 错误: ${ex.message}`)
    }
  }
  throw new Error('重试次数耗尽')
}

// ─── 统一入口 ──────────────────────────────────────────────────────────
export async function callLLM(
  messages: Message[], tools: any[], config: CodoConfig, stream?: StreamCallbacks
): Promise<LLMResponse> {
  return detectProvider(config) === 'anthropic'
    ? callAnthropic(messages, tools, config, stream)
    : callOpenAI(messages, tools, config, stream)
}
