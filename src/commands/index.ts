// ─── 命令系统（CC commands.ts 风格）────────────────────────────────────────
import { existsSync, unlinkSync, readFileSync, writeFileSync } from 'fs'
import { getSessionFile, saveSession, loadSession, loadConfig, saveConfig, getUsageTracker, type Message } from '../config/index.js'
import { getCompactionRequest } from '../memory/compact.js'
import { getExecPolicy, setExecPolicy } from '../hooks/policy.js'
import { consolidateMemory, recordSession, shouldConsolidate } from '../memory/dream.js'
import { getPermissionLevel, setPermissionLevel, listPermissions, PERMISSION_NAMES, PermissionLevel } from '../permissions/index.js'
import { estimateMessageTokens, getContextStats } from '../memory/index.js'
import { collectContext, formatContextForPrompt } from '../context/index.js'
import { getChangedFiles, getFileDiff, revertFile, getTrackerStats, clearTracker } from '../tracker/index.js'
import { getApprovalMode, setApprovalMode } from '../approval/index.js'
import { listSessions, getSession, getMessages, initWorkspaceSession, deleteSession, type SessionRecord } from '../storage/index.js'
import { listAllLoadedSkills, formatSkillsList } from '../skills/index.js'
import { runHealthCheck, formatHealthReport } from '../healthcheck/index.js'
import { getMCPServerStatuses, initMCPServers } from '../mcp/index.js'

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

  对话
    /help (?/ h/)      显示帮助
    /clear             清除对话历史
    /compact           压缩上下文，保留摘要
    /history           查看消息统计
    /resume            恢复上次对话
    /sessions          列出历史会话
    /resume <id>       恢复指定会话
    /search <kw>       搜索历史会话

  模型
    /model <name>      切换/查看模型
    /think             切换深度思考模式

  配置
    /config            查看当前配置
    /policy <mode>     切换权限模式
    /approval <mode>   切换审批模式
    /init              生成默认配置

  文件
    /diff              查看本次会话的文件变更
    /revert <file>     回退文件到修改前的状态

  会话
    /export <id>       导出会话为 Markdown
    /tag <id> <tags>   给会话打标签
    /cleanup           清理旧会话（保留最近 50 个）

  扩展
    /skills            列出已加载的技能
    /mcp               列出 MCP server 和工具
    /doctor            健康检查

  信息
    /context           显示当前上下文使用情况
    /usage (cost/)     查看 token 用量和花费

  其他
    /agent <task>      运行子代理
    /dream             整理记忆
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
    clearTracker()
    return { type: 'action', content: '🗑️ 对话和变更记录已清除。', clearHistory: true }
  },
}

