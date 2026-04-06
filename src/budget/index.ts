// ─── 成本控制增强 ────────────────────────────────────────────────────────
// 每日/每周/每月预算限制、超预算降级模型、/budget 命令
// 会话级实时统计、工具时长、API 时长、缓存命中（CC-inspired）

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { estimateCost, type TokenUsage, getUsageTracker, formatUsd, MODEL_PRICING } from '../config/index.js'

// ─── 类型定义 ──────────────────────────────────────────────────────────
export type BudgetPeriod = 'daily' | 'weekly' | 'monthly'

export interface BudgetLimit {
  daily: number    // 美元，0 = 不限制
  weekly: number
  monthly: number
}

export interface BudgetUsage {
  date: string     // YYYY-MM-DD
  week: string     // YYYY-Www
  month: string    // YYYY-MM
  dailySpent: number
  weeklySpent: number
  monthlySpent: number
}

export interface BudgetAlert {
  level: 'warning' | 'limit' | 'exceeded'
  period: BudgetPeriod
  spent: number
  limit: number
  message: string
}

export interface CostRecord {
  timestamp: number
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  cost: number
  category: 'chat' | 'tool' | 'plan'
  apiDurationMs?: number      // API 调用时长（网络延迟）
}

// ─── 会话级实时统计（CC-inspired）──────────────────────────────────────
export interface SessionStats {
  // Token 统计
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheCreationTokens: number

  // 花费
  totalCostUSD: number

  // 时长
  totalAPIDurationMs: number      // 所有 API 调用的网络时长
  totalToolDurationMs: number     // 所有工具调用的执行时长
  totalSessionDurationMs: number  // 会话总时长

  // 计数
  apiCallCount: number
  toolCallCount: number
  errorCount: number

  // 按模型统计
  modelUsage: Record<string, {
    inputTokens: number
    outputTokens: number
    cost: number
    callCount: number
  }>

  // 最后更新时间
  lastUpdated: number
}

// 会话级状态（内存中，不持久化）
let sessionStats: SessionStats = createEmptySessionStats()

function createEmptySessionStats(): SessionStats {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    totalCostUSD: 0,
    totalAPIDurationMs: 0,
    totalToolDurationMs: 0,
    totalSessionDurationMs: 0,
    apiCallCount: 0,
    toolCallCount: 0,
    errorCount: 0,
    modelUsage: {},
    lastUpdated: Date.now(),
  }
}

export function getSessionStats(): SessionStats {
  return { ...sessionStats, modelUsage: { ...sessionStats.modelUsage } }
}

export function resetSessionStats(): void {
  sessionStats = createEmptySessionStats()
}

// 记录 API 调用（每轮对话）
export function recordAPICall(
  usage: TokenUsage,
  model: string,
  apiDurationMs: number,
  category: 'chat' | 'tool' | 'plan' = 'chat'
): number {
  const cost = estimateCost(usage, model)

  // 更新会话统计
  sessionStats.totalInputTokens += usage.input_tokens || 0
  sessionStats.totalOutputTokens += usage.output_tokens || 0
  sessionStats.totalCacheReadTokens += usage.cache_read_input_tokens || 0
  sessionStats.totalCacheCreationTokens += usage.cache_creation_input_tokens || 0
  sessionStats.totalCostUSD += cost
  sessionStats.totalAPIDurationMs += apiDurationMs
  sessionStats.apiCallCount++
  sessionStats.lastUpdated = Date.now()

  // 按模型统计
  if (!sessionStats.modelUsage[model]) {
    sessionStats.modelUsage[model] = { inputTokens: 0, outputTokens: 0, cost: 0, callCount: 0 }
  }
  sessionStats.modelUsage[model].inputTokens += usage.input_tokens || 0
  sessionStats.modelUsage[model].outputTokens += usage.output_tokens || 0
  sessionStats.modelUsage[model].cost += cost
  sessionStats.modelUsage[model].callCount++

  // 持久化到 JSONL
  const record: CostRecord = {
    timestamp: Date.now(),
    model,
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    cacheReadTokens: usage.cache_read_input_tokens || 0,
    cacheCreationTokens: usage.cache_creation_input_tokens || 0,
    cost,
    category,
    apiDurationMs,
  }
  appendCostRecord(record)

  return cost
}

// 记录工具调用时长
export function recordToolCall(durationMs: number): void {
  sessionStats.totalToolDurationMs += durationMs
  sessionStats.toolCallCount++
  sessionStats.lastUpdated = Date.now()
}

// 记录错误
export function recordError(): void {
  sessionStats.errorCount++
}

