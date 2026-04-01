// ─── Layer 6: Config, Memory, Environment ──────────────────────────────────
// CC pattern: environment info auto-injected, memory files loaded, session persisted

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { createHash } from 'crypto'
import { execSync } from 'child_process'

export interface CodoConfig {
  apiKey: string
  baseUrl: string
  model: string
  maxTokens: number
  provider: 'openai' | 'anthropic' | 'openrouter'
  autoApprove: boolean
}

// ─── Token Usage ────────────────────────────────────────────────────
export interface TokenUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}

// 按模型的定价（美元 / 1M tokens）
export const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-sonnet-4-20250514':          { input: 3.0,   output: 15.0,  cacheRead: 0.3,  cacheWrite: 3.75 },
  'claude-3-7-sonnet-20250219':        { input: 3.0,   output: 15.0,  cacheRead: 0.3,  cacheWrite: 3.75 },
  'claude-haiku-4-5-20251001':         { input: 0.80,  output: 4.0,   cacheRead: 0.08, cacheWrite: 1.0 },
  'claude-3-5-haiku-20241022':         { input: 0.80,  output: 4.0,   cacheRead: 0.08, cacheWrite: 1.0 },
  'claude-3-opus-20240229':            { input: 15.0,  output: 75.0,  cacheRead: 1.5,  cacheWrite: 18.75 },
  'gpt-4o':                            { input: 2.5,   output: 10.0,  cacheRead: 1.25, cacheWrite: 2.5 },
  'gpt-4o-mini':                       { input: 0.15,  output: 0.60,  cacheRead: 0.075,cacheWrite: 0.15 },
  'gpt-4-turbo':                       { input: 10.0,  output: 30.0,  cacheRead: 10.0, cacheWrite: 10.0 },
  'gpt-4':                             { input: 30.0,  output: 60.0,  cacheRead: 30.0, cacheWrite: 30.0 },
  'gpt-3.5-turbo':                     { input: 0.50,  output: 1.50,  cacheRead: 0.50, cacheWrite: 0.50 },
  'LongCat-Flash-Thinking-2601':       { input: 0.0,   output: 0.0,   cacheRead: 0.0,  cacheWrite: 0.0 },
}

export function estimateCost(usage: TokenUsage, model: string): number {
  const pricing = MODEL_PRICING[model]
  if (!pricing) return 0
  return (
    (usage.input_tokens / 1_000_000) * pricing.input +
    (usage.output_tokens / 1_000_000) * pricing.output +
    (usage.cache_read_input_tokens / 1_000_000) * pricing.cacheRead +
    (usage.cache_creation_input_tokens / 1_000_000) * pricing.cacheWrite
  )
}

export function formatUsd(amount: number): string {
  if (amount === 0) return '$0.00'
  if (amount < 0.01) return `$${amount.toFixed(4)}`
  return `$${amount.toFixed(2)}`
}

export class UsageTracker {
  private _currentTurn: TokenUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  private _total: TokenUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  private _turnCount = 0

  recordTurn(usage: TokenUsage) {
    this._currentTurn = { ...usage }
    this._total = {
      input_tokens: this._total.input_tokens + usage.input_tokens,
      output_tokens: this._total.output_tokens + usage.output_tokens,
      cache_creation_input_tokens: this._total.cache_creation_input_tokens + usage.cache_creation_input_tokens,
      cache_read_input_tokens: this._total.cache_read_input_tokens + usage.cache_read_input_tokens,
    }
    this._turnCount++
  }

  get currentTurn(): TokenUsage { return this._currentTurn }
  get total(): TokenUsage { return this._total }
  get turnCount(): number { return this._turnCount }

  getSummary(model: string): string {
    const turnCost = estimateCost(this._currentTurn, model)
    const totalCost = estimateCost(this._total, model)
    const lines = [
      `📊 本轮: ${this._currentTurn.input_tokens}→${this._currentTurn.output_tokens} tok  缓存读:${this._currentTurn.cache_read_input_tokens}  ${formatUsd(turnCost)}`,
      `📊 累计: ${this._total.input_tokens}→${this._total.output_tokens} tok (${this._turnCount} 轮)  ${formatUsd(totalCost)}`,
    ]
    return lines.join('\n')
  }
}

// 全局 usage tracker 单例
let globalTracker: UsageTracker | null = null
export function getUsageTracker(): UsageTracker {
  if (!globalTracker) globalTracker = new UsageTracker()
  return globalTracker
}

// ─── Message ────────────────────────────────────────────────────────
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: ToolCall[]
  tool_call_id?: string
  usage?: TokenUsage  // 可选的 token 用量字段
}

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

