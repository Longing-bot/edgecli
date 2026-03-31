import React, { useState, useCallback } from 'react'
import { Box, Text } from 'ink'
import TextInput from 'ink-text-input'
import { loadConfig, type Message } from '../config/index.js'
import { runQuery } from '../query/index.js'
import { createREPLState } from '../repl/index.js'
import { processCommand } from '../commands/index.js'
import { getContextStats } from '../memory/index.js'

interface Props { initialPrompt?: string }
interface Entry { type: 'user' | 'assistant' | 'tool' | 'error' | 'system' | 'command'; content: string }

const P = '> '

export const App: React.FC<Props> = ({ initialPrompt }) => {
  const config = loadConfig()
  const [entries, setEntries] = useState<Entry[]>([])
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [turn, setTurn] = useState(0)
  const [msgs, setMsgs] = useState<Message[]>(createREPLState().messages)
  const add = useCallback((e: Entry) => setEntries(p => [...p, e]), [])

  const submit = useCallback(async (text: string) => {
    if (!text.trim()) return

    // Check for slash commands
    const cmd = processCommand(text.trim())
    if (cmd) {
      add({ type: 'command', content: cmd.content })
      if (cmd.clearHistory) setMsgs([])
      setInput('')
      return
    }

    add({ type: 'user', content: text }); setInput(''); setRunning(true); setTurn(0)
    try {
      const updated = await runQuery(text, config, [...msgs], {
        onToken: t => {
          // 流式追加到最后一个 assistant entry
          setEntries(prev => {
            const last = prev[prev.length - 1]
            if (last?.type === 'assistant') {
              return [...prev.slice(0, -1), { ...last, content: last.content + t }]
            }
            return [...prev, { type: 'assistant', content: t }]
          })
        },
        onToolStart: (n, a) => add({ type: 'tool', content: `${n}(${a.length > 40 ? a.slice(0, 40) + '...' : a})` }),
        onToolResult: (_, r) => add({ type: 'system', content: `  -> ${r.content.split('\n')[0].slice(0, 60)}` }),
        onTurn: t => setTurn(t),
        onError: e => add({ type: 'error', content: e }),
      })
      setMsgs(updated)
    } catch (ex: any) { add({ type: 'error', content: ex.message }) }
    setRunning(false)
  }, [config, msgs, add])

  React.useEffect(() => { if (initialPrompt) submit(initialPrompt) }, [])

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">{'edgecli '}</Text>
        <Text dimColor>[{config.model}] </Text>
        {msgs.length > 0 && <Text dimColor>({getContextStats(msgs)})</Text>}
      </Box>
      {entries.map((e, i) => (
        <Box key={i} marginBottom={1}>
          {e.type === 'user' && <Box><Text color="green" bold>{P}</Text><Text>{e.content}</Text></Box>}
          {e.type === 'assistant' && <Box marginLeft={2}><Text>{e.content}</Text></Box>}
          {e.type === 'tool' && <Box marginLeft={2}><Text color="yellow">{'🔧 '}</Text><Text color="yellow">{e.content}</Text></Box>}
          {e.type === 'system' && <Box marginLeft={4}><Text dimColor>{e.content}</Text></Box>}
          {e.type === 'command' && <Box marginLeft={2}><Text color="magenta">{e.content}</Text></Box>}
          {e.type === 'error' && <Box marginLeft={2}><Text color="red">{'❌ '}{e.content}</Text></Box>}
        </Box>
      ))}
      {running && turn > 1 && <Box marginLeft={2}><Text dimColor>{'⏳'} turn {turn}</Text></Box>}
      {!running && (
        <Box>
          <Text color="green" bold>{P}</Text>
          <TextInput value={input} onChange={setInput} onSubmit={submit} placeholder="Type your request or /help..." />
        </Box>
      )}
    </Box>
  )
}
