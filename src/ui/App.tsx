import React, { useState, useCallback, useRef, useEffect } from 'react'
import { Box, Text, useInput } from 'ink'
import TextInput from 'ink-text-input'
import { loadConfig, saveConfig, loadSession, type Message } from '../config/index.js'
import { runQuery } from '../query/index.js'
import { createREPLState } from '../repl/index.js'
import { processCommand } from '../commands/index.js'
import { getContextStats } from '../memory/index.js'
import { PermissionDialog } from './components/PermissionDialog.js'
import { computeDiff, type DiffLine } from './diff.js'

interface Props { initialPrompt?: string }

type EntryType = 'user' | 'assistant' | 'tool' | 'toolResult' | 'error' | 'system' | 'command' | 'permission' | 'diff'
interface Entry {
  type: EntryType
  content: string
  toolName?: string
  toolArgs?: string
  timestamp?: number
}

// ─── Spinner（CC Shimmer 风格）─────────────────────────────────────────
const SPIN_VERBS = ['思考中', '编码中', '分析中', '搜索中', '读取中', '执行中', '编写中', '修改中']
const SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function Spinner({ turn, startTime }: { turn: number; startTime: number }) {
  const [frame, setFrame] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const verb = useRef('思考中')

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
      <Text color="cyan">{verb.current}…</Text>
      <Text dimColor> {sec}</Text>
      {turn > 1 && <Text dimColor> · 第 {turn} 轮</Text>}
    </Box>
  )
}

// ─── 危险命令检测 ─────────────────────────────────────────────────────
const DANGEROUS_PATTERNS = [
  /rm\s+(-[a-z]*f|--force|--recursive)\s/i,
  /rm\s+-rf\s/i,
  />\s*\/dev\//i,
  /mkfs\./i,
  /dd\s+if=/i,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;/i, // fork bomb
  /chmod\s+777\s/i,
  /curl.*\|\s*(ba)?sh/i,
  /wget.*\|\s*(ba)?sh/i,
]

function isDangerousCommand(command: string): boolean {
  return DANGEROUS_PATTERNS.some(p => p.test(command))
}

