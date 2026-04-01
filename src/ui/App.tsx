import React, { useState, useCallback, useRef, useEffect } from 'react'
import { Box, Text, useInput, useApp } from 'ink'
import TextInput from 'ink-text-input'
import { loadConfig, saveConfig, loadSession, getUsageTracker, formatUsd, estimateCost, detectProvider, type Message, type TokenUsage } from '../config/index.js'
import { runQuery } from '../query/index.js'
import { createREPLState } from '../repl/index.js'
import { processCommand, listCommands } from '../commands/index.js'
import { getContextStats } from '../memory/index.js'
import { collectContext, getContextSummary } from '../context/index.js'
import { getChangedFiles, getTrackerStats, formatChangeSummary, clearTracker } from '../tracker/index.js'
import { getApprovalMode, setApprovalMode, type ApprovalRequest, type ApprovalDecision } from '../approval/index.js'
import { PermissionDialog } from './components/PermissionDialog.js'
import { addCommand, HistoryNavigator } from '../history/index.js'

interface Props { initialPrompt?: string }

type EntryType = 'user' | 'assistant' | 'tool' | 'toolResult' | 'error' | 'system' | 'command' | 'approval'
interface Entry {
  type: EntryType
  content: string
  toolName?: string
  toolArgs?: string
  timestamp?: number
}

// ─── Spinner ────────────────────────────────────────────────────────
const SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function Spinner({ status, startTime, turn }: { status: string; startTime: number; turn: number }) {
  const [frame, setFrame] = useState(0)
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    const iv = setInterval(() => {
      setFrame(f => (f + 1) % SPIN_FRAMES.length)
      setElapsed(Math.round((Date.now() - startTime) / 1000))
    }, 80)
    return () => clearInterval(iv)
  }, [startTime])

  const sec = elapsed >= 60
    ? `${Math.floor(elapsed / 60)}m${elapsed % 60}s`
    : `${elapsed}s`

  return (
    <Box marginLeft={2}>
      <Text color="cyan">{SPIN_FRAMES[frame]} </Text>
      <Text color="cyan">{status}…</Text>
      <Text dimColor> {sec}</Text>
      {turn > 1 && <Text dimColor> · 第 {turn} 轮</Text>}
    </Box>
  )
}

// 工具名 → 状态文案
function toolStatus(name: string): string {
  const map: Record<string, string> = {
    bash: '执行中',
    read_file: '读取中',
    write_file: '写入中',
    edit_file: '编辑中',
    glob: '搜索中',
    grep: '搜索中',
    web_search: '搜索中',
    fetch: '请求中',
    todo: '处理中',
  }
  return map[name] || '执行中'
}

// ─── 危险命令检测 ─────────────────────────────────────────────────────
const DANGEROUS_PATTERNS = [
  /rm\s+(-[a-z]*f|--force|--recursive)\s/i,
  /rm\s+-rf\s/i,
  />\s*\/dev\//i,
  /mkfs\./i,
  /dd\s+if=/i,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;/i,
  /chmod\s+777\s/i,
  /curl.*\|\s*(ba)?sh/i,
  /wget.*\|\s*(ba)?sh/i,
]

function isDangerousCommand(command: string): boolean {
  return DANGEROUS_PATTERNS.some(p => p.test(command))
}

