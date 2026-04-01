// ─── 健康检查 ──────────────────────────────────────────────────────────
// /doctor 命令，检查系统各项状态

import { existsSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { execSync } from 'child_process'
import { loadConfig, getApiKey, hasApiKey } from '../config/index.js'
import { isSQLiteAvailable } from '../storage/index.js'
import { getMCPServerStatuses } from '../mcp/index.js'
import { getServerStatus, getSupportedLanguages } from '../lsp/index.js'

export interface CheckResult {
  name: string
  status: 'ok' | 'warn' | 'error' | 'skip'
  message: string
}

function colorize(status: CheckResult['status'], text: string): string {
  const colors: Record<string, string> = {
    ok: '\x1b[32m',    // 绿色
    warn: '\x1b[33m',   // 黄色
    error: '\x1b[31m',  // 红色
    skip: '\x1b[90m',   // 灰色
  }
  const reset = '\x1b[0m'
  return `${colors[status] || ''}${text}${reset}`
}

function statusIcon(status: CheckResult['status']): string {
  const icons: Record<string, string> = {
    ok: '✅',
    warn: '⚠️',
    error: '❌',
    skip: '⏭️',
  }
  return icons[status] || '❓'
}

// ─── 检查项 ────────────────────────────────────────────────────────
function checkApiKey(): CheckResult {
  const config = loadConfig()
  if (!hasApiKey(config)) {
    return { name: 'API Key', status: 'error', message: '未设置 API Key（设置 OPENROUTER_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY 或运行 edgecli --setup）' }
  }
  const key = getApiKey(config)
  if (key.length < 10) {
    return { name: 'API Key', status: 'warn', message: `API Key 长度异常（${key.length} 字符）` }
  }
  return { name: 'API Key', status: 'ok', message: `已配置（${key.slice(0, 8)}...）` }
}

function checkModel(): CheckResult {
  const config = loadConfig()
  if (!config.model) {
    return { name: '模型', status: 'error', message: '未设置模型' }
  }
  return { name: '模型', status: 'ok', message: `${config.model} (${config.provider})` }
}

function checkApiConnection(): CheckResult {
  const config = loadConfig()
  if (!hasApiKey(config)) {
    return { name: 'API 连接', status: 'skip', message: '跳过（无 API Key）' }
  }

  try {
    const url = config.baseUrl
    const result = execSync(`curl -s -o /dev/null -w "%{http_code}" --max-time 5 "${url}"`, {
      encoding: 'utf-8',
      timeout: 10000,
    }).trim()

    if (result === '200' || result === '401' || result === '403') {
      return { name: 'API 连接', status: 'ok', message: `可访问（HTTP ${result}）` }
    }
    return { name: 'API 连接', status: 'warn', message: `HTTP ${result}` }
  } catch {
    return { name: 'API 连接', status: 'warn', message: '无法连接（可能是网络问题）' }
  }
}

function checkSQLite(): CheckResult {
  try {
    if (isSQLiteAvailable()) {
      const dbPath = join(homedir(), '.edgecli', 'sessions.db')
      if (existsSync(dbPath)) {
        const size = statSync(dbPath).size
        return { name: 'SQLite 数据库', status: 'ok', message: `正常（${formatBytes(size)}）` }
      }
      return { name: 'SQLite 数据库', status: 'ok', message: '可用（尚无数据）' }
    }
    return { name: 'SQLite 数据库', status: 'warn', message: '不可用，使用 JSON fallback' }
  } catch (e) {
    return { name: 'SQLite 数据库', status: 'error', message: `错误: ${(e as Error).message}` }
  }
}

function checkMCP(): CheckResult {
  try {
    const statuses = getMCPServerStatuses()
    if (statuses.length === 0) {
      return { name: 'MCP Servers', status: 'skip', message: '未配置（~/.edgecli/mcp.json）' }
    }
    const connected = statuses.filter(s => s.connected).length
    const totalTools = statuses.reduce((sum, s) => sum + s.toolCount, 0)
    if (connected === statuses.length) {
      return { name: 'MCP Servers', status: 'ok', message: `${connected}/${statuses.length} 已连接，${totalTools} 个工具` }
    }
    return { name: 'MCP Servers', status: 'warn', message: `${connected}/${statuses.length} 已连接` }
  } catch {
    return { name: 'MCP Servers', status: 'skip', message: '未配置' }
  }
}

function checkLSP(): CheckResult {
  try {
    const status = getServerStatus()
    const langs = getSupportedLanguages()
    const available = langs.filter(l => status[l]?.available)
    const running = langs.filter(l => status[l]?.running)

    if (available.length === 0) {
      return { name: 'LSP Servers', status: 'warn', message: '无可用 LSP（安装 typescript-language-server 或 pylsp）' }
    }
    return { name: 'LSP Servers', status: 'ok', message: `${available.length} 可用: ${available.join(', ')}${running.length > 0 ? `（${running.length} 运行中）` : ''}` }
  } catch {
    return { name: 'LSP Servers', status: 'skip', message: '未初始化' }
  }
}

function checkDiskSpace(): CheckResult {
  try {
    const result = execSync('df -h ~ | tail -1', { encoding: 'utf-8', timeout: 5000 }).trim()
    const parts = result.split(/\s+/)
    const usage = parts[4] // 使用百分比
    const avail = parts[3] // 可用空间
    const pct = parseInt(usage)

    if (pct > 95) {
      return { name: '磁盘空间', status: 'error', message: `${usage} 已使用（可用 ${avail}）` }
    }
    if (pct > 85) {
      return { name: '磁盘空间', status: 'warn', message: `${usage} 已使用（可用 ${avail}）` }
    }
    return { name: '磁盘空间', status: 'ok', message: `${usage} 已使用（可用 ${avail}）` }
  } catch {
    return { name: '磁盘空间', status: 'skip', message: '无法检测' }
  }
}

function checkNodeVersion(): CheckResult {
  const version = process.version
  const major = parseInt(version.slice(1).split('.')[0])
  if (major < 18) {
    return { name: 'Node.js', status: 'error', message: `${version}（需要 >= 18）` }
  }
  if (major < 20) {
    return { name: 'Node.js', status: 'warn', message: `${version}（建议 >= 20）` }
  }
  return { name: 'Node.js', status: 'ok', message: version }
}

function checkEdgecliDir(): CheckResult {
  const dir = join(homedir(), '.edgecli')
  if (!existsSync(dir)) {
    return { name: 'edgecli 目录', status: 'warn', message: '~/.edgecli 不存在' }
  }
  try {
    const files = require('fs').readdirSync(dir)
    return { name: 'edgecli 目录', status: 'ok', message: `存在（${files.length} 个文件/目录）` }
  } catch {
    return { name: 'edgecli 目录', status: 'error', message: '无法读取' }
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ─── 主函数 ────────────────────────────────────────────────────────
export function runHealthCheck(): CheckResult[] {
  return [
    checkApiKey(),
    checkModel(),
    checkApiConnection(),
    checkNodeVersion(),
    checkEdgecliDir(),
    checkSQLite(),
    checkDiskSpace(),
    checkMCP(),
    checkLSP(),
  ]
}

export function formatHealthReport(results: CheckResult[]): string {
  const lines: string[] = []
  lines.push('')
  lines.push('🩺 edgecli 健康检查')
  lines.push('─'.repeat(50))

  for (const result of results) {
    const icon = statusIcon(result.status)
    const name = result.name.padEnd(16)
    const msg = colorize(result.status, result.message)
    lines.push(`${icon} ${name} ${msg}`)
  }

  lines.push('─'.repeat(50))

  const errors = results.filter(r => r.status === 'error').length
  const warns = results.filter(r => r.status === 'warn').length
  const oks = results.filter(r => r.status === 'ok').length

  if (errors > 0) {
    lines.push(colorize('error', `❌ ${errors} 个错误需要修复`))
  }
  if (warns > 0) {
    lines.push(colorize('warn', `⚠️  ${warns} 个警告`))
  }
  if (errors === 0 && warns === 0) {
    lines.push(colorize('ok', '✅ 所有检查通过'))
  }
  lines.push('')

  return lines.join('\n')
}