// ─── App ──────────────────────────────────────────────────────────────
export const App: React.FC<Props> = ({ initialPrompt }) => {
  const config = loadConfig()
  const [entries, setEntries] = useState<Entry[]>([])
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [turn, setTurn] = useState(0)
  const [turnStart, setTurnStart] = useState(Date.now())
  const [msgs, setMsgs] = useState<Message[]>(() => {
    // CC 风格：启动时自动恢复上次对话
    const saved = loadSession()
    return saved.length > 0 ? saved : createREPLState().messages
  })
  // 权限审批状态
  const [pendingTool, setPendingTool] = useState<{ name: string; args: string } | null>(null)
  const [toolResolve, setToolResolve] = useState<((value: boolean) => void) | null>(null)
  // 输入历史
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [savedInput, setSavedInput] = useState('')
  // 多行输入（CC 风格）
  const [multiline, setMultiline] = useState(false)

  const add = useCallback((e: Entry) => setEntries(p => [...p, { ...e, timestamp: Date.now() }]), [])

  const submit = useCallback(async (text: string) => {
    if (!text.trim()) return

    const cmd = await processCommand(text.trim(), {
      messages: msgs,
      clearMessages: () => setMsgs([]),
    })
    if (cmd) {
      add({ type: 'command', content: cmd.content })
      if (cmd.clearHistory) setMsgs([])
      setInput('')
      return
    }

    add({ type: 'user', content: text })
    setInput('')
    setHistory(h => [text, ...h].slice(0, 50))
    setHistoryIndex(-1)
    setRunning(true)
    setTurn(0)
    setTurnStart(Date.now())

    try {
      const updated = await runQuery(text, config, [...msgs], {
        onToken: t => {
          setEntries(prev => {
            const last = prev[prev.length - 1]
            if (last?.type === 'assistant') {
              return [...prev.slice(0, -1), { ...last, content: last.content + t }]
            }
            return [...prev, { type: 'assistant', content: t }]
          })
        },
        onToolStart: (n, a) => {
          // 检查危险命令
          if (n === 'bash' && isDangerousCommand(a)) {
            add({ type: 'tool', content: `⚠️ ${n}(${a.length > 50 ? a.slice(0, 50) + '…' : a})`, toolName: n, toolArgs: a })
          } else {
            add({ type: 'tool', content: `${n}(${a.length > 50 ? a.slice(0, 50) + '…' : a})`, toolName: n, toolArgs: a })
          }
        },
        onToolResult: (n, r) => {
          // CC 风格：树状缩进 ⎿
          const lines = r.content.split('\n')

          // 文件编辑：显示 diff
          if (n === 'edit_file' && !r.isError) {
            // 显示修改行数摘要
            const changeCount = lines.filter(l => l.startsWith('+') || l.startsWith('-')).length
            add({ type: 'toolResult', content: `已修改 (${Math.floor(changeCount / 2)} 处变更)` })
          }
          // 文件读取：显示行号
          else if (n === 'read_file' && !r.isError && lines.length > 1) {
            // 带行号显示（CC 风格）
            const numbered = lines.slice(0, 8).map((l, i) => `${String(i + 1).padStart(4)}→${l}`).join('\n')
            add({ type: 'toolResult', content: numbered.split('\n')[0] })
            if (lines.length > 8) {
              add({ type: 'system', content: `… (${lines.length} 行，已截断)` })
            }
          }
          // Bash：分离 stdout/stderr
          else if (n === 'bash' && !r.isError) {
            const firstLine = lines[0].slice(0, 70)
            add({ type: 'toolResult', content: firstLine || '(空输出)' })
          }
          else {
            const firstLine = lines[0].slice(0, 70)
            add({ type: 'toolResult', content: firstLine || '(空输出)' })
          }

          // 多行输出行数提示
          if (lines.length > 1 && n !== 'read_file') {
            add({ type: 'system', content: `(${lines.length} 行输出)` })
          }
        },
        onTurn: t => {
          setTurn(t)
          setTurnStart(Date.now())
        },
        onError: e => add({ type: 'error', content: e }),
      })
      setMsgs(updated)
    } catch (ex: any) {
      add({ type: 'error', content: ex.message })
    }
    setRunning(false)
  }, [config, msgs, add])

  // 权限审批回调
  const handlePermissionAccept = useCallback(() => {
    toolResolve?.(true)
    setPendingTool(null)
    setToolResolve(null)
  }, [toolResolve])

  const handlePermissionReject = useCallback(() => {
    toolResolve?.(false)
    setPendingTool(null)
    setToolResolve(null)
    add({ type: 'error', content: '命令被拒绝' })
  }, [toolResolve, add])

  useInput((input, key) => {
    if (key.ctrl && input === 'c' && running) setRunning(false)
    // 输入历史（↑↓ 箭头，CC 风格）
    if (key.upArrow && !running && !pendingTool) {
      if (historyIndex === -1) setSavedInput(input)
      const next = Math.min(historyIndex + 1, history.length - 1)
      if (next >= 0) {
        setHistoryIndex(next)
        setInput(history[next])
      }
    }
    if (key.downArrow && !running && !pendingTool) {
      if (historyIndex > 0) {
        setHistoryIndex(historyIndex - 1)
        setInput(history[historyIndex - 1])
      } else if (historyIndex === 0) {
        setHistoryIndex(-1)
        setInput(savedInput)
      }
    }
    // Shift+Enter = 新行（CC 多行输入）
    if (key.shift && key.return && !running && !pendingTool) {
      setInput(prev => prev + '\n')
      setMultiline(true)
    }
  })

  useEffect(() => { if (initialPrompt) submit(initialPrompt) }, [])

  const stats = getContextStats(msgs)

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box flexDirection="column" marginBottom={1}>
        <Box>
          <Text bold color="cyan">edgecli</Text>
          <Text dimColor> {config.model}</Text>
        </Box>
        <Text dimColor>{stats}</Text>
      </Box>

      {/* Messages */}
      {entries.map((e, i) => (
        <Box key={i} marginBottom={e.type === 'assistant' ? 0 : 1}>
          {/* User message */}
          {e.type === 'user' && (
            <Box>
              <Text color="green" bold>❯ </Text>
              <Text>{e.content}</Text>
            </Box>
          )}

          {/* Assistant reply */}
          {e.type === 'assistant' && (
            <Box marginLeft={2} marginBottom={1}>
              <Text>{e.content}</Text>
            </Box>
          )}

          {/* Tool call (CC style: ⏺ with command) */}
          {e.type === 'tool' && (
            <Box marginLeft={2}>
              <Text color="yellow">⏺ </Text>
              <Text color="yellow">{e.content}</Text>
            </Box>
          )}

          {/* Tool result (CC style: ⎿ tree) */}
          {e.type === 'toolResult' && (
            <Box marginLeft={4}>
              <Text dimColor>⎿  </Text>
              <Text dimColor>{e.content}</Text>
            </Box>
          )}

          {/* System message */}
          {e.type === 'system' && (
            <Box marginLeft={4}>
              <Text dimColor>   {e.content}</Text>
            </Box>
          )}

          {/* Command result */}
          {e.type === 'command' && (
            <Box marginLeft={2}>
              <Text color="magenta">{e.content}</Text>
            </Box>
          )}

          {/* Error */}
          {e.type === 'error' && (
            <Box marginLeft={2}>
              <Text color="red">✗ </Text>
              <Text color="red">{e.content}</Text>
            </Box>
          )}
        </Box>
      ))}

      {/* Spinner */}
      {running && <Spinner turn={turn} startTime={turnStart} />}

      {/* Permission dialog (CC style) */}
      {pendingTool && (
        <PermissionDialog
          title="⚠️ 危险命令"
          subtitle="请确认是否执行"
          command={pendingTool.args}
          description="此命令可能造成不可逆操作"
          onAccept={handlePermissionAccept}
          onReject={handlePermissionReject}
        />
      )}

      {/* Input box (CC style: round border) */}
      {!running && !pendingTool && (
        <Box flexDirection="column" marginTop={1}>
          <Box borderColor="cyan" borderStyle="round" borderLeft={false} borderRight={false} borderBottom paddingLeft={1} paddingRight={1}>
            <Text color="green" bold>❯ </Text>
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={submit}
              placeholder=""
            />
          </Box>
        </Box>
      )}

      {/* Footer (CC style: status bar) */}
      {!running && !pendingTool && (
        <Box marginTop={1} borderTop borderColor="gray" borderStyle="single" paddingLeft={1}>
          <Text dimColor>{config.model}</Text>
          <Text dimColor> · </Text>
          <Text dimColor>{getContextStats(msgs)}</Text>
          <Text dimColor> · </Text>
          <Text dimColor>/help</Text>
          <Text dimColor> · </Text>
          <Text dimColor>/clear</Text>
          <Text dimColor> · </Text>
          <Text dimColor>/quit</Text>
        </Box>
      )}
    </Box>
  )
}