// 更新会话总时长
export function updateSessionDuration(startedAt: number): void {
  sessionStats.totalSessionDurationMs = Date.now() - startedAt
}

// ─── 持久化 ──────────────────────────────────────────────────────────
const DIR = join(homedir(), '.edgecli')
const BUDGET_FILE = join(DIR, 'budget.json')
const COST_FILE = join(DIR, 'costs.jsonl')

function ensureDir() {
  mkdirSync(DIR, { recursive: true })
}

function appendCostRecord(record: CostRecord): void {
  ensureDir()
  try {
    appendFileSync(COST_FILE, JSON.stringify(record) + '\n')
  } catch {}
}

export function loadBudget(): BudgetLimit {
  ensureDir()
  if (existsSync(BUDGET_FILE)) {
    try {
      return JSON.parse(readFileSync(BUDGET_FILE, 'utf-8'))
    } catch {}
  }
  return { daily: 0, weekly: 0, monthly: 0 }
}

export function saveBudget(budget: BudgetLimit): void {
  ensureDir()
  writeFileSync(BUDGET_FILE, JSON.stringify(budget, null, 2))
}

export function setBudgetLimit(period: BudgetPeriod, amount: number): void {
  const budget = loadBudget()
  budget[period] = amount
  saveBudget(budget)
}

// ─── 花费追踪 ─────────────────────────────────────────────────────────
function getDateStrings(): { date: string; week: string; month: string } {
  const now = new Date()
  const date = now.toISOString().split('T')[0]

  // ISO week
  const startOfYear = new Date(now.getFullYear(), 0, 1)
  const days = Math.floor((now.getTime() - startOfYear.getTime()) / (24 * 60 * 60 * 1000))
  const week = `${now.getFullYear()}-W${String(Math.ceil((days + startOfYear.getDay() + 1) / 7)).padStart(2, '0')}`

  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

  return { date, week, month }
}

export function recordCost(usage: TokenUsage, model: string, category: 'chat' | 'tool' | 'plan' = 'chat'): number {
  const cost = estimateCost(usage, model)
  if (cost <= 0) return 0

  const record: CostRecord = {
    timestamp: Date.now(),
    model,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cost,
    category,
  }

  // 追加到 JSONL 文件
  ensureDir()
  try {
    appendFileSync(COST_FILE, JSON.stringify(record) + '\n')
  } catch {}

  return cost
}

export function getCostUsage(): BudgetUsage {
  const { date, week, month } = getDateStrings()

  if (!existsSync(COST_FILE)) {
    return { date, week, month, dailySpent: 0, weeklySpent: 0, monthlySpent: 0 }
  }

  let dailySpent = 0
  let weeklySpent = 0
  let monthlySpent = 0

  try {
    const lines = readFileSync(COST_FILE, 'utf-8').split('\n').filter(Boolean)
    for (const line of lines) {
      try {
        const record: CostRecord = JSON.parse(line)
        const recordDate = new Date(record.timestamp)
        const rDate = recordDate.toISOString().split('T')[0]

        const rMonth = `${recordDate.getFullYear()}-${String(recordDate.getMonth() + 1).padStart(2, '0')}`

        // 计算 week
        const startOfYear = new Date(recordDate.getFullYear(), 0, 1)
        const days = Math.floor((recordDate.getTime() - startOfYear.getTime()) / (24 * 60 * 60 * 1000))
        const rWeek = `${recordDate.getFullYear()}-W${String(Math.ceil((days + startOfYear.getDay() + 1) / 7)).padStart(2, '0')}`

        if (rDate === date) dailySpent += record.cost
        if (rWeek === week) weeklySpent += record.cost
        if (rMonth === month) monthlySpent += record.cost
      } catch {}
    }
  } catch {}

  return { date, week, month, dailySpent, weeklySpent, monthlySpent }
}

