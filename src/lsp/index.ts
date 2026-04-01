// ─── LSP 集成 ──────────────────────────────────────────────────────────
// 通过 stdio 连接语言服务器，提供代码补全、跳转定义、查找引用、悬停信息
// 默认支持 TypeScript 和 Python

import { spawn, type ChildProcess } from 'child_process'
import { resolve, extname } from 'path'
import { existsSync } from 'fs'

// ─── LSP 协议类型 ──────────────────────────────────────────────────
interface LSPPosition { line: number; character: number }
interface LSPLocation { uri: string; range: { start: LSPPosition; end: LSPPosition } }
interface LSPCompletionItem { label: string; kind?: number; detail?: string; documentation?: string }
interface LSPHover { contents: string | { value: string } | Array<string | { value: string }>; range?: { start: LSPPosition; end: LSPPosition } }

export interface CompletionResult { items: LSPCompletionItem[]; isIncomplete: boolean }
export interface DefinitionResult { locations: LSPLocation[] }
export interface ReferencesResult { locations: LSPLocation[] }
export interface HoverResult { content: string; range?: { start: LSPPosition; end: LSPPosition } }

// ─── 语言服务器配置 ──────────────────────────────────────────────────
interface LanguageServerConfig {
  command: string
  args: string[]
  languageId: string
  fileExtensions: string[]
}

const LANGUAGE_SERVERS: Record<string, LanguageServerConfig> = {
  typescript: {
    command: 'typescript-language-server',
    args: ['--stdio'],
    languageId: 'typescript',
    fileExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
  },
  python: {
    command: 'pylsp',
    args: [],
    languageId: 'python',
    fileExtensions: ['.py', '.pyi'],
  },
}

// ─── LSP 客户端 ────────────────────────────────────────────────────
interface LSPClient {
  process: ChildProcess
  config: LanguageServerConfig
  requestId: number
  pendingRequests: Map<number, { resolve: (value: any) => void; reject: (reason: any) => void }>
  initialized: boolean
  rootUri: string
}

const clients: Map<string, LSPClient> = new Map()

function detectLanguage(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase()
  for (const [lang, config] of Object.entries(LANGUAGE_SERVERS)) {
    if (config.fileExtensions.includes(ext)) return lang
  }
  return null
}

function isServerAvailable(command: string): boolean {
  try {
    const { execSync } = require('child_process')
    execSync(`which ${command}`, { encoding: 'utf-8', timeout: 3000 })
    return true
  } catch {
    return false
  }
}

async function startServer(language: string, rootUri: string): Promise<LSPClient | null> {
  const config = LANGUAGE_SERVERS[language]
  if (!config) return null

  if (!isServerAvailable(config.command)) {
    console.error(`LSP 服务器不可用: ${config.command}`)
    return null
  }

  // 如果已有客户端且已初始化，直接返回
  const existing = clients.get(language)
  if (existing?.initialized) return existing

  try {
    const childProcess = spawn(config.command, config.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: rootUri.replace('file://', ''),
    })

    const client: LSPClient = {
      process: childProcess,
      config,
      requestId: 1,
      pendingRequests: new Map(),
      initialized: false,
      rootUri,
    }

    clients.set(language, client)

    // 设置响应解析
    let buffer: Buffer = Buffer.alloc(0)
    childProcess.stdout?.on('data', (data: Buffer) => {
      buffer = Buffer.concat([buffer, data])
      while (true) {
        const headerEnd = buffer.indexOf('\r\n\r\n')
        if (headerEnd === -1) break

        const header = buffer.subarray(0, headerEnd).toString('utf-8')
        const contentLengthMatch = header.match(/Content-Length: (\d+)/i)
        if (!contentLengthMatch) {
          buffer = buffer.subarray(headerEnd + 4)
          continue
        }

        const contentLength = parseInt(contentLengthMatch[1])
        const messageStart = headerEnd + 4
        if (buffer.length < messageStart + contentLength) break

        const messageBody = buffer.subarray(messageStart, messageStart + contentLength).toString('utf-8')
        buffer = buffer.subarray(messageStart + contentLength)

        try {
          const message = JSON.parse(messageBody)
          handleLSPMessage(client, message)
        } catch {}
      }
    })

    childProcess.stderr?.on('data', () => {
      // 忽略 stderr 输出
    })

    childProcess.on('error', () => {
      clients.delete(language)
    })

    childProcess.on('exit', () => {
      clients.delete(language)
    })

    // 发送初始化请求
    await sendRequest(client, 'initialize', {
      processId: process.pid,
      rootUri,
      capabilities: {
        textDocument: {
          completion: { completionItem: { snippetSupport: false } },
          hover: { contentFormat: ['plaintext'] },
          definition: {},
          references: {},
        },
      },
      clientInfo: { name: 'edgecli', version: '0.1.0' },
    })

    // 发送 initialized 通知
    sendNotification(client, 'initialized', {})

    // 打开工作区文件夹
    sendNotification(client, 'workspace/didChangeWorkspaceFolders', {
      event: { added: [{ uri: rootUri, name: 'workspace' }], removed: [] },
    })

    client.initialized = true
    return client
  } catch (e) {
    console.error(`启动 LSP 服务器失败 (${language}):`, (e as Error).message)
    clients.delete(language)
    return null
  }
}

function handleLSPMessage(client: LSPClient, message: any) {
  if (message.id !== undefined && client.pendingRequests.has(message.id)) {
    const pending = client.pendingRequests.get(message.id)!
    client.pendingRequests.delete(message.id)
    if (message.error) {
      pending.reject(new Error(message.error.message))
    } else {
      pending.resolve(message.result)
    }
  }
}