// ─── /compact ──────────────────────────────────────────────────────────
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
  审批: ${getApprovalMode()}
  密钥: ${c.apiKey ? c.apiKey.slice(0, 8) + '...' : '(未设置)'}`,
    }
  },
}

// ─── /model ────────────────────────────────────────────────────────────
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

// ─── /think ────────────────────────────────────────────────────────────
const think: Command = {
  name: 'think',
  description: '切换深度思考模式',
  aliases: [],
  execute: () => {
    return { type: 'action', content: '🧠 深度思考模式已开启。复杂任务会消耗更多 token 但质量更高。' }
  },
}

// ─── /usage ────────────────────────────────────────────────────────────
const usage: Command = {
  name: 'usage',
  description: '查看 token 用量和花费',
  aliases: ['cost', 'tokens'],
  execute: () => {
    const tracker = getUsageTracker()
    const config = loadConfig()
    if (tracker.turnCount === 0) {
      return { type: 'info', content: '📊 暂无用量数据。发送一条消息后即可查看。' }
    }
    return { type: 'info', content: tracker.getSummary(config.model) }
  },
}

// ─── /policy ──────────────────────────────────────────────────────────
const policy: Command = {
  name: 'policy',
  description: '查看/切换权限模式或执行策略',
  aliases: [],
  argumentHint: '<ReadOnly|WorkspaceWrite|DangerFullAccess|Prompt|Allow | unless-trusted|on-failure|on-request|never>',
  execute: (args) => {
    if (!args) {
      const permLevel = getPermissionLevel()
      const execPolicy = getExecPolicy()
      return {
        type: 'info',
        content: `权限模式: ${PERMISSION_NAMES[permLevel]}\n执行策略: ${execPolicy}\n审批模式: ${getApprovalMode()}\n\n${listPermissions()}\n\n用法:\n  /policy ReadOnly|WorkspaceWrite|DangerFullAccess|Prompt|Allow\n  /policy unless-trusted|on-failure|on-request|never`,
      }
    }
    if (setPermissionLevel(args)) {
      return { type: 'action', content: `✅ 权限模式已切换到: ${args}` }
    }
    const validPolicies = ['unless-trusted', 'on-failure', 'on-request', 'never']
    if (validPolicies.includes(args)) {
      setExecPolicy(args as any)
      return { type: 'action', content: `✅ 执行策略已切换到: ${args}` }
    }
    return { type: 'error', content: `无效参数。可选: ${Object.values(PERMISSION_NAMES).join(', ')} 或 ${validPolicies.join(', ')}` }
  },
}

// ─── /approval ─────────────────────────────────────────────────────────
const approval: Command = {
  name: 'approval',
  description: '切换审批模式',
  aliases: [],
  argumentHint: '<always-ask|auto-approve-safe|full-auto>',
  execute: (args) => {
    if (!args) {
      return { type: 'info', content: `当前审批模式: ${getApprovalMode()}\n\n可选:\n  always-ask       所有工具都需要确认\n  auto-approve-safe 安全工具自动执行，危险操作需要确认\n  full-auto        所有工具自动执行\n\n用法: /approval <mode>` }
    }
    const validModes = ['always-ask', 'auto-approve-safe', 'full-auto']
    if (!validModes.includes(args)) {
      return { type: 'error', content: `无效模式。可选: ${validModes.join(', ')}` }
    }
    setApprovalMode(args as any)
    return { type: 'action', content: `✅ 审批模式已切换到: ${args}` }
  },
}

// ─── /agent ────────────────────────────────────────────────────────────
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

// ─── /dream ────────────────────────────────────────────────────────────
const dream: Command = {
  name: 'dream',
  description: '整理记忆',
  aliases: [],
  execute: async () => {
    const result = await consolidateMemory()
    return { type: 'action', content: `🧠 ${result}` }
  },
}

// ─── /resume ───────────────────────────────────────────────────────────
const resume: Command = {
  name: 'resume',
  description: '恢复对话',
  aliases: ['continue'],
  argumentHint: '<可选：session_id>',
  execute: (args, ctx) => {
    if (args) {
      const session = getSession(args)
      if (!session) {
        return { type: 'error', content: `会话不存在: ${args}\n用 /sessions 查看可用会话。` }
      }
      const msgs = getMessages(args)
      if (msgs.length === 0) {
        return { type: 'info', content: `会话 ${args} 没有消息。` }
      }
      ctx.clearMessages()
      return {
        type: 'info',
        content: `已恢复会话 ${args}（${msgs.length} 条消息）\n工作区: ${session.workspace}\n模型: ${session.model || '(默认)'}`,
      }
    }

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

// ─── /sessions ─────────────────────────────────────────────────────────
const sessions: Command = {
  name: 'sessions',
  description: '列出历史会话',
  aliases: [],
  execute: () => {
    const records = listSessions(20)
    if (records.length === 0) {
      return { type: 'info', content: '没有历史会话。\n会话在首次对话时自动创建。' }
    }

    const lines = ['历史会话:\n']
    for (const s of records) {
      const date = s.created_at?.slice(0, 16) || '?'
      const msgCount = getMessages(s.id).length
      const workspace = s.workspace ? s.workspace.split('/').pop() : '?'
      lines.push(`  ${s.id}  ${date}  ${workspace}  ${s.model || '(默认)'}  ${msgCount} 条消息`)
    }
    lines.push(`\n共 ${records.length} 个会话。用 /resume <id> 恢复。`)

    return { type: 'info', content: lines.join('\n') }
  },
}

// ─── /search（新命令）─────────────────────────────────────────────────
const search: Command = {
  name: 'search',
  description: '按关键词搜索历史会话',
  aliases: [],
  argumentHint: '<关键词>',
  execute: (args) => {
    if (!args) {
      return { type: 'info', content: '用法: /search <关键词>\n在会话标题和消息中搜索。' }
    }

    const { searchSessions } = require('../storage/index.js') as { searchSessions: (kw: string) => any[] }
    const results = searchSessions(args)

    if (results.length === 0) {
      return { type: 'info', content: `没有找到包含 "${args}" 的会话。` }
    }

    const lines = [`搜索结果（${results.length} 个会话）:\n`]
    for (const r of results.slice(0, 20)) {
      const date = r.created_at?.slice(0, 16) || '?'
      lines.push(`  ${r.id}  ${date}  ${r.title || '(无标题)'}  ${r.match_count} 处匹配`)
    }
    return { type: 'info', content: lines.join('\n') }
  },
}

// ─── /export（新命令）─────────────────────────────────────────────────
const exportCmd: Command = {
  name: 'export',
  description: '导出会话为 Markdown 文件',
  aliases: [],
  argumentHint: '<session_id>',
  execute: (args) => {
    if (!args) {
      return { type: 'info', content: '用法: /export <session_id>\n用 /sessions 查看可用会话。' }
    }

    const { exportSession } = require('../storage/index.js') as { exportSession: (id: string) => string | null }
    const path = exportSession(args)
    if (!path) {
      return { type: 'error', content: `会话不存在: ${args}` }
    }
    return { type: 'action', content: `✅ 会话已导出到: ${path}` }
  },
}

// ─── /tag（新命令）─────────────────────────────────────────────────────
const tagCmd: Command = {
  name: 'tag',
  description: '给会话打标签分类',
  aliases: [],
  argumentHint: '<session_id> <tag1,tag2,...>',
  execute: (args) => {
    const sp = args.indexOf(' ')
    if (sp === -1) {
      return { type: 'info', content: '用法: /tag <session_id> <tag1,tag2,...>\n示例: /tag abc123 debug,auth\n\n管理标签:\n  /tag list        列出所有标签\n  /tag <id>        查看会话标签' }
    }
    const sessionId = args.slice(0, sp).trim()
    const tagsStr = args.slice(sp + 1).trim()

    if (tagsStr === 'list') {
      const { listAllTags } = require('../storage/index.js') as { listAllTags: () => string[] }
      const tags = listAllTags()
      return { type: 'info', content: tags.length ? `标签: ${tags.join(', ')}` : '还没有标签。' }
    }

    const tags = tagsStr.split(',').map(t => t.trim()).filter(Boolean)
    const { setSessionTags } = require('../storage/index.js') as { setSessionTags: (id: string, tags: string[]) => void }
    setSessionTags(sessionId, tags)
    return { type: 'action', content: `✅ 已给会话 ${sessionId} 打标签: ${tags.join(', ')}` }
  },
}

// ─── /cleanup（新命令）─────────────────────────────────────────────────
const cleanup: Command = {
  name: 'cleanup',
  description: '清理旧会话，保留最近 N 个',
  aliases: [],
  argumentHint: '<可选：保留数量，默认 50>',
  execute: (args) => {
    const keep = parseInt(args) || 50
    const { cleanupSessions } = require('../storage/index.js') as { cleanupSessions: (keep: number) => number }
    const deleted = cleanupSessions(keep)
    return { type: 'action', content: `🧹 已清理 ${deleted} 个旧会话（保留最近 ${keep} 个）。` }
  },
}

// ─── /init（新命令）───────────────────────────────────────────────────
const init: Command = {
  name: 'init',
  description: '生成默认配置文件',
  aliases: [],
  execute: () => {
    const { generateDefaultConfig } = require('../config/index.js') as { generateDefaultConfig: () => string }
    const path = generateDefaultConfig()
    return { type: 'action', content: `✅ 默认配置已生成: ${path}\n编辑配置文件后重启 edgecli 生效。` }
  },
}

// ─── /skills ──────────────────────────────────────────────────────────
const skills: Command = {
  name: 'skills',
  description: '列出已加载的技能',
  aliases: [],
  execute: () => {
    const loaded = listAllLoadedSkills()
    return { type: 'info', content: formatSkillsList(loaded) }
  },
}

// ─── /mcp ─────────────────────────────────────────────────────────────
const mcp: Command = {
  name: 'mcp',
  description: '列出 MCP server 和可用工具',
  aliases: [],
  execute: async () => {
    const statuses = getMCPServerStatuses()
    if (statuses.length === 0) {
      return { type: 'info', content: '没有已连接的 MCP server。\n\n配置文件: ~/.edgecli/mcp.json\n示例:\n{\n  "servers": {\n    "filesystem": {\n      "command": "npx",\n      "args": ["-y", "@anthropic-ai/mcp-server-filesystem", "/path"]\n    }\n  }\n}' }
    }

    const lines = ['MCP Servers:\n']
    for (const s of statuses) {
      const status = s.connected ? '✅' : '❌'
      lines.push(`  ${status} ${s.name}（${s.toolCount} 个工具）`)
      if (s.tools.length > 0) {
        for (const tool of s.tools) {
          lines.push(`     - mcp_${s.name}_${tool}`)
        }
      }
    }
    return { type: 'info', content: lines.join('\n') }
  },
}

// ─── /doctor ──────────────────────────────────────────────────────────
const doctor: Command = {
  name: 'doctor',
  description: '健康检查',
  aliases: ['health'],
  execute: () => {
    const results = runHealthCheck()
    return { type: 'info', content: formatHealthReport(results) }
  },
}

// ─── /sidebar ─────────────────────────────────────────────────────────
const sidebar: Command = {
  name: 'sidebar',
  description: '切换侧边栏显示',
  aliases: [],
  execute: () => {
    return { type: 'action', content: '📋 侧边栏切换（使用 Ctrl+B 切换显示）' }
  },
}

// ─── /diff ────────────────────────────────────────────────────────────
const diffCmd: Command = {
  name: 'diff',
  description: '查看本次会话的文件变更',
  aliases: [],
  execute: () => {
    const changes = getChangedFiles()
    if (changes.length === 0) {
      return { type: 'info', content: '本次会话没有文件变更。' }
    }

    const lines: string[] = ['📝 本次会话文件变更:\n']
    for (const change of changes) {
      const summary = `${change.addedLines > 0 ? '+' + change.addedLines : ''}${change.removedLines > 0 ? '-' + change.removedLines : ''} lines`
      lines.push(`  ${change.path}`)
      lines.push(`    ${change.toolName}: ${summary}`)

      const diff = getFileDiff(change.path)
      const diffLines = diff.split('\n').slice(0, 20)
      for (const dl of diffLines) {
        if (dl.startsWith('+')) lines.push(`    ${dl}`)
        else if (dl.startsWith('-')) lines.push(`    ${dl}`)
        else if (dl.startsWith('@@')) lines.push(`    ${dl}`)
      }
      if (diff.split('\n').length > 20) {
        lines.push(`    ... (${diff.split('\n').length - 20} 行更多)`)
      }
      lines.push('')
    }

    const stats = getTrackerStats()
    lines.push(`总计: ${stats}`)

    return { type: 'info', content: lines.join('\n') }
  },
}

// ─── /revert ──────────────────────────────────────────────────────────
const revertCmd: Command = {
  name: 'revert',
  description: '回退文件到修改前的状态',
  aliases: [],
  argumentHint: '<file_path>',
  execute: (args) => {
    if (!args) {
      const changes = getChangedFiles()
      if (changes.length === 0) {
        return { type: 'info', content: '没有可回退的文件。用法: /revert <file_path>' }
      }
      const fileList = changes.map(c => `  ${c.path} (${c.toolName})`).join('\n')
      return { type: 'info', content: `可回退的文件:\n${fileList}\n\n用法: /revert <file_path>` }
    }
    const result = revertFile(args)
    return { type: result.success ? 'action' : 'error', content: result.message }
  },
}

// ─── /context ─────────────────────────────────────────────────────────
const contextCmd: Command = {
  name: 'context',
  description: '显示当前上下文使用情况',
  aliases: [],
  execute: (_, ctx) => {
    const ctxInfo = collectContext()
    const tokenStats = getContextStats(ctx.messages)
    const trackerStats = getTrackerStats()

    const lines = [
      `📊 上下文信息:`,
      ``,
      `对话: ${tokenStats}`,
      `文件变更: ${trackerStats}`,
      ``,
      `Git 分支: ${ctxInfo.gitBranch || '(not a git repo)'}`,
      `目录: ${ctxInfo.cwd}`,
      `文件数: ${ctxInfo.directoryTree.length}`,
    ]

    if (ctxInfo.modifiedFiles.length > 0) {
      lines.push(``, `修改的文件:`)
      ctxInfo.modifiedFiles.slice(0, 10).forEach(f => lines.push(`  ${f}`))
    }

    if (ctxInfo.recentCommits.length > 0) {
      lines.push(``, `最近提交:`)
      ctxInfo.recentCommits.forEach(c => lines.push(`  ${c}`))
    }

    return { type: 'info', content: lines.join('\n') }
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
const COMMANDS: Command[] = [
  help, clear, compact, history, config, usage, model, think, policy, approval,
  agent, dream, resume, sessions, search, exportCmd, tagCmd, cleanup, init,
  skills, mcp, doctor, sidebar, diffCmd, revertCmd, contextCmd, quit,
]

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

// ─── 命令自动补全 ────────────────────────────────────────────────────
/**
 * 模糊匹配命令补全
 * 输入 "/co" → ["/compact", "/config"]
 * 输入 "/ap" → ["/approval"]
 * 输入 "/" → 所有命令列表
 */
export function autocompleteCommand(partial: string): string[] {
  if (!partial.startsWith('/')) return []

  const query = partial.slice(1).toLowerCase()

  // 如果只输入了 "/"，返回所有命令名
  if (!query) {
    return COMMANDS.map(c => `/${c.name}`)
  }

  const matches: string[] = []
  for (const cmd of COMMANDS) {
    // 精确前缀匹配
    if (cmd.name.startsWith(query)) {
      matches.push(`/${cmd.name}`)
      continue
    }
    // 别名匹配
    if (cmd.aliases?.some(a => a.startsWith(query))) {
      matches.push(`/${cmd.name}`)
      continue
    }
    // 模糊匹配：query 中的字符在 cmd.name 中顺序出现
    if (fuzzyMatch(query, cmd.name)) {
      matches.push(`/${cmd.name}`)
    }
  }

  return matches
}

/** 模糊匹配：pattern 中的字符按顺序出现在 target 中 */
function fuzzyMatch(pattern: string, target: string): boolean {
  if (pattern.length > target.length) return false
  let pi = 0
  for (let ti = 0; ti < target.length && pi < pattern.length; ti++) {
    if (pattern[pi] === target[ti]) pi++
  }
  return pi === pattern.length
}

/**
 * 获取命令补全建议的格式化字符串
 * 用于在 UI 中显示补全提示
 */
export function getCompletionsDisplay(partial: string): string {
  const matches = autocompleteCommand(partial)
  if (matches.length === 0) return ''
  if (matches.length === 1) return matches[0]

  // 多个匹配时显示列表
  const lines = [`匹配 ${matches.length} 个命令:`]
  for (const m of matches) {
    const cmd = COMMANDS.find(c => '/' + c.name === m)
    lines.push(`  ${m}  ${cmd?.description || ''}`)
  }
  return lines.join('\n')
}