// ─── 预算检查 ─────────────────────────────────────────────────────────
export function checkBudgetLimit(): BudgetAlert | null {
  const budget = loadBudget()
  const usage = getCostUsage()

  // 检查每日预算
  if (budget.daily > 0) {
    const pct = usage.dailySpent / budget.daily
    if (pct >= 1.0) {
      return {
        level: 'exceeded',
        period: 'daily',
        spent: usage.dailySpent,
        limit: budget.daily,
        message: `🚫 日预算已用尽: ${formatUsd(usage.dailySpent)} / ${formatUsd(budget.daily)}`,
      }
    }
    if (pct >= 0.8) {
      return {
        level: 'warning',
        period: 'daily',
        spent: usage.dailySpent,
        limit: budget.daily,
        message: `⚠️ 日预算已用 ${Math.round(pct * 100)}%: ${formatUsd(usage.dailySpent)} / ${formatUsd(budget.daily)}`,
      }
    }
  }

  // 检查每周预算
  if (budget.weekly > 0) {
    const pct = usage.weeklySpent / budget.weekly
    if (pct >= 1.0) {
      return {
        level: 'exceeded',
        period: 'weekly',
        spent: usage.weeklySpent,
        limit: budget.weekly,
        message: `🚫 周预算已用尽: ${formatUsd(usage.weeklySpent)} / ${formatUsd(budget.weekly)}`,
      }
    }
    if (pct >= 0.8) {
      return {
        level: 'warning',
        period: 'weekly',
        spent: usage.weeklySpent,
        limit: budget.weekly,
        message: `⚠️ 周预算已用 ${Math.round(pct * 100)}%: ${formatUsd(usage.weeklySpent)} / ${formatUsd(budget.weekly)}`,
      }
    }
  }

  // 检查每月预算
  if (budget.monthly > 0) {
    const pct = usage.monthlySpent / budget.monthly
    if (pct >= 1.0) {
      return {
        level: 'exceeded',
        period: 'monthly',
        spent: usage.monthlySpent,
        limit: budget.monthly,
        message: `🚫 月预算已用尽: ${formatUsd(usage.monthlySpent)} / ${formatUsd(budget.monthly)}`,
      }
    }
    if (pct >= 0.8) {
      return {
        level: 'warning',
        period: 'monthly',
        spent: usage.monthlySpent,
        limit: budget.monthly,
        message: `⚠️ 月预算已用 ${Math.round(pct * 100)}%: ${formatUsd(usage.monthlySpent)} / ${formatUsd(budget.monthly)}`,
      }
    }
  }

  return null
}

// ─── 模型降级 ─────────────────────────────────────────────────────────
const MODEL_TIERS: string[][] = [
  ['claude-sonnet-4-20250514', 'claude-3-7-sonnet-20250219', 'gpt-4o', 'gpt-4-turbo'],
  ['gpt-4o-mini', 'claude-3-5-haiku-20241022', 'claude-haiku-4-5-20251001'],
  ['gpt-3.5-turbo'],
]

export function getDowngradedModel(currentModel: string): string | null {
  // 找当前模型所在层级
  let currentTier = -1
  for (let i = 0; i < MODEL_TIERS.length; i++) {
    if (MODEL_TIERS[i].includes(currentModel)) {
      currentTier = i
      break
    }
  }

  // 如果不在任何层级，返回默认降级
  if (currentTier === -1) return 'gpt-4o-mini'

  // 返回下一层级的第一个模型
  const nextTier = currentTier + 1
  if (nextTier >= MODEL_TIERS.length) return null

  return MODEL_TIERS[nextTier][0]
}

// ─── 成本报告 ─────────────────────────────────────────────────────────
export interface CostReport {
  totalCost: number
  byModel: Record<string, number>
  byCategory: Record<string, number>
  byDay: Record<string, number>
  recordCount: number
}

export function getCostReport(days: number = 30): CostReport {
  const report: CostReport = {
    totalCost: 0,
    byModel: {},
    byCategory: {},
    byDay: {},
    recordCount: 0,
  }

  if (!existsSync(COST_FILE)) return report

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000

  try {
    const lines = readFileSync(COST_FILE, 'utf-8').split('\n').filter(Boolean)
    for (const line of lines) {
      try {
        const record: CostRecord = JSON.parse(line)
        if (record.timestamp < cutoff) continue

        report.totalCost += record.cost
        report.recordCount++

        report.byModel[record.model] = (report.byModel[record.model] || 0) + record.cost
        report.byCategory[record.category] = (report.byCategory[record.category] || 0) + record.cost

        const day = new Date(record.timestamp).toISOString().split('T')[0]
        report.byDay[day] = (report.byDay[day] || 0) + record.cost
      } catch {}
    }
  } catch {}

  return report
}

// ─── 格式化 ──────────────────────────────────────────────────────────

// 格式化时长（CC 风格）
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const min = Math.floor(ms / 60000)
  const sec = Math.floor((ms % 60000) / 1000)
  return `${min}m ${sec}s`
}

// 格式化数字（千分位）
function formatNumber(n: number): string {
  return n.toLocaleString('en-US')
}

