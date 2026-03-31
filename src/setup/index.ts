// ─── Interactive Setup (全中文，空格选择，回车确定) ──────────────────────────
import { createInterface } from 'readline'
import { join } from 'path'
import { homedir } from 'os'
import { loadConfig, saveConfig, type CodoConfig } from '../config/index.js'

const PROVIDERS = [
  { name: 'OpenAI', base: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'], provider: 'openai' as const },
  { name: 'Anthropic', base: 'https://api.anthropic.com', models: ['claude-sonnet-4-20250514', 'claude-3-7-sonnet-20250219', 'claude-haiku-4-5-20251001'], provider: 'anthropic' as const },
  { name: 'OpenRouter', base: 'https://openrouter.ai/api/v1', models: ['anthropic/claude-sonnet-4', 'google/gemini-2.5-flash', 'meta-llama/llama-3-70b'], provider: 'openrouter' as const },
  { name: '自定义（OpenAI/Anthropic 兼容接口）', base: '', models: [], provider: 'anthropic' as const },
]

function ask(rl: ReturnType<typeof createInterface>, q: string): Promise<string> {
  return new Promise(resolve => rl.question(q, resolve))
}

function isComplete(c: CodoConfig): boolean {
  return !!(c.apiKey || process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY) && !!c.model && !!c.baseUrl
}

// 空格选择，回车确认
async function selectItem(rl: ReturnType<typeof createInterface>, items: string[], title: string): Promise<number> {
  let cursor = 0

  function render() {
    // 清屏 + 重绘
    process.stdout.write('\x1b[2J\x1b[H')
    console.log(`${title}\n`)
    items.forEach((item, i) => {
      const prefix = i === cursor ? '  ▸ ' : '    '
      const marker = i === cursor ? '●' : ' '
      console.log(`${prefix}${marker} ${item}`)
    })
    console.log('\n  方向键 ↑↓ 选择，回车确认')
  }

  return new Promise(resolve => {
    // 切换到 raw mode
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true)
      render()

      const onData = (data: Buffer) => {
        const key = data.toString()
        // 上箭头
        if (key === '\x1b[A') {
          cursor = (cursor - 1 + items.length) % items.length
          render()
        }
        // 下箭头
        else if (key === '\x1b[B') {
          cursor = (cursor + 1) % items.length
          render()
        }
        // 回车
        else if (key === '\r' || key === '\n') {
          process.stdin.setRawMode(false)
          process.stdin.off('data', onData)
          process.stdout.write('\n')
          resolve(cursor)
        }
        // Ctrl+C
        else if (key === '\x03') {
          process.stdin.setRawMode(false)
          process.stdout.write('\n')
          process.exit(0)
        }
      }
      process.stdin.on('data', onData)
    } else {
      // 非 TTY 降级为输入编号
      render()
      ask(rl, '\n输入编号: ').then(input => resolve(parseInt(input) - 1))
    }
  })
}

export async function ensureConfig(): Promise<CodoConfig> {
  let config = loadConfig()
  if (isComplete(config)) return config

  const rl = createInterface({ input: process.stdin, output: process.stdout })

  console.log('\n欢迎使用 edgecli！还没有配置 API。\n')

  // 选择提供商
  const providerNames = PROVIDERS.map(p => p.name)
  const choice = await selectItem(rl, providerNames, '请选择你的 AI 提供商')

  const sel = PROVIDERS[choice]

  if (choice === 3) {
    // 自定义
    process.stdout.write('\n📝 自定义配置：\n')
    config.baseUrl = await ask(rl, '  API 地址（如 https://api.example.com 或 https://api.example.com/v1）: ')
    config.baseUrl = config.baseUrl.replace(/\/$/, '')
    config.model = await ask(rl, '  模型名称（如 claude-sonnet-4-20250514, gpt-4o）: ')
    config.apiKey = await ask(rl, '  API Key: ')
    // 根据 URL 后缀自动判断接口格式
    if (config.baseUrl.endsWith('/v1') || config.baseUrl.includes('/v1/')) {
      config.provider = 'openai'
      console.log('  📡 自动识别：OpenAI 格式（检测到 /v1）')
    } else {
      config.provider = 'anthropic'
      console.log('  📡 自动识别：Anthropic 格式')
    }
  } else {
    config.baseUrl = sel.base
    config.provider = sel.provider

    if (sel.models.length === 1) {
      config.model = sel.models[0]
    } else {
      const mi = await selectItem(rl, sel.models, `选择模型（${sel.name}）`)
      config.model = sel.models[mi]
    }

    config.apiKey = await ask(rl, `\n  ${sel.name} API Key: `)
  }

  // 保存并显示结果
  saveConfig(config)

  console.log('\n✅ 配置完成！')
  console.log(`  接口格式: ${config.provider}`)
  console.log(`  API 地址: ${config.baseUrl}`)
  console.log(`  模型:     ${config.model}`)
  console.log(`  密钥:     ${config.apiKey.slice(0, 8)}...`)
  console.log('\n  直接运行 edgecli 即可使用。edgecli --setup 可重新配置。\n')

  rl.close()
  return config
}
