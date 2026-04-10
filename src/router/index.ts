// ─── 模型路由（参考 Plandex 的 Model Pack）────────────────────────────────
// 不同任务用不同模型（省钱+提效）

import { CodoConfig, loadConfig, saveConfig } from '../config/index.js'

// ─── 类型定义 ──────────────────────────────────────────────────────────
export type TaskCategory = 'plan' | 'edit' | 'search' | 'chat' | 'code' | 'default'

export interface ModelRoute {
  plan: string
  edit: string
  search: string
  chat: string
  code: string
  default: string
}

export interface RouterConfig {
  enabled: boolean
  routes: ModelRoute
  fallbackModel: string
}

// ─── 默认路由 ─────────────────────────────────────────────────────────
const DEFAULT_ROUTES: ModelRoute = {
  plan: 'claude-sonnet-4-20250514',
  edit: 'gpt-4o',
  search: 'gpt-4o-mini',
  chat: 'gpt-4o-mini',
  code: 'gpt-4o',
  default: 'gpt-4o-mini',
}

// ─── 任务分类关键词（增强版）────────────────────────────────────────────
// 按语义和工具调用模式分类，更精确
const CATEGORY_KEYWORDS: Record<TaskCategory, string[]> = {
  plan: [
    'plan', '规划', '步骤', '架构', '设计', '方案', '重构',
    '结构', '组织', '流程', '策略', '计划', 'roadmap', 'todo',
    '怎么开始', '第一步', '第二步', '第三步', '分解', '拆分'
  ],
  edit: [
    'edit', '修改', '改', '修复', 'fix', 'update', 'update file',
    'write_file', 'edit_file', 'patch_file', 'change', '更改', '调整',
    'replace', '替换', '重写', 'rewrite', 'refactor', '重构',
    'optimize', '优化', '改进', 'better', 'fix bug', 'bug fix'
  ],
  search: [
    'search', 'find', '查找', '搜索', 'grep', 'glob', '哪里',
    'what is', 'where', 'which', '如何', '怎样', '方法', 'solution',
    '原因', '问题', 'debug', '错误', 'log', 'trace', '定位'
  ],
  chat: [
    'what', 'how', 'why', '是什么', '怎么', '为什么', 'explain', '解释',
    '说明', '介绍', '讲讲', '说说', '理解', '明白', '懂吗',
    'help', 'assist', 'support', 'tell me', 'describe', 'summary'
  ],
  code: [
    'code', '写', '实现', 'implement', 'create', 'build', '函数',
    'function', 'class', 'method', 'variable', '参数', '返回值',
    '语法', '报错', '编译', '运行', '测试', 'unit test',
    'import', 'export', 'require', 'module', 'package', '依赖'
  ],
  default: [],
}

// ─── 工具调用权重（用于分类决策）───────────────────────────────────────
// 不同工具的权重，影响分类结果
const TOOL_WEIGHTS: Record<string, TaskCategory> = {
  'write_file': 'edit',
  'edit_file': 'edit',
  'patch_file': 'edit',
  'bash': 'code',
  'test_runner': 'code',
  'read_file': 'search',
  'grep': 'search',
  'glob': 'search',
  'web_search': 'search',
  'fetch': 'search',
  'plan': 'plan',
  'todo': 'plan',
  'task': 'plan',
}

// ─── 复杂度评分（0-10，用于选择模型）───────────────────────────────────
function calculateComplexityScore(message: string, toolCalls?: string[]): number {
  let score = 0

  // 消息长度
  if (message.length > 200) score += 1
  if (message.length > 500) score += 2

  // 关键词复杂度
  const complexWords = ['架构', '设计', '重构', 'optimize', 'performance', 'security', 'algorithm']
  for (const word of complexWords) {
    if (message.includes(word)) score += 2
  }

  // 工具调用数量
  if (toolCalls) {
    score += Math.min(toolCalls.length * 1.5, 4)
  }

  return Math.min(score, 10)
}

// ─── 路由逻辑 ─────────────────────────────────────────────────────────
let routerConfig: RouterConfig | null = null