// ─── Approval Panel（3 选项：Yes / No / Always）─────────────────────
function ApprovalPanel({
  request,
  onDecision,
}: {
  request: ApprovalRequest
  onDecision: (decision: ApprovalDecision) => void
}) {
  const [focus, setFocus] = useState(0)
  const options: { label: string; value: ApprovalDecision }[] = [
    { label: '允许执行', value: 'yes' },
    { label: '本次会话始终允许', value: 'always' },
    { label: '拒绝', value: 'no' },
  ]

  useInput((input, key) => {
    if (key.upArrow) setFocus(f => (f - 1 + options.length) % options.length)
    if (key.downArrow) setFocus(f => (f + 1) % options.length)
    if (key.return) onDecision(options[focus].value)
    if (key.escape) onDecision('no')
  })

  const toolColor = request.isDestructive ? 'red' : 'yellow'

  return (
    <Box flexDirection="column" borderColor={toolColor} borderStyle="round" borderLeft={false} borderRight={false} borderBottom={false} marginTop={1}>
      <Box paddingX={1}>
        <Text color={toolColor} bold>审批: {request.description}</Text>
        <Text dimColor> ({request.toolName})</Text>
      </Box>
      <Box flexDirection="column" paddingX={2} paddingTop={1}>
        <Text color="white" bold>{'❯ '}{request.argsSummary}</Text>
        {request.isDestructive && <Text color="red">⚠️ 此操作可能是破坏性的</Text>}
      </Box>
      <Box flexDirection="column" paddingX={2} paddingTop={1}>
        {options.map((opt, i) => (
          <Box key={opt.value}>
            <Text color={i === focus ? 'cyan' : 'gray'}>
              {i === focus ? '● ' : '○ '}
            </Text>
            <Text color={i === focus ? 'cyan' : 'gray'} bold={i === focus}>
              {opt.label}
            </Text>
          </Box>
        ))}
      </Box>
      <Box paddingX={1} paddingTop={1}>
        <Text dimColor>↑↓ 选择 · Enter 确认 · Esc 取消</Text>
      </Box>
    </Box>
  )
}

// ─── 缩短路径显示 ──────────────────────────────────────────────────
function shortenPath(path: string, maxLen = 30): string {
  if (path.length <= maxLen) return path
  const parts = path.split('/')
  if (parts.length <= 2) return path.slice(-maxLen)
  return '~/' + parts.slice(-2).join('/')
}

// ─── 状态栏 ──────────────────────────────────────────────────────────
function StatusBar({
  model,
  provider,
  cwd,
  tokenInfo,
  changeCount,
  approvalMode,
}: {
  model: string
  provider: string
  cwd: string
  tokenInfo: string
  changeCount: number
  approvalMode: string
}) {
  const left = `${model} (${provider})`
  const center = shortenPath(cwd)
  const right = `${tokenInfo}${changeCount > 0 ? ` · 📝${changeCount}` : ''}`

  return (
    <Box borderStyle="single" borderColor="gray" borderBottom={false} borderLeft={false} borderRight={false} paddingTop={0} paddingBottom={0}>
      <Box width="33%">
        <Text color="cyan" bold>{left}</Text>
      </Box>
      <Box width="34%" justifyContent="center">
        <Text dimColor>{center}</Text>
      </Box>
      <Box width="33%" justifyContent="flex-end">
        <Text dimColor>{right}</Text>
      </Box>
    </Box>
  )
}

// ─── 侧边栏 ──────────────────────────────────────────────────────────
function Sidebar({
  entries,
  changedFiles,
}: {
  entries: Entry[]
  changedFiles: { path: string; summary: string }[]
}) {
  const toolCalls = entries.filter(e => e.type === 'tool').slice(-8)

  return (
    <Box flexDirection="column" width={30} borderStyle="single" borderColor="gray" paddingLeft={1} paddingRight={1}>
      <Text bold color="yellow">📋 侧边栏</Text>

      {changedFiles.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold dimColor>文件变更:</Text>
          {changedFiles.slice(0, 6).map((f, i) => (
            <Text key={i} dimColor>  {shortenPath(f.path, 24)}</Text>
          ))}
          {changedFiles.length > 6 && <Text dimColor>  ... 还有 {changedFiles.length - 6} 个</Text>}
        </Box>
      )}

      {toolCalls.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold dimColor>工具调用:</Text>
          {toolCalls.map((t, i) => (
            <Text key={i} dimColor>  {t.toolName || '?'}</Text>
          ))}
        </Box>
      )}
    </Box>
  )
}

// ─── Tab 补全建议 ──────────────────────────────────────────────────
function getCompletions(input: string): string[] {
  if (!input.startsWith('/')) return []
  const partial = input.slice(1).toLowerCase()
  const commands = listCommands()
  return commands
    .filter(c => c.name.startsWith(partial) || c.aliases?.some(a => a.startsWith(partial)))
    .map(c => `/${c.name}`)
    .slice(0, 8)
}

