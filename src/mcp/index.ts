// ─── MCP 工具集成 ──────────────────────────────────────────────────────
// 支持连接外部 MCP server（stdio 模式）
// MCP 工具自动注册为 edgecli 工具

import { spawn, type ChildProcess } from 'child_process'
import { existsSync, readFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { ToolDef, ToolResult } from '../tools/index.js'

// ─── 类型定义 ──────────────────────────────────────────────────────
interface MCPServerConfig {
  command: string
  args: string[]
  env?: Record<string, string>
}

interface MCPConfig {
  servers: Record<string, MCPServerConfig>
}

interface MCPTool {
  name: string
  description: string
  inputSchema: Record<string, any>
}

interface MCPServer {
  name: string
  config: MCPServerConfig
  process: ChildProcess | null
  tools: MCPTool[]
  connected: boolean
  requestId: number
  pendingRequests: Map<number, { resolve: (value: any) => void; reject: (reason: any) => void }>
}

// ─── 配置加载 ──────────────────────────────────────────────────────
const CONFIG_PATH = join(homedir(), '.edgecli', 'mcp.json')

function loadMCPConfig(): MCPConfig {
  if (!existsSync(CONFIG_PATH)) {
    return { servers: {} }
  }
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
  } catch {
    return { servers: {} }
  }
}

// ─── MCP 服务器管理 ───────────────────────────────────────────────
const servers: Map<string, MCPServer> = new Map()

export async function connectServer(name: string, config: MCPServerConfig): Promise<boolean> {
  // 如果已连接，先断开
  if (servers.has(name)) {
    disconnectServer(name)
  }

  const server: MCPServer = {
    name,
    config,
    process: null,
    tools: [],
    connected: false,
    requestId: 1,
    pendingRequests: new Map(),
  }

  try {
    const childProcess = spawn(config.command, config.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...config.env },
    })

    server.process = childProcess
    servers.set(name, server)

    // 解析响应
    let buffer: Buffer = Buffer.alloc(0)
    childProcess.stdout?.on('data', (data: Buffer) => {
      buffer = Buffer.concat([buffer, data])
      while (true) {
        // 尝试解析 JSON-RPC 消息
        const result = tryParseMessage(buffer)
        if (!result.message) break
        buffer = result.remaining
        handleMCPMessage(server, result.message)
      }
    })

    childProcess.stderr?.on('data', () => {
      // 忽略 stderr
    })

    childProcess.on('error', (err) => {
      console.error(`MCP server ${name} error:`, err.message)
      server.connected = false
      servers.delete(name)
    })

    childProcess.on('exit', () => {
      server.connected = false
      servers.delete(name)
    })

    // 等待一小段时间让进程启动
    await new Promise(r => setTimeout(r, 500))

    // 发送初始化请求
    const initResult = await sendMCPRequest(server, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'edgecli', version: '0.1.0' },
    })

    // 发送 initialized 通知
    sendMCPNotification(server, 'notifications/initialized', {})

    // 获取工具列表
    try {
      const toolsResult = await sendMCPRequest(server, 'tools/list', {})
      server.tools = toolsResult?.tools || []
    } catch {
      server.tools = []
    }

    server.connected = true
    return true
  } catch (e) {
    console.error(`连接 MCP server ${name} 失败:`, (e as Error).message)
    servers.delete(name)
    return false
  }
}

function disconnectServer(name: string) {
  const server = servers.get(name)
  if (server?.process) {
    try {
      server.process.kill()
    } catch {}
  }
  servers.delete(name)
}

export function disconnectAllServers() {
  for (const [name] of servers) {
    disconnectServer(name)
  }
}

// ─── JSON-RPC 协议 ─────────────────────────────────────────────────
function tryParseMessage(buffer: Buffer): { message: any | null; remaining: Buffer } {
  // 尝试 Content-Length 头格式
  const headerEnd = buffer.indexOf('\r\n\r\n')
  if (headerEnd !== -1) {
    const header = buffer.subarray(0, headerEnd).toString('utf-8')
    const match = header.match(/Content-Length:\s*(\d+)/i)
    if (match) {
      const contentLength = parseInt(match[1])
      const messageStart = headerEnd + 4
      if (buffer.length >= messageStart + contentLength) {
        const body = buffer.subarray(messageStart, messageStart + contentLength).toString('utf-8')
        try {
          return { message: JSON.parse(body), remaining: buffer.subarray(messageStart + contentLength) }
        } catch {}
      }
      return { message: null, remaining: buffer }
    }
  }

  // 尝试换行分隔的 JSON（有些 MCP server 用这种格式）
  const newlineIdx = buffer.indexOf('\n')
  if (newlineIdx !== -1) {
    const line = buffer.subarray(0, newlineIdx).toString('utf-8').trim()
    if (line.startsWith('{')) {
      try {
        const msg = JSON.parse(line)
        return { message: msg, remaining: buffer.subarray(newlineIdx + 1) }
      } catch {}
    }
  }

  return { message: null, remaining: buffer }
}