export function formatBudgetStatus(): string {
  const budget = loadBudget()
  const usage = getCostUsage()
  const alert = checkBudgetLimit()

  const lines = ['💰 预算状态\n']

  if (alert) {
    lines.push(`${alert.message}\n`)
  }

  // 显示各项预算
  if (budget.daily > 0) {
    const pct = Math.round((usage.dailySpent / budget.daily) * 100)
    lines.push(`  日预算: ${formatUsd(usage.dailySpent)} / ${formatUsd(budget.daily)} (${pct}%)`)
  } else {
    lines.push(`  日预算: ${formatUsd(usage.dailySpent)} (无限制)`)
  }

  if (budget.weekly > 0) {
    const pct = Math.round((usage.weeklySpent / budget.weekly) * 100)
    lines.push(`  周预算: ${formatUsd(usage.weeklySpent)} / ${formatUsd(budget.weekly)} (${pct}%)`)
  } else {
    lines.push(`  周预算: ${formatUsd(usage.weeklySpent)} (无限制)`)
  }

  if (budget.monthly > 0) {
    const pct = Math.round((usage.monthlySpent / budget.monthly) * 100)
    lines.push(`  月预算: ${formatUsd(usage.monthlySpent)} / ${formatUsd(budget.monthly)} (${pct}%)`)
  } else {
    lines.push(`  月预算: ${formatUsd(usage.monthlySpent)} (无限制)`)
  }

  lines.push('')
  lines.push('设置预算: /budget set <daily|weekly|monthly> <amount>')
  lines.push('查看报告: /budget report')

  return lines.join('\n')
}

// ─── 会话统计格式化（CC cost 命令风格）─────────────────────────────────
export function formatSessionStats(): string {
  const stats = getSessionStats()
  const lines: string[] = []

  lines.push('📊 会话统计')
  lines.push('─'.repeat(40))

  // Token 使用
  lines.push(`  Input tokens:     ${formatNumber(stats.totalInputTokens)}`)
  lines.push(`  Output tokens:    ${formatNumber(stats.totalOutputTokens)}`)
  if (stats.totalCacheReadTokens > 0) {
    lines.push(`  Cache read:       ${formatNumber(stats.totalCacheReadTokens)}`)
  }
  if (stats.totalCacheCreationTokens > 0) {
    lines.push(`  Cache creation:   ${formatNumber(stats.totalCacheCreationTokens)}`)
  }

  lines.push('')

  // 花费
  lines.push(`  Total cost:       ${formatUsd(stats.totalCostUSD)}`)

  // 时长
  lines.push(`  API duration:     ${formatDuration(stats.totalAPIDurationMs)}`)
  lines.push(`  Tool duration:    ${formatDuration(stats.totalToolDurationMs)}`)
  lines.push(`  Session duration: ${formatDuration(stats.totalSessionDurationMs)}`)

  lines.push('')

  // 计数
  lines.push(`  API calls:        ${stats.apiCallCount}`)
  lines.push(`  Tool calls:       ${stats.toolCallCount}`)
  if (stats.errorCount > 0) {
    lines.push(`  Errors:           ${stats.errorCount}`)
  }

  // 按模型
  const models = Object.entries(stats.modelUsage)
  if (models.length > 0) {
    lines.push('')
    lines.push('  By model:')
    for (const [model, usage] of models.sort((a, b) => b[1].cost - a[1].cost)) {
      lines.push(`    ${model}:`)
      lines.push(`      ${formatNumber(usage.inputTokens)} in / ${formatNumber(usage.outputTokens)} out`)
      lines.push(`      ${formatUsd(usage.cost)} (${usage.callCount} calls)`)
    }
  }

  return lines.join('\n')
}

export function formatCostReport(days: number = 30): string {
  const report = getCostReport(days)

  const lines = [`📊 成本报告（最近 ${days} 天）\n`]

  lines.push(`总花费: ${formatUsd(report.totalCost)}`)
  lines.push(`记录数: ${report.recordCount}`)
  lines.push('')

  // 按模型
  lines.push('按模型:')
  const sortedModels = Object.entries(report.byModel).sort((a, b) => b[1] - a[1])
  for (const [model, cost] of sortedModels.slice(0, 10)) {
    lines.push(`  ${model}: ${formatUsd(cost)}`)
  }

  // 按分类
  lines.push('\n按分类:')
  for (const [category, cost] of Object.entries(report.byCategory).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${category}: ${formatUsd(cost)}`)
  }

  // 按天（最近 7 天）
  lines.push('\n按天（最近 7 天）:')
  const sortedDays = Object.entries(report.byDay).sort((a, b) => b[0].localeCompare(a[0]))
  for (const [day, cost] of sortedDays.slice(0, 7)) {
    lines.push(`  ${day}: ${formatUsd(cost)}`)
  }

  return lines.join('\n')
}