// ─── App ──────────────────────────────────────────────────────────────
export const App: React.FC<Props> = ({ initialPrompt }) => {
  const config = loadConfig()
  const { exit } = useApp()
  const [entries, setEntries] = useState<Entry[]>([])
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [turn, setTurn] = useState(0)
  const [turnStart, setTurnStart] = useState(Date.now())
  const [spinnerStatus, setSpinnerStatus] = useState('思考中')
  const [msgs, setMsgs] = useState<Message[]>(() => {
    const saved = loadSession()
    return saved.length > 0 ? saved : createREPLState().messages
  })
  // 审批状态
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null)
  const [approvalResolve, setApprovalResolve] = useState<((value: ApprovalDecision) => void) | null>(null)
  // 侧边栏
  const [showSidebar, setShowSidebar] = useState(false)
  // Tab 补全
  const [completions, setCompletions] = useState<string[]>([])
  const [completionIndex, setCompletionIndex] = useState(-1)
  // 退出确认
  const [quitConfirm, setQuitConfirm] = useState(false)
  // 历史导航
  const historyNav = useRef(new HistoryNavigator())
  // Ctrl+R 搜索
  const [searchMode, setSearchMode] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  const add = useCallback((e: Entry) => setEntries(p => [...p, { ...e, timestamp: Date.now() }]), [])

  const submit = useCallback(async (text: string) => {
    if (!text.trim()) return

    // 保存到历史
    addCommand(text.trim())

    const cmd = await processCommand(text.trim(), {
      messages: msgs,
      clearMessages: () => setMsgs([]),
    })
    if (cmd) {
      add({ type: 'command', content: cmd.content })
      if (cmd.clearHistory) {
        setMsgs([])
        clearTracker()
      }
      setInput('')
      setCompletions([])
      setCompletionIndex(-1)
      historyNav.current.reset()
      return
    }

    add({ type: 'user', content: text })
    setInput('')
    setCompletions([])
    setCompletionIndex(-1)
    historyNav.current.reset()
    setRunning(true)
    setTurn(0)
    setTurnStart(Date.now())

    try {
      const updated = await runQuery(text, config, [...msgs], {
        onToken: t => {
          setSpinnerStatus('思考中')
          setEntries(prev => {
            const last = prev[prev.length - 1]
            if (last?.type === 'assistant') {
              return [...prev.slice(0, -1), { ...last, content: last.content + t }]
            }
            return [...prev, { type: 'assistant', content: t }]
          })
        },
        onToolStart: (n, a) => {
          setSpinnerStatus(toolStatus(n))
          if (n === 'bash' && isDangerousCommand(a)) {
            add({ type: 'tool', content: `[危险] ${n}(${a.length > 50 ? a.slice(0, 50) + '…' : a})`, toolName: n, toolArgs: a })
          } else {
            add({ type: 'tool', content: `${n}(${a.length > 50 ? a.slice(0, 50) + '…' : a})`, toolName: n, toolArgs: a })
          }
        },
        onToolResult: (n, r) => {
          const lines = r.content.split('\n')
          if ((n === 'edit_file' || n === 'write_file') && !r.isError) {
            const match = r.content.match(/\[(\+\d+ -?\d* lines?)\]/)
            const summary = match ? match[1] : ''
            add({ type: 'toolResult', content: summary || lines[0].slice(0, 70) })
          } else if (n === 'read_file' && !r.isError && lines.length > 1) {
            add({ type: 'toolResult', content: lines[0] })
          } else if (n === 'bash' && !r.isError) {
            add({ type: 'toolResult', content: lines[0].slice(0, 70) || '(空输出)' })
          } else {
            add({ type: 'toolResult', content: lines[0].slice(0, 70) || '(空输出)' })
          }
          if (lines.length > 1 && n !== 'read_file') {
            add({ type: 'system', content: `(${lines.length} 行输出)` })
          }
        },
        onTurn: t => {
          setTurn(t)
          setTurnStart(Date.now())
        },
        onUsage: (usage: TokenUsage, model: string) => {
          const turnCost = estimateCost(usage, model)
          const tracker = getUsageTracker()
          add({
            type: 'system',
            content: `📊 tok: ${usage.input_tokens}→${usage.output_tokens}  缓存读:${usage.cache_read_input_tokens}  ${formatUsd(turnCost)} (累计 ${formatUsd(estimateCost(tracker.total, model))})`,
          })
        },
        onError: e => add({ type: 'error', content: e }),
        onApprovalNeeded: (request: ApprovalRequest): Promise<ApprovalDecision> => {
          return new Promise<ApprovalDecision>(resolve => {
            setPendingApproval(request)
            setApprovalResolve(() => resolve)
          })
        },
      })
      setMsgs(updated)
    } catch (ex: any) {
      add({ type: 'error', content: ex.message })
    }
    setRunning(false)
  }, [config, msgs, add])

  const handleApprovalDecision = useCallback((decision: ApprovalDecision) => {
    approvalResolve?.(decision)
    setPendingApproval(null)
    setApprovalResolve(null)
    if (decision === 'no') {
      add({ type: 'error', content: '用户拒绝执行' })
    }
  }, [approvalResolve, add])

  // ─── 键盘快捷键 ──────────────────────────────────────────────────
  useInput((inputKey, key) => {
    // Ctrl+C：取消当前操作
    if (key.ctrl && inputKey === 'c') {
      if (running) {
        setRunning(false)
        add({ type: 'system', content: '⏹️ 操作已取消' })
        return
      }
      if (searchMode) {
        setSearchMode(false)
        setSearchQuery('')
        setInput('')
        return
      }
      setInput('')
      setCompletions([])
      return
    }

    // Ctrl+D：退出确认
    if (key.ctrl && inputKey === 'd') {
      if (quitConfirm) {
        exit()
      } else {
        setQuitConfirm(true)
        setTimeout(() => setQuitConfirm(false), 3000)
      }
      return
    }

    // Ctrl+L：清屏
    if (key.ctrl && inputKey === 'l') {
      setEntries([])
      return
    }

    // Ctrl+B：切换侧边栏
    if (key.ctrl && inputKey === 'b') {
      setShowSidebar(prev => !prev)
      return
    }

    // Ctrl+R：反向搜索历史
    if (key.ctrl && inputKey === 'r') {
      setSearchMode(true)
      setSearchQuery('')
      return
    }

    if (running || pendingApproval) return

    // 搜索模式
    if (searchMode) {
      if (key.return) {
        setSearchMode(false)
        setSearchQuery('')
        return
      }
      if (key.escape) {
        setSearchMode(false)
        setSearchQuery('')
        setInput('')
        return
      }
      if (key.backspace) {
        setSearchQuery(prev => prev.slice(0, -1))
        return
      }
      if (inputKey && !key.ctrl && !key.meta) {
        const newQuery = searchQuery + inputKey
        setSearchQuery(newQuery)
        const results = historyNav.current.search(newQuery)
        if (results.length > 0) {
          setInput(results[0])
        }
        return
      }
      return
    }

    // Tab：命令自动补全
    if (key.tab) {
      if (input.startsWith('/')) {
        const comps = getCompletions(input)
        if (comps.length > 0) {
          const nextIdx = (completionIndex + 1) % comps.length
          setCompletionIndex(nextIdx)
          setInput(comps[nextIdx] + ' ')
          setCompletions(comps)
        }
      }
      return
    }

    // 上下箭头：历史命令导航
    if (key.upArrow) {
      const prev = historyNav.current.getPrevious(input)
      if (prev !== null) setInput(prev)
      return
    }
    if (key.downArrow) {
      const next = historyNav.current.getNext()
      if (next !== null) setInput(next)
      return
    }

    // Shift+Enter：多行输入
    if (key.shift && key.return) {
      setInput(prev => prev + '\n')
      return
    }
  })

  useEffect(() => { if (initialPrompt) submit(initialPrompt) }, [])

  const stats = getContextStats(msgs)
  const context = collectContext()
  const contextSummary = getContextSummary(context)
  const trackerStats = getTrackerStats()
  const approvalMode = getApprovalMode()
  const changedFiles = getChangedFiles()
  const tracker = getUsageTracker()
  const totalCost = formatUsd(estimateCost(tracker.total, config.model))

  return (
    <Box flexDirection="column">
      {/* 状态栏 */}
      <StatusBar
        model={config.model}
        provider={detectProvider(config)}
        cwd={process.cwd()}
        tokenInfo={totalCost}
        changeCount={changedFiles.length}
        approvalMode={approvalMode}
      />

      <Box flexDirection="row">
        {/* 主面板 */}
        <Box flexDirection="column" flexGrow={1} padding={1}>
          {/* 搜索模式提示 */}
          {searchMode && (
            <Box marginBottom={1}>
              <Text color="yellow">🔍 反向搜索: {searchQuery || '(输入搜索词)'}</Text>
              <Text dimColor> · Enter 选择 · Esc 取消</Text>
            </Box>
          )}

          {/* 退出确认 */}
          {quitConfirm && (
            <Box marginBottom={1}>
              <Text color="yellow">再次 Ctrl+D 确认退出</Text>
            </Box>
          )}

          {/* Tab 补全提示 */}
          {completions.length > 0 && !searchMode && (
            <Box marginBottom={1}>
              <Text dimColor>{completions.join('  ')}</Text>
            </Box>
          )}

          {/* Messages */}
          {entries.map((e, i) => (
            <Box key={i} marginBottom={0}>
              {e.type === 'user' && (
                <Box>
                  <Text color="blue">{'>'} </Text>
                  <Text bold>{e.content}</Text>
                </Box>
              )}
              {e.type === 'assistant' && (
                <Box marginLeft={2}>
                  <Text>{e.content}</Text>
                </Box>
              )}
              {e.type === 'tool' && (
                <Box marginLeft={2}>
                  <Text color="blue">{'>'} </Text>
                  <Text color="yellow">{e.content}</Text>
                </Box>
              )}
              {e.type === 'toolResult' && (
                <Box marginLeft={3}>
                  <Text dimColor>│ </Text>
                  <Text dimColor>{e.content}</Text>
                </Box>
              )}
              {e.type === 'system' && (
                <Box marginLeft={3}>
                  <Text dimColor>│ {e.content}</Text>
                </Box>
              )}
              {e.type === 'command' && (
                <Box marginLeft={2}>
                  <Text color="magenta">{e.content}</Text>
                </Box>
              )}
              {e.type === 'error' && (
                <Box marginLeft={2}>
                  <Text color="red">{'>'} </Text>
                  <Text color="red">{e.content}</Text>
                </Box>
              )}
            </Box>
          ))}

          {/* Spinner */}
          {running && !pendingApproval && <Spinner turn={turn} startTime={turnStart} status={spinnerStatus} />}

          {/* Approval Panel */}
          {pendingApproval && (
            <ApprovalPanel
              request={pendingApproval}
              onDecision={handleApprovalDecision}
            />
          )}

          {/* Input box */}
          {!running && !pendingApproval && (
            <Box flexDirection="column" marginTop={1}>
              <Box borderColor="cyan" borderStyle="round" borderLeft={false} borderRight={false} borderBottom paddingLeft={1} paddingRight={1}>
                <Text color="green" bold>{'> '}</Text>
                <TextInput
                  value={input}
                  onChange={(v) => {
                    setInput(v)
                    // 重置补全
                    if (completions.length > 0) {
                      setCompletions([])
                      setCompletionIndex(-1)
                    }
                  }}
                  onSubmit={submit}
                  placeholder={searchMode ? '搜索历史...' : ''}
                />
              </Box>
            </Box>
          )}

          {/* Footer */}
          {!running && !pendingApproval && (
            <Box marginTop={1} borderTop borderColor="gray" borderStyle="single" paddingLeft={1}>
              <Text dimColor>↑↓ 历史 · Tab 补全 · Ctrl+C 取消 · Ctrl+D 退出 · Ctrl+L 清屏 · Ctrl+B 侧边栏 · Ctrl+R 搜索</Text>
            </Box>
          )}
        </Box>

        {/* 侧边栏 */}
        {showSidebar && (
          <Sidebar
            entries={entries}
            changedFiles={changedFiles.map(c => ({ path: c.path, summary: formatChangeSummary(c) }))}
          />
        )}
      </Box>
    </Box>
  )
}
