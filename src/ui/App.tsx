import React, { useState, useCallback, useRef, useEffect } from 'react'
import { Box, Text, useInput, useStdin } from 'ink'
import TextInput from 'ink-text-input'
import { loadConfig, type Message } from '../config/index.js'
import { runQuery } from '../query/index.js'
import { createREPLState } from '../repl/index.js'
import { processCommand } from '../commands/index.js'
import { getContextStats } from '../memory/index.js'

interface Props { initialPrompt?: string }

type EntryType = 'user' | 'assistant' | 'tool' | 'toolResult' | 'error' | 'system' | 'command'
interface Entry { type: EntryType; content: string; timestamp?: number }

// ─── Spinner（CC 风格：动词 + 耗时 + token）─────────────────────────
const SPIN_VERBS = ['思考中', '编码中', '分析中', '搜索中', '读取中', '执行中', '编写中', '修改中']
const SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function Spinner({ turn, startTime }: { turn: number; startTime: number }) {
  const [frame, setFrame] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const verb = useRef(SPIN_VERBS[Math.floor(Math.random() * SPIN_VERBS.length)])

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

// ─── Header（CC 风格）────────────────────────────────────────────────
function Header({ model, stats }: { model: string; stats: string }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text bold color="cyan">edgecli</Text>
        <Text dimColor> {model}</Text>
      </Box>
      <Text dimColor>{stats}</Text>
    </Box>
  )
}

// ─── Footer（CC 风格：状态栏）────────────────────────────────────────
function Footer({ running }: { running: boolean }) {
  if (running) return null
  return (
    <Box marginTop={1} borderTop borderColor="gray" borderStyle="single" paddingLeft={1}>
      <Text dimColor>/help</Text>
      <Text dimColor> · </Text>
      <Text dimColor>/clear</Text>
      <Text dimColor> · </Text>
      <Text dimColor>/compact</Text>
      <Text dimColor> · </Text>
      <Text dimColor>/quit</Text>
    </Box>
  )
}

// ─── App ──────────────────────────────────────────────────────────────
export const App: React.FC<Props> = ({ initialPrompt }) => {
  const config = loadConfig()
  const [entries, setEntries] = useState<Entry[]>([])
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [turn, setTurn] = useState(0)
  const [turnStart, setTurnStart] = useState(Date.now())
  const [msgs, setMsgs] = useState<Message[]>(createREPLState().messages)
  const startTime = useRef(Date.now())

  const add = useCallback((e: Entry) => setEntries(p => [...p, { ...e, timestamp: Date.now() }]), [])

  const submit = useCallback(async (text: string) => {
    if (!text.trim()) return

    const cmd = processCommand(text.trim())
    if (cmd) {
      add({ type: 'command', content: cmd.content })
      if (cmd.clearHistory) setMsgs([])
      setInput('')
      return
    }

    add({ type: 'user', content: text })
    setInput('')
    setRunning(true)
    setTurn(0)
    startTime.current = Date.now()
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
          // CC 风格：工具名 + 参数预览
          const preview = a.length > 50 ? a.slice(0, 50) + '…' : a
          add({ type: 'tool', content: `${n}(${preview})` })
        },
        onToolResult: (n, r) => {
          // CC 风格：结果缩进显示，首行截断
          const firstLine = r.content.split('\n')[0].slice(0, 70)
          add({ type: 'toolResult', content: firstLine || '(空输出)' })
        },
        onTurn: t => {
          setTurn(t)
          setTurnStart(Date.now()) // 每轮重新计时
        },
        onError: e => add({ type: 'error', content: e }),
      })
      setMsgs(updated)
    } catch (ex: any) {
      add({ type: 'error', content: ex.message })
    }
    setRunning(false)
  }, [config, msgs, add])

  // CC 风格：输入框快捷键
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      if (running) setRunning(false)
    }
  })

  useEffect(() => { if (initialPrompt) submit(initialPrompt) }, [])

  const stats = getContextStats(msgs)

  return (
    <Box flexDirection="column" padding={1}>
      <Header model={config.model} stats={stats} />

      {/* 消息区域 */}
      {entries.map((e, i) => (
        <Box key={i} marginBottom={e.type === 'assistant' ? 0 : 1}>
          {/* 用户消息：绿色 > 前缀 */}
          {e.type === 'user' && (
            <Box>
              <Text color="green" bold>❯ </Text>
              <Text>{e.content}</Text>
            </Box>
          )}

          {/* 助手回复：无前缀，左缩进 */}
          {e.type === 'assistant' && (
            <Box marginLeft={2} marginBottom={1}>
              <Text>{e.content}</Text>
            </Box>
          )}

          {/* 工具调用：黄色，有边框感 */}
          {e.type === 'tool' && (
            <Box marginLeft={2}>
              <Text color="yellow">⏺ </Text>
              <Text color="yellow">{e.content}</Text>
            </Box>
          )}

          {/* 工具结果：灰色缩进 */}
          {e.type === 'toolResult' && (
            <Box marginLeft={4}>
              <Text dimColor>└ </Text>
              <Text dimColor>{e.content}</Text>
            </Box>
          )}

          {/* 系统消息 */}
          {e.type === 'system' && (
            <Box marginLeft={2}>
              <Text dimColor>{e.content}</Text>
            </Box>
          )}

          {/* 命令结果 */}
          {e.type === 'command' && (
            <Box marginLeft={2}>
              <Text color="magenta">{e.content}</Text>
            </Box>
          )}

          {/* 错误 */}
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

      {/* 输入框（CC 风格：圆角边框） */}
      {!running && (
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

      <Footer running={running} />
    </Box>
  )
}
