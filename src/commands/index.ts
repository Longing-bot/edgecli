// ─── 命令系统（CC commands.ts 风格）────────────────────────────────────────
import { existsSync, unlinkSync, readFileSync, writeFileSync } from 'fs'
import { getSessionFile, saveSession, loadSession, loadConfig, saveConfig, type Message } from '../config/index.js'
import { getCompactionRequest } from '../memory/compact.js'
import { getExecPolicy, setExecPolicy } from '../hooks/policy.js'

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
  /model             切换/查看模型
  /think             切换深度思考模式
  /policy            查看/切换执行策略
  /agent             运行子代理执行任务
  /resume            恢复上次对话
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

// ─── /model（CC 风格：切换模型）─────────────────────────────────────────
const model: Command = {
  name: 'model',
  description: '切换模型',
  aliases: [],
  argumentHint: '<模型名称>',
  execute: (args) => {
    if (!args) {
      const c = loadConfig()
      return { type: 'info', content: `当前模型: ${c.model}\n用法: /model <模型名称>` }
    }
    const c = loadConfig()
    c.model = args
    saveConfig(c)
    return { type: 'action', content: `✅ 已切换到: ${args}` }
  },
}

// ─── /think（CC 风格：切换思考模式）─────────────────────────────────────
const think: Command = {
  name: 'think',
  description: '切换深度思考模式',
  aliases: [],
  execute: () => {
    return { type: 'action', content: '🧠 深度思考模式已开启。复杂任务会消耗更多 token 但质量更高。' }
  },
}

// ─── /policy（Codex 风格：执行策略）─────────────────────────────────────
const policy: Command = {
  name: 'policy',
  description: '查看/切换执行策略',
  aliases: [],
  argumentHint: '<unless-trusted|on-failure|on-request|never>',
  execute: (args) => {
    if (!args) {
      return { type: 'info', content: `当前执行策略: ${getExecPolicy()}\n\n策略说明:\n  unless-trusted  信任命令自动执行，其他需要审批（默认）\n  on-failure      失败时才需要审批\n  on-request      每次都需要审批\n  never           从不审批\n\n用法: /policy <策略名称>` }
    }
    const valid = ['unless-trusted', 'on-failure', 'on-request', 'never']
    if (!valid.includes(args)) {
      return { type: 'error', content: `无效策略。可选: ${valid.join(', ')}` }
    }
    setExecPolicy(args as any)
    return { type: 'action', content: `✅ 执行策略已切换到: ${args}` }
  },
}

// ─── /agent（OpenClaw 风格：子代理）─────────────────────────────────────
const agent: Command = {
  name: 'agent',
  description: '运行子代理执行任务',
  aliases: [],
  argumentHint: '<任务描述>',
  execute: (args) => {
    if (!args) {
      return { type: 'info', content: '用法: /agent <任务描述>\n\n子代理会在独立上下文中执行任务，完成后返回结果。' }
    }
    return { type: 'info', content: `🤖 子代理任务: ${args}\n（子代理功能正在集成中）` }
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
const COMMANDS: Command[] = [help, clear, compact, history, config, model, think, policy, agent, resume, quit]

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