function sendRequest(client: LSPClient, method: string, params: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = client.requestId++
    client.pendingRequests.set(id, { resolve, reject })

    const message = JSON.stringify({ jsonrpc: '2.0', id, method, params })
    const content = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`

    client.process.stdin?.write(content)

    // 超时处理
    setTimeout(() => {
      if (client.pendingRequests.has(id)) {
        client.pendingRequests.delete(id)
        reject(new Error(`LSP 请求超时: ${method}`))
      }
    }, 10000)
  })
}

function sendNotification(client: LSPClient, method: string, params: any) {
  const message = JSON.stringify({ jsonrpc: '2.0', method, params })
  const content = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`
  client.process.stdin?.write(content)
}

// ─── 打开文件通知 ──────────────────────────────────────────────────
function notifyFileOpen(client: LSPClient, filePath: string, content: string) {
  sendNotification(client, 'textDocument/didOpen', {
    textDocument: {
      uri: `file://${resolve(filePath)}`,
      languageId: client.config.languageId,
      version: 1,
      text: content,
    },
  })
}

// ─── 公共 API ──────────────────────────────────────────────────────
export async function lspComplete(
  filePath: string,
  line: number,
  character: number,
  workspace?: string
): Promise<CompletionResult> {
  const language = detectLanguage(filePath)
  if (!language) return { items: [], isIncomplete: false }

  const rootUri = `file://${resolve(workspace || process.cwd())}`
  const client = await startServer(language, rootUri)
  if (!client) return { items: [], isIncomplete: false }

  // 读取并通知文件
  try {
    const { readFileSync } = require('fs')
    const content = readFileSync(filePath, 'utf-8')
    notifyFileOpen(client, filePath, content)
  } catch {
    return { items: [], isIncomplete: false }
  }

  try {
    const result = await sendRequest(client, 'textDocument/completion', {
      textDocument: { uri: `file://${resolve(filePath)}` },
      position: { line, character },
    })
    return {
      items: result?.items || [],
      isIncomplete: result?.isIncomplete || false,
    }
  } catch {
    return { items: [], isIncomplete: false }
  }
}

export async function lspDefinition(
  filePath: string,
  line: number,
  character: number,
  workspace?: string
): Promise<DefinitionResult> {
  const language = detectLanguage(filePath)
  if (!language) return { locations: [] }

  const rootUri = `file://${resolve(workspace || process.cwd())}`
  const client = await startServer(language, rootUri)
  if (!client) return { locations: [] }

  try {
    const { readFileSync } = require('fs')
    const content = readFileSync(filePath, 'utf-8')
    notifyFileOpen(client, filePath, content)
  } catch {}

  try {
    const result = await sendRequest(client, 'textDocument/definition', {
      textDocument: { uri: `file://${resolve(filePath)}` },
      position: { line, character },
    })
    const locations = Array.isArray(result) ? result : result ? [result] : []
    return { locations }
  } catch {
    return { locations: [] }
  }
}

export async function lspReferences(
  filePath: string,
  line: number,
  character: number,
  workspace?: string
): Promise<ReferencesResult> {
  const language = detectLanguage(filePath)
  if (!language) return { locations: [] }

  const rootUri = `file://${resolve(workspace || process.cwd())}`
  const client = await startServer(language, rootUri)
  if (!client) return { locations: [] }

  try {
    const { readFileSync } = require('fs')
    const content = readFileSync(filePath, 'utf-8')
    notifyFileOpen(client, filePath, content)
  } catch {}

  try {
    const result = await sendRequest(client, 'textDocument/references', {
      textDocument: { uri: `file://${resolve(filePath)}` },
      position: { line, character },
      context: { includeDeclaration: true },
    })
    return { locations: result || [] }
  } catch {
    return { locations: [] }
  }
}

export async function lspHover(
  filePath: string,
  line: number,
  character: number,
  workspace?: string
): Promise<HoverResult | null> {
  const language = detectLanguage(filePath)
  if (!language) return null

  const rootUri = `file://${resolve(workspace || process.cwd())}`
  const client = await startServer(language, rootUri)
  if (!client) return null

  try {
    const { readFileSync } = require('fs')
    const content = readFileSync(filePath, 'utf-8')
    notifyFileOpen(client, filePath, content)
  } catch {}

  try {
    const result = await sendRequest(client, 'textDocument/hover', {
      textDocument: { uri: `file://${resolve(filePath)}` },
      position: { line, character },
    })
    if (!result) return null

    let content = ''
    if (typeof result.contents === 'string') {
      content = result.contents
    } else if (result.contents?.value) {
      content = result.contents.value
    } else if (Array.isArray(result.contents)) {
      content = result.contents.map((c: any) =>
        typeof c === 'string' ? c : c?.value || ''
      ).filter(Boolean).join('\n')
    }

    return { content, range: result.range }
  } catch {
    return null
  }
}

// ─── LSP 服务器管理 ────────────────────────────────────────────────
export function restartServer(language: string) {
  const client = clients.get(language)
  if (client) {
    try {
      sendNotification(client, 'shutdown', {})
      client.process.kill()
    } catch {}
    clients.delete(language)
  }
}

export function shutdownAllServers() {
  for (const [lang, client] of clients) {
    try {
      sendNotification(client, 'shutdown', {})
      client.process.kill()
    } catch {}
  }
  clients.clear()
}

export function getServerStatus(): Record<string, { running: boolean; available: boolean }> {
  const status: Record<string, { running: boolean; available: boolean }> = {}
  for (const [lang, config] of Object.entries(LANGUAGE_SERVERS)) {
    status[lang] = {
      running: clients.has(lang) && clients.get(lang)!.initialized,
      available: isServerAvailable(config.command),
    }
  }
  return status
}

export function getSupportedLanguages(): string[] {
  return Object.keys(LANGUAGE_SERVERS)
}
