// ─── 命令系统（CC commands.ts 风格）────────────────────────────────────────
import { existsSync, unlinkSync, readFileSync, writeFileSync } from 'fs'
import { getSessionFile, saveSession, loadSession, loadConfig, type Message } from '../config/index.js'
import { COMPACT_PROMPT, buildCompactedMessages, getCompactionRequest } from '../memory/compact.js'

export interface Command {
  name: string
  description: string
  aliases?: string[]
  argumentHint?: string
  execute: (args: string, context: CommandContext) => CommandResult | Promise<CommandResult>
}

export interface CommandContext {
  messages: Message[]
  clearMessages: () => void
}

export interface CommandResult {
  type: 'info' | 'action' | 'error' | 'compact'
  content: string
  clearHistory?: boolean
  compactedMessages?: Message[]
}

// ─── /help ─────────────────────────────────────────────────────────────
const help: Command = {
  name: 'help',
  description: '显示帮助',
  aliases: ['h', '?'],
  execute: () => ({
    type: 'info',
    content: `edgecli 命令

  /help (?/ h/)      显示帮助
  /clear             清除对话历史
  /compact           压缩上下文，保留摘要
  /history           查看消息统计
  /config            查看当前配置
  /quit (q/ exit/)   退出`,
  }),
}

// ─── /clear ────────────────────────────────────────────────────────────
const clear: Command = {
  name: 'clear',
  description: '清除对话历史，释放上下文',
  aliases: ['reset', 'new'],
  execute: (_, ctx) => {
    const f = getSessionFile()
    if (existsSync(f)) unlinkSync(f)
    ctx.clearMessages()
    return { type: 'action', content: '🗑️ 对话已清除。', clearHistory: true }
  },
}

// ─── /compact（CC 风格：压缩上下文）─────────────────────────────────────
const compact: Command = {
  name: 'compact',
  description: '压缩上下文，保留摘要继续工作',
  aliases: [],
  argumentHint: '<可选：自定义压缩指令>',
  execute: (_, ctx) => {
    const msgs = ctx.messages
    if (msgs.length < 4) {
      return { type: 'info', content: '对话太短，无需压缩。' }
    }
    // CC 风格：返回压缩指令，由 query 引擎执行
    return {
      type: 'compact',
      content: '📝 正在压缩上下文…',
      compactedMessages: getCompactionRequest(msgs),
    }
  },
}

// ─── /history ──────────────────────────────────────────────────────────
const history: Command = {
  name: 'history',
  description: '查看消息统计',
  execute: (_, ctx) => {
    const m = ctx.messages
    const user = m.filter(x => x.role === 'user').length
    const tool = m.filter(x => x.role === 'tool').length
    const assistant = m.filter(x => x.role === 'assistant').length
    return { type: 'info', content: `📜 ${m.length} 条消息（${user} 用户，${assistant} 助手，${tool} 工具）` }
  },
}

// ─── /config ───────────────────────────────────────────────────────────
const config: Command = {
  name: 'config',
  description: '查看当前配置',
  execute: () => {
    const c = loadConfig()
    return {
      type: 'info',
      content: `配置
  格式: ${c.provider || 'auto'}
  地址: ${c.baseUrl}
  模型: ${c.model}
  密钥: ${c.apiKey ? c.apiKey.slice(0, 8) + '...' : '(未设置)'}`,
    }
  },
}

// ─── /resume（CC 风格：恢复上次对话）─────────────────────────────────────
const resume: Command = {
  name: 'resume',
  description: '恢复上次对话',
  aliases: ['continue'],
  execute: (_, ctx) => {
    const msgs = loadSession()
    if (msgs.length === 0) {
      return { type: 'info', content: '没有可恢复的对话。' }
    }
    const userMsgs = msgs.filter(m => m.role === 'user')
    const lastUser = userMsgs[userMsgs.length - 1]
    return {
      type: 'info',
      content: `已恢复 ${msgs.length} 条消息的对话。\n上次用户消息: ${lastUser?.content?.slice(0, 80) || '(无)'}`,
    }
  },
}

// ─── /quit ─────────────────────────────────────────────────────────────
const quit: Command = {
  name: 'quit',
  description: '退出',
  aliases: ['q', 'exit'],
  execute: () => { process.exit(0); return { type: 'info', content: '' } },
}

// ─── 注册表 ────────────────────────────────────────────────────────────
const COMMANDS: Command[] = [help, clear, compact, history, config, resume, quit]

export function processCommand(input: string, context: CommandContext): CommandResult | Promise<CommandResult> | null {
  if (!input.startsWith('/')) return null
  const sp = input.indexOf(' ')
  const name = sp === -1 ? input.slice(1) : input.slice(1, sp)
  const args = sp === -1 ? '' : input.slice(sp + 1).trim()
  const cmd = COMMANDS.find(c => c.name === name || c.aliases?.includes(name))
  if (!cmd) return { type: 'error', content: `未知命令: /${name}。试试 /help` }
  return cmd.execute(args, context)
}

export function listCommands(): Command[] { return COMMANDS }