const DIR = join(homedir(), '.edgecli')
const CONFIG_FILE = join(DIR, 'config.json')
const HISTORY_DIR = join(DIR, 'history')
const MEMORY_FILES = ['EDGECLI.md', 'AGENTS.md', '.edgecli.md', 'OpenCode.md']

const DEFAULT: CodoConfig = {
  apiKey: '', baseUrl: 'https://api.longcat.chat/anthropic',
  model: 'LongCat-Flash-Thinking-2601', maxTokens: 8192,
  provider: 'anthropic', autoApprove: false,
}

export function loadConfig(): CodoConfig {
  mkdirSync(DIR, { recursive: true })
  if (existsSync(CONFIG_FILE)) {
    try {
      const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
      return { ...DEFAULT, ...raw }
    } catch (_e) {
      // ignore parse errors
    }
  }
  return { ...DEFAULT }
}
export function saveConfig(c: CodoConfig) { mkdirSync(DIR, { recursive: true }); writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2)) }
export function getApiKey(c: CodoConfig): string {
  return c.apiKey || process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || ''
}
export function hasApiKey(c: CodoConfig): boolean {
  return !!(c.apiKey || process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY)
}
export function detectProvider(c: CodoConfig): string {
  if (c.provider) return c.provider
  if (c.baseUrl.endsWith('/v1') || c.baseUrl.includes('/v1/')) return 'openai'
  return 'anthropic'
}

// ─── Environment (CC pattern) ─────────────────────────────────────────
export function getEnvInfo(): string {
  const cwd = process.cwd()
  let branch = '', status = '', log = ''
  try { branch = execSync('git branch --show-current', { encoding: 'utf-8', timeout: 3000 }).trim() } catch (_e) {}
  try { status = execSync('git status --short', { encoding: 'utf-8', timeout: 3000 }).trim().slice(0, 300) } catch (_e) {}
  try { log = execSync('git log --oneline -5', { encoding: 'utf-8', timeout: 3000 }).trim() } catch (_e) {}
  let tree = ''
  try {
    tree = readdirSync(cwd).filter((e: string) => e !== '.git' && e !== 'node_modules').sort().slice(0, 40)
      .map((e: string) => { try { return statSync(join(cwd, e)).isDirectory() ? '📁 ' + e : '📄 ' + e } catch(_e) { return '' } })
      .filter(Boolean).join('\n')
  } catch (_e) {}

  return `<environment>
Working directory: ${cwd}
Platform: ${process.platform}
Node: ${process.version}
Date: ${new Date().toISOString().split('T')[0]}
Git branch: ${branch || 'not a git repo'}
Git status: ${status || 'clean or not a git repo'}
Last commits:
${log || 'none'}
</environment>

<project_files>
${tree}
</project_files>`
}

// ─── Memory (CC pattern: auto-load EDGECLI.md etc.) ────────────────────
export function loadMemory(): string {
  const cwd = process.cwd()
  const parts: string[] = []
  for (const name of MEMORY_FILES) {
    const p = join(cwd, name)
    if (existsSync(p) && statSync(p).size < 10000) {
      try { parts.push(`<memory_file path="${name}">\n${readFileSync(p, 'utf-8')}\n</memory_file>`) } catch (_e) {}
    }
  }
  return parts.join('\n\n')
}

// ─── Session ───────────────────────────────────────────────────────────
export const SESSION_VERSION = 1

export interface SessionData {
  version: number
  messages: Message[]
}

export function getSessionFile(): string {
  mkdirSync(HISTORY_DIR, { recursive: true })
  return join(HISTORY_DIR, createHash('md5').update(process.cwd()).digest('hex').slice(0, 12) + '.json')
}

// 向后兼容：优先从 SQLite 加载，fallback JSON
export function loadSession(): Message[] {
  try {
    const { loadSession: loadFromStorage } = require('../storage/index.js')
    return loadFromStorage()
  } catch {
    // fallback 到旧版 JSON
    const f = getSessionFile()
    if (existsSync(f)) {
      try {
        const raw = JSON.parse(readFileSync(f, "utf-8"))
        if (Array.isArray(raw)) return raw
        if (raw.version && Array.isArray(raw.messages)) return raw.messages
        return []
      } catch(_e) {}
    }
    return []
  }
}

export function saveSession(msgs: Message[]) {
  try {
    const { saveSession: saveToStorage } = require('../storage/index.js')
    saveToStorage(undefined, msgs)
  } catch {
    // fallback 到旧版 JSON
    const data: SessionData = { version: SESSION_VERSION, messages: msgs.slice(-40) }
    mkdirSync(HISTORY_DIR, { recursive: true })
    writeFileSync(getSessionFile(), JSON.stringify(data, null, 2))
  }
}
