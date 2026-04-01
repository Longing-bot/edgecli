// ─── 命令历史管理 ──────────────────────────────────────────────────────
// 保存命令历史到 ~/.edgecli/history.json
// 支持上下箭头浏览、反向搜索

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const DIR = join(homedir(), '.edgecli')
const HISTORY_FILE = join(DIR, 'history.json')
const MAX_HISTORY = 500

export interface CommandHistory {
  commands: string[]
  lastUpdated: string
}

function loadHistory(): CommandHistory {
  mkdirSync(DIR, { recursive: true })
  if (existsSync(HISTORY_FILE)) {
    try {
      return JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'))
    } catch {}
  }
  return { commands: [], lastUpdated: new Date().toISOString() }
}

function saveHistory(history: CommandHistory) {
  mkdirSync(DIR, { recursive: true })
  history.lastUpdated = new Date().toISOString()
  writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2))
}

export function addCommand(command: string) {
  if (!command.trim()) return
  const history = loadHistory()

  // 避免重复（连续相同的命令不重复记录）
  if (history.commands[0] === command) return

  history.commands.unshift(command)
  if (history.commands.length > MAX_HISTORY) {
    history.commands = history.commands.slice(0, MAX_HISTORY)
  }
  saveHistory(history)
}

export function getCommands(): string[] {
  return loadHistory().commands
}

export function getCommand(index: number): string | null {
  const commands = loadHistory().commands
  return index >= 0 && index < commands.length ? commands[index] : null
}

export function searchHistory(query: string, limit = 20): string[] {
  const commands = loadHistory().commands
  const lowerQuery = query.toLowerCase()
  return commands
    .filter(cmd => cmd.toLowerCase().includes(lowerQuery))
    .slice(0, limit)
}

export function clearHistory() {
  saveHistory({ commands: [], lastUpdated: new Date().toISOString() })
}

export function getHistoryStats(): { count: number; lastUpdated: string } {
  const history = loadHistory()
  return {
    count: history.commands.length,
    lastUpdated: history.lastUpdated,
  }
}

// ─── 历史导航器（用于 TUI）────────────────────────────────────────
export class HistoryNavigator {
  private commands: string[]
  private index: number = -1
  private savedInput: string = ''

  constructor() {
    this.commands = getCommands()
  }

  getPrevious(currentInput: string): string | null {
    if (this.index === -1) {
      this.savedInput = currentInput
    }
    if (this.index < this.commands.length - 1) {
      this.index++
      return this.commands[this.index]
    }
    return null
  }

  getNext(): string | null {
    if (this.index > 0) {
      this.index--
      return this.commands[this.index]
    }
    if (this.index === 0) {
      this.index = -1
      return this.savedInput
    }
    return null
  }

  reset() {
    this.index = -1
    this.savedInput = ''
  }

  getCurrentIndex(): number {
    return this.index
  }

  search(query: string): string[] {
    return searchHistory(query)
  }
}