export function getRouterConfig(): RouterConfig {
  if (routerConfig) return routerConfig

  // 从配置文件加载
  try {
    const config = loadConfig()
    const extended = config as any
    if (extended.modelRouter) {
      routerConfig = {
        enabled: extended.modelRouter.enabled !== false,
        routes: { ...DEFAULT_ROUTES, ...extended.modelRouter.routes },
        fallbackModel: config.model,
      }
      return routerConfig
    }
  } catch {}

  routerConfig = {
    enabled: false,
    routes: DEFAULT_ROUTES,
    fallbackModel: '',
  }
  return routerConfig
}

export function setRouterConfig(cfg: Partial<RouterConfig>): void {
  const current = getRouterConfig()
  routerConfig = { ...current, ...cfg }

  // 保存到配置文件
  try {
    const config = loadConfig()
    ;(config as any).modelRouter = {
      enabled: routerConfig.enabled,
      routes: routerConfig.routes,
    }
    saveConfig(config)
  } catch {}
}

export function classifyTask(userMessage: string, toolCalls?: string[]): TaskCategory {
  const msg = userMessage.toLowerCase()

  // 根据工具调用分类（高优先级）
  if (toolCalls) {
    for (const tool of toolCalls) {
      if (TOOL_WEIGHTS[tool]) {
        return TOOL_WEIGHTS[tool]
      }
    }
  }

  // 根据消息内容分类
  const scores: Record<TaskCategory, number> = {
    plan: 0,
    edit: 0,
    search: 0,
    chat: 0,
    code: 0,
    default: 0,
  }

  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    const cat = category as TaskCategory
    for (const kw of keywords) {
      if (msg.includes(kw.toLowerCase())) {
        scores[cat]++
      }
    }
  }

  // 返回得分最高的类别
  let maxScore = 0
  let bestCategory: TaskCategory = 'default'

  for (const [category, score] of Object.entries(scores)) {
    const cat = category as TaskCategory
    if (score > maxScore || (score === maxScore && cat === 'chat')) {
      maxScore = score
      bestCategory = cat
    }
  }

  return bestCategory
}

export function routeModel(userMessage: string, toolCalls?: string[], complexityScore?: number): string | null {
  const cfg = getRouterConfig()
  if (!cfg.enabled) return null

  const category = classifyTask(userMessage, toolCalls)
  let model = cfg.routes[category] || cfg.fallbackModel

  if (!model) return null

  // 复杂度自适应（如果启用了）
  if (complexityScore !== undefined && complexityScore >= 7) {
    // 高复杂度任务使用更强的模型
    switch (category) {
      case 'plan':
        model = 'claude-sonnet-4-20250514'
        break
      case 'edit':
        model = 'claude-3-7-sonnet-20250219'
        break
      case 'code':
        model = 'claude-3-7-sonnet-20250219'
        break
      case 'search':
        model = 'gpt-4o'
        break
      case 'chat':
        model = 'gpt-4o'
        break
    }
  }

  return model
}

// ─── 配置管理 ─────────────────────────────────────────────────────────
export function enableRouter(): void {
  setRouterConfig({ enabled: true })
}

export function disableRouter(): void {
  setRouterConfig({ enabled: false })
}

export function setRoute(category: TaskCategory, model: string): void {
  const cfg = getRouterConfig()
  cfg.routes[category] = model
  setRouterConfig({ routes: cfg.routes })
}

// ─── 格式化 ──────────────────────────────────────────────────────────
export function formatRouterStatus(): string {
  const cfg = getRouterConfig()
  if (!cfg.enabled) return '模型路由: 未启用（使用默认模型）\n\n启用: /router enable'

  const lines = ['模型路由: ✅ 已启用\n']
  for (const [category, model] of Object.entries(cfg.routes)) {
    lines.push(`  ${category}: ${model}`)
  }
  lines.push(`\n修改: /router set <category> <model>`)
  lines.push(`禁用: /router disable`)

  return lines.join('\n')
}
