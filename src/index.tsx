// ─── Entry Point ──────────────────────────────────────────────────────────
import React from 'react'
import { render } from 'ink'
import { App } from './ui/App.js'
import { loadConfig, saveConfig, hasApiKey, detectProvider, loadSession } from './config/index.js'
import { runQuery } from './query/index.js'
import { processCommand } from './commands/index.js'
import { getContextStats, shouldCompact } from './memory/index.js'
import { ensureConfig } from './setup/index.js'

const args = process.argv.slice(2)

if (args.includes('--help') || args.includes('-h')) {
  console.log(`edgecli - AI 编程助手（CC 架构，模型无关）

用法: edgecli [提问] | edgecli --print [提问] | edgecli --config | edgecli --setup | edgecli --help
选项: -m/--model 模型名 | --provider openai|anthropic|openrouter
命令: /help /clear /compact /history /quit
环境变量: OPENROUTER_API_KEY | OPENAI_API_KEY | ANTHROPIC_API_KEY`)
  process.exit(0)
}

// --config: 显示当前配置
if (args.includes('--config')) {
  const c = loadConfig()
  console.log(`edgecli 配置
  密钥: ${c.apiKey ? c.apiKey.slice(0, 8) + '...' : '(未设置)'}
  地址: ${c.baseUrl}
  模型: ${c.model}
  格式: ${detectProvider(c)}
  状态: ${hasApiKey(c) ? '✅ 可用' : '❌ 未配置'}`)
  process.exit(0)
}

// --setup: 重新配置
if (args.includes('--setup')) {
  const { join } = await import('path')
  const { homedir } = await import('os')
  const { unlinkSync, existsSync } = await import('fs')
  const cfg = join(homedir(), '.edgecli', 'config.json')
  if (existsSync(cfg)) unlinkSync(cfg)
  const config = await ensureConfig()
  console.log('已完成！运行 edgecli 即可使用。')
  process.exit(0)
}

// 首次运行：检查配置，不完整则引导配置
const config = await ensureConfig()

const mi = args.indexOf('-m') !== -1 ? args.indexOf('-m') : args.indexOf('--model')
if (mi !== -1 && args[mi + 1]) { config.model = args[mi + 1]; saveConfig(config) }
const prompt = args.filter(a => !a.startsWith('-') && a !== args[mi + 1]).join(' ') || undefined

if (process.stdin.isTTY && process.stdout.isTTY && !args.includes('--print')) {
  render(React.createElement(App, { initialPrompt: prompt }))
} else {
  if (!prompt) { console.log('edgecli（非交互模式）。用 edgecli --help 查看用法。'); process.exit(0) }

  const cmdResult = processCommand(prompt)
  if (cmdResult) {
    console.log(cmdResult.content)
    process.exit(cmdResult.type === 'error' ? 1 : 0)
  }

  console.log(`edgecli [${config.model}]\n`)

  const msgs = loadSession()
  if (msgs.length > 0) {
    console.log(`  ${getContextStats(msgs)}`)
    if (shouldCompact(msgs)) {
      console.log('  ⚠️ 上下文较长，建议 /compact')
    }
  }

  await runQuery(prompt, config, [...msgs], {
    onText: t => console.log(`\n${t}`),
    onToolStart: (n, a) => console.log(`\n🔧 ${n}(${a.length > 40 ? a.slice(0, 40) + '...' : a})`),
    onToolResult: (_, r) => console.log(`   ${r.content.split('\n')[0].slice(0, 60)}`),
    onTurn: t => { if (t > 1) process.stdout.write(`\r⏳ 第 ${t} 轮`) },
    onError: e => console.error(`❌ ${e}`),
  })
}
