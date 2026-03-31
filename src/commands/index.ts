// ─── 斜杠命令 ───────────────────────────────────────────────────────────────
import { existsSync, unlinkSync } from 'fs'
import { getSessionFile, loadSession } from '../config/index.js'

export interface CommandResult {
  type: 'info' | 'action' | 'error'
  content: string
  clearHistory?: boolean
}

const COMMANDS = [
  { name: 'help', aliases: ['h', '?'], desc: '显示帮助',
    exec: () => ({ type: 'info', content: `edgecli 命令：
  /help (?/ h/)     显示帮助
  /clear            清除对话历史
  /compact          压缩上下文（TODO）
  /history          查看消息统计
  /quit (q/ exit/)  退出` }) },
  { name: 'clear', desc: '清除对话历史',
    exec: () => { const f = getSessionFile(); if (existsSync(f)) unlinkSync(f); return { type: 'action', content: '🗑️ 对话已清除。', clearHistory: true } } },
  { name: 'history', desc: '查看历史统计',
    exec: () => { const m = loadSession(); return { type: 'info', content: `📜 ${m.length} 条消息（${m.filter(x => x.role === 'user').length} 用户，${m.filter(x => x.role === 'tool').length} 工具）` } } },
  { name: 'compact', desc: '压缩上下文',
    exec: () => ({ type: 'action', content: '📝 上下文压缩将在下个版本实现。当前可通过 --clear 清除历史。' }) },
  { name: 'quit', aliases: ['q', 'exit'], desc: '退出',
    exec: () => { process.exit(0); return { type: 'info', content: '' } } },
] as const

export function processCommand(input: string): CommandResult | null {
  if (!input.startsWith('/')) return null
  const sp = input.indexOf(' ')
  const name = sp === -1 ? input.slice(1) : input.slice(1, sp)
  const cmd = COMMANDS.find(c => c.name === name || c.aliases?.includes(name))
  if (!cmd) return { type: 'error', content: `未知命令: /${name}。试试 /help` }
  return cmd.exec()
}