function handleMCPMessage(server: MCPServer, message: any) {
  if (message.id !== undefined && server.pendingRequests.has(message.id)) {
    const pending = server.pendingRequests.get(message.id)!
    server.pendingRequests.delete(message.id)
    if (message.error) {
      pending.reject(new Error(message.error.message || 'MCP error'))
    } else {
      pending.resolve(message.result)
    }
  }
}

function sendMCPRequest(server: MCPServer, method: string, params: any): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!server.process?.stdin) {
      reject(new Error('MCP server process not available'))
      return
    }

    const id = server.requestId++
    server.pendingRequests.set(id, { resolve, reject })

    const message = JSON.stringify({ jsonrpc: '2.0', id, method, params })
    const content = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`

    server.process.stdin.write(content)

    setTimeout(() => {
      if (server.pendingRequests.has(id)) {
        server.pendingRequests.delete(id)
        reject(new Error(`MCP request timeout: ${method}`))
      }
    }, 15000)
  })
}

function sendMCPNotification(server: MCPServer, method: string, params: any) {
  if (!server.process?.stdin) return
  const message = JSON.stringify({ jsonrpc: '2.0', method, params })
  const content = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`
  server.process.stdin.write(content)
}

// ─── 工具注册 ──────────────────────────────────────────────────────
function mcpToolToEdgecliTool(serverName: string, mcpTool: MCPTool): ToolDef {
  return {
    name: `mcp_${serverName}_${mcpTool.name}`,
    description: `[MCP:${serverName}] ${mcpTool.description}`,
    parameters: mcpTool.inputSchema || { type: 'object', properties: {} },
    async execute(args: Record<string, any>): Promise<ToolResult> {
      const server = servers.get(serverName)
      if (!server?.connected) {
        return { content: `MCP server ${serverName} 未连接`, isError: true }
      }

      try {
        const result = await sendMCPRequest(server, 'tools/call', {
          name: mcpTool.name,
          arguments: args,
        })

        // MCP 工具结果格式：{ content: [{ type: 'text', text: '...' }] }
        if (result?.content && Array.isArray(result.content)) {
          const textParts = result.content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
          return { content: textParts.join('\n') || '(空结果)', isError: false }
        }

        return { content: JSON.stringify(result) || '(空结果)', isError: false }
      } catch (e: any) {
        return { content: `MCP 工具执行失败: ${e.message}`, isError: true }
      }
    },
  }
}

export function getMCPTools(): ToolDef[] {
  const tools: ToolDef[] = []
  for (const [name, server] of servers) {
    if (!server.connected) continue
    for (const mcpTool of server.tools) {
      tools.push(mcpToolToEdgecliTool(name, mcpTool))
    }
  }
  return tools
}

// ─── 初始化 ────────────────────────────────────────────────────────
export async function initMCPServers(): Promise<void> {
  const config = loadMCPConfig()
  const results = await Promise.allSettled(
    Object.entries(config.servers).map(([name, serverConfig]) =>
      connectServer(name, serverConfig)
    )
  )
  // 静默处理失败
  for (const result of results) {
    if (result.status === 'rejected') {
      // 连接失败的 server 已在 connectServer 中处理
    }
  }
}

// ─── 状态查询 ──────────────────────────────────────────────────────
export interface MCPServerStatus {
  name: string
  connected: boolean
  toolCount: number
  tools: string[]
}

export function getMCPServerStatuses(): MCPServerStatus[] {
  const statuses: MCPServerStatus[] = []
  for (const [name, server] of servers) {
    statuses.push({
      name,
      connected: server.connected,
      toolCount: server.tools.length,
      tools: server.tools.map(t => t.name),
    })
  }
  return statuses
}

export function listAllMCPServers(): string[] {
  return Array.from(servers.keys())
}

export function isMCPServerConnected(name: string): boolean {
  return servers.get(name)?.connected || false
}
