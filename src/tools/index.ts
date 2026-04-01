// ─── Layer 4: Tools ───────────────────────────────────────────────────────
// CC-inspired: clear constraints per tool, banned commands, safety checks

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'fs'
import { resolve, dirname, basename, join } from 'path'
import { execSync } from 'child_process'

const MAX = 12000
export interface ToolResult { content: string; isError: boolean }
export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
  timeout?: number // 超时秒数，默认 30s
  execute: (args: Record<string, any>) => ToolResult | Promise<ToolResult>
}

function ok(s: string): ToolResult { return { content: s, isError: false } }
function err(s: string): ToolResult { return { content: s, isError: true } }

// ─── 工具执行包装器：统一超时、错误格式化、执行时间统计 ─────────────────
export async function executeToolWithMeta(tool: ToolDef, args: Record<string, any>): Promise<ToolResult> {
  const timeout = (tool.timeout || 30) * 1000
  const start = Date.now()
  let timer: ReturnType<typeof setTimeout> | null = null

  try {
    const result = await Promise.race([
      tool.execute(args),
      new Promise<ToolResult>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Tool "${tool.name}" timed out after ${timeout / 1000}s`)), timeout)
      }),
    ])
    if (timer) clearTimeout(timer)

    const elapsed = Date.now() - start
    // 附上执行时间到结果
    const elapsedTag = elapsed > 500 ? ` (${(elapsed / 1000).toFixed(1)}s)` : ''
    return {
      content: result.content + (elapsed > 500 ? elapsedTag : ''),
      isError: result.isError,
    }
  } catch (ex: any) {
    if (timer) clearTimeout(timer)
    const elapsed = ((Date.now() - start) / 1000).toFixed(1)
    const msg = ex.message || String(ex)
    return { content: `❌ ${tool.name} failed after ${elapsed}s: ${msg}`, isError: true }
  }
}

// ─── Banned / Safe ────────────────────────────────────────────────────
const BANNED = ['rm -rf /', 'rm -rf /*', 'mkfs', ':(){', 'chmod 777 /', '> /dev/sd', 'dd if=/dev/']

// OpenCode 风格：文件操作命令应该用专用工具
const FILE_OPS = new Set(['rm', 'cp', 'mv', 'mkdir', 'touch', 'chmod', 'chown', 'cat', 'head', 'tail', 'sed', 'awk', 'grep', 'find'])

const SAFE = ['ls','pwd','date','whoami','id','env','echo','which','test','true','false',
  'git status','git log','git diff','git show','git branch','git tag','git remote','git ls-files','git blame','git grep','git shortlog',
  'wc','sort','uniq','file','stat','du','df','uname','hostname',
  'node --version','npm --version','npx','python --version','python3 --version','go version','rustc --version','cargo --version',
  'pip list','pip show','npm list','npm outdated','yarn','pnpm','docker ps','docker images','docker logs',
  'curl -s','wget -q','ssh -V','scp','rsync --dry','ps aux','top -l','kill -l','lsof','netstat','ss','ip addr',
  'python3 -c','python -c','pytest','jest','vitest','make','cmake']

// ─── Core Tools ────────────────────────────────────────────────────────
export const readFileTool: ToolDef = {
  name: 'read_file',
  description: 'Read file contents with line numbers. Supports offset/limit for large files. DO NOT use bash cat for reading files.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to file' },
      offset: { type: 'integer', default: 0, description: 'Start line (0-indexed)' },
      limit: { type: 'integer', default: 200, description: 'Max lines to read' },
    },
    required: ['file_path'],
    examples: [
      { file_path: 'src/index.ts' },
      { file_path: 'src/index.ts', offset: 100, limit: 50 },
    ],
  },
  execute({ file_path, offset = 0, limit = 200 }) {
    try {
      const p = resolve(file_path)
      if (!existsSync(p)) return err(`File not found: ${file_path}`)
      if (!statSync(p).isFile()) return err(`Not a file: ${file_path}`)
      if (statSync(p).size > 2_000_000) return err(`Too large (${statSync(p).size} bytes). Use offset/limit.`)
      const lines = readFileSync(p, 'utf-8').split('\n')
      const s = Math.max(0, offset), e = Math.min(s + limit, lines.length)
      return ok(`📄 ${p} (${lines.length} lines)${s > 0 ? ` [${s+1}-${e}]` : ''}\n${lines.slice(s, e).map((l, i) => `${(s+i+1).toString().padStart(6)}→${l}`).join('\n')}`)
    } catch (ex: any) { return err(ex.message) }
  }
}

export const writeFileTool: ToolDef = {
  name: 'write_file',
  description: 'Write content to a file. For NEW files or complete rewrites only. For editing existing files, use edit_file.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to file' },
      content: { type: 'string', description: 'Full file content' },
    },
    required: ['file_path', 'content'],
    examples: [
      { file_path: 'new_file.ts', content: 'console.log("hello")' },
    ],
  },
  execute({ file_path, content }) {
    try {
      const p = resolve(file_path)
      mkdirSync(dirname(p), { recursive: true })
      const existed = existsSync(p)
      const old = existed ? readFileSync(p, 'utf-8').trim().split('\n').length : 0
      writeFileSync(p, content)
      const nw = content.trim().split('\n').length
      return existed ? ok(`✏️ ${p} (${nw - old >= 0 ? '+' : ''}${nw - old} lines)`) : ok(`✅ Created ${p} (${nw} lines)`)
    } catch (ex: any) { return err(ex.message) }
  }
}

export const editFileTool: ToolDef = {
  name: 'edit_file',
  description: 'Edit file by replacing exact old_string with new_string. For MODIFYING existing files only. Include enough surrounding context for unique match.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to file' },
      old_string: { type: 'string', description: 'Exact text to find and replace' },
      new_string: { type: 'string', description: 'Replacement text' },
    },
    required: ['file_path', 'old_string', 'new_string'],
    examples: [
      { file_path: 'src/app.ts', old_string: 'const port = 3000', new_string: 'const port = 8080' },
    ],
  },
  execute({ file_path, old_string, new_string }) {
    try {
      const p = resolve(file_path)
      if (!existsSync(p)) return err(`Not found: ${file_path}`)
      const c = readFileSync(p, 'utf-8')
      const n = c.split(old_string).length - 1
      if (!n) return err('old_string not found. Re-read the file.')
      if (n > 1) return err(`Found ${n} times. Include more context.`)
      writeFileSync(p, c.replace(old_string, new_string))
      return ok(`✏️ Edited ${basename(p)} (${old_string.split('\n').length}→${new_string.split('\n').length} lines)`)
    } catch (ex: any) { return err(ex.message) }
  }
}

export const patchFileTool: ToolDef = {
  name: 'patch_file',
  description: 'Precise line-level file edit. Replace lines start_line through end_line (1-indexed, inclusive) with new_content. More precise than edit_file when you know exact line numbers.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to file' },
      start_line: { type: 'integer', description: 'First line to replace (1-indexed, inclusive)' },
      end_line: { type: 'integer', description: 'Last line to replace (1-indexed, inclusive)' },
      new_content: { type: 'string', description: 'Replacement text for the line range' },
    },
    required: ['file_path', 'start_line', 'end_line', 'new_content'],
    examples: [
      { file_path: 'src/index.ts', start_line: 5, end_line: 7, new_content: 'const x = 42\nconsole.log(x)' },
    ],
  },
  execute({ file_path, start_line, end_line, new_content }) {
    try {
      const p = resolve(file_path)
      if (!existsSync(p)) return err(`Not found: ${file_path}`)
      const lines = readFileSync(p, 'utf-8').split('\n')
      if (start_line < 1 || start_line > lines.length) return err(`start_line ${start_line} out of range (1-${lines.length})`)
      if (end_line < start_line || end_line > lines.length) return err(`end_line ${end_line} out of range (${start_line}-${lines.length})`)

      const newLines = new_content.split('\n')
      const before = lines.slice(0, start_line - 1)
      const after = lines.slice(end_line)
      const result = [...before, ...newLines, ...after]
      writeFileSync(p, result.join('\n'))

      const removed = end_line - start_line + 1
      const delta = newLines.length - removed
      return ok(`✏️ Patched ${basename(p)} lines ${start_line}-${end_line}: ${removed}→${newLines.length} lines (${delta >= 0 ? '+' : ''}${delta})`)
    } catch (ex: any) { return err(ex.message) }
  }
}

export const bashTool: ToolDef = {
  name: 'bash',
  description: 'Execute shell command. Dangerous commands are auto-blocked. Use dedicated tools (read_file/write_file/edit_file/glob/grep) for file operations instead.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      timeout: { type: 'integer', default: 30, description: 'Timeout in seconds' },
    },
    required: ['command'],
    examples: [
      { command: 'ls -la' },
      { command: 'npm test', timeout: 60 },
      { command: 'git log --oneline -10' },
    ],
  },
  timeout: 60, // bash 默认 60s
  execute({ command, timeout = 30 }) {
    for (const b of BANNED) if (command.includes(b)) return err(`🚫 Blocked: '${b}'`)
    const cmdName = command.trim().split(/\s+/)[0]
    if (FILE_OPS.has(cmdName)) {
      return ok(`⚠️ 建议使用专用工具代替 bash ${cmdName}：
- 读文件: read_file
- 写文件: write_file
- 编辑: edit_file / patch_file
- 搜索文件: glob
- 搜索内容: grep`)
    }
    try {
      const out = execSync(command, { timeout: timeout * 1000, encoding: 'utf-8', maxBuffer: MAX, cwd: process.cwd() })
      return ok(out.length > MAX ? out.slice(0, MAX) + '\n...' : (out || '(no output)'))
    } catch (ex: any) {
      return ok((ex.stdout || '') + (ex.stderr ? `\n[stderr]\n${ex.stderr}` : '') + (ex.status ? `\n[exit: ${ex.status}]` : '') || ex.message)
    }
  }
}

export const globTool: ToolDef = {
  name: 'glob',
  description: 'Find files by glob pattern (e.g. "*.ts", "**/*.json"). NOT for content search (use grep). NOT for reading files (use read_file).',
  parameters: {
    type: 'object',
    properties: { pattern: { type: 'string', description: 'Glob pattern to match file names' } },
    required: ['pattern'],
    examples: [
      { pattern: '*.ts' },
      { pattern: '**/*.json' },
      { pattern: 'src/**/*.test.ts' },
    ],
  },
  execute({ pattern }) {
    try { return ok(execSync(`find . -name '${pattern}' -not -path './.git/*' -not -path './node_modules/*' 2>/dev/null | head -100`, { encoding: 'utf-8', timeout: 10000 }).trim() || `No matches: ${pattern}`) }
    catch { return ok(`No matches: ${pattern}`) }
  }
}

export const grepTool: ToolDef = {
  name: 'grep',
  description: 'Search file contents with regex. Returns file:line format. Use include to filter by extension (e.g. "*.ts"). NOT for finding files by name (use glob).',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern to search' },
      path: { type: 'string', default: '.', description: 'Directory to search' },
      include: { type: 'string', default: '', description: 'File extension filter (e.g. "*.ts")' },
    },
    required: ['pattern'],
    examples: [
      { pattern: 'TODO|FIXME' },
      { pattern: 'function.*handler', include: '*.ts' },
      { pattern: 'import.*from', path: 'src/' },
    ],
  },
  execute({ pattern, path = '.', include = '' }) {
    try {
      let cmd = `grep -rn '${pattern}' ${path} --color=never -I 2>/dev/null | head -60`
      if (include) cmd = `grep -rn '${pattern}' ${path} --include='${include}' --color=never -I 2>/dev/null | head -60`
      return ok(execSync(cmd, { encoding: 'utf-8', timeout: 15000 }).trim() || `No matches: ${pattern}`)
    } catch { return ok(`No matches: ${pattern}`) }
  }
}

// ─── Think Tool ───────────────────────────────────────────────────────
export const thinkTool: ToolDef = {
  name: 'think',
  description: 'Think through a problem step by step. Records your reasoning in the message stream without executing any action. Use for complex planning, analysis, or multi-step reasoning before taking action.',
  parameters: {
    type: 'object',
    properties: {
      thought: { type: 'string', description: 'Your reasoning, analysis, or plan' },
    },
    required: ['thought'],
    examples: [
      { thought: 'I need to refactor the auth module. Steps: 1) Read current code 2) Identify interfaces 3) Create new structure 4) Migrate tests' },
    ],
  },
  timeout: 5,
  execute({ thought }) {
    return ok(`💭 Thought:\n${thought}`)
  }
}

// ─── Test Runner Tool ─────────────────────────────────────────────────
export const testRunnerTool: ToolDef = {
  name: 'test_runner',
  description: 'Auto-detect project test framework and run tests. Supports npm test, pytest, go test, cargo test, and more.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', default: '.', description: 'Project root path' },
      filter: { type: 'string', default: '', description: 'Test filter pattern' },
      framework: { type: 'string', default: '', description: 'Force specific framework (npm|pytest|go|cargo)' },
    },
    examples: [
      {},
      { filter: 'auth' },
      { framework: 'pytest', path: './backend' },
    ],
  },
  timeout: 120,
  execute({ path = '.', filter = '', framework = '' }) {
    const cwd = resolve(path)
    let cmd = ''

    if (framework) {
      switch (framework) {
        case 'npm': cmd = filter ? `npm test -- --grep '${filter}'` : 'npm test'; break
        case 'pytest': cmd = filter ? `pytest -k '${filter}' -v` : 'pytest -v'; break
        case 'go': cmd = filter ? `go test ./... -run '${filter}' -v` : 'go test ./... -v'; break
        case 'cargo': cmd = filter ? `cargo test '${filter}'` : 'cargo test'; break
        default: return err(`Unknown framework: ${framework}. Supported: npm, pytest, go, cargo`)
      }
    } else {
      // Auto-detect
      const checks: [string, string][] = [
        ['package.json', filter ? `npm test -- --grep '${filter}'` : 'npm test'],
        ['pyproject.toml', filter ? `pytest -k '${filter}' -v` : 'pytest -v'],
        ['setup.py', filter ? `pytest -k '${filter}' -v` : 'pytest -v'],
        ['go.mod', filter ? `go test ./... -run '${filter}' -v` : 'go test ./... -v'],
        ['Cargo.toml', filter ? `cargo test '${filter}'` : 'cargo test'],
      ]

      let detected = false
      for (const [file, testCmd] of checks) {
        if (existsSync(join(cwd, file))) {
          cmd = testCmd
          detected = true
          break
        }
      }

      if (!detected) {
        return err('Cannot detect test framework. Provide framework param (npm|pytest|go|cargo) or ensure project config file exists.')
      }
    }

    try {
      const out = execSync(cmd, { cwd, timeout: 120_000, encoding: 'utf-8', maxBuffer: MAX })
      return ok(`🧪 Test output:\n${out.length > MAX ? out.slice(0, MAX) + '\n...' : out}`)
    } catch (ex: any) {
      return ok(`🧪 Tests (exit ${ex.status || 1}):\n${(ex.stdout || '').slice(0, MAX)}${ex.stderr ? `\n[stderr]\n${ex.stderr.slice(0, 2000)}` : ''}`)
    }
  }
}

// ─── Lazy Tools ────────────────────────────────────────────────────────
export const fetchTool: ToolDef = {
  name: 'fetch',
  description: 'Fetch URL and return text/JSON/HTML content. NOT for local files (use read_file).',
  parameters: {
    type: 'object',
    properties: { url: { type: 'string', description: 'URL to fetch' } },
    required: ['url'],
    examples: [
      { url: 'https://api.github.com/repos/owner/repo' },
    ],
  },
  async execute({ url }) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) })
      const ct = r.headers.get('content-type') || ''
      if (ct.includes('text') || ct.includes('json') || ct.includes('html')) { let t = await r.text(); return ok(t.length > MAX ? t.slice(0, MAX) + '\n...' : t) }
      return ok(`Binary: ${ct}`)
    } catch (ex: any) { return err(ex.message) }
  }
}

import { todoTool } from './todo.js'
import { webSearchTool } from './websearch.js'

// ─── LSP Tools ─────────────────────────────────────────────────────
import { lspComplete, lspDefinition, lspReferences, lspHover } from '../lsp/index.js'

export const lspCompleteTool: ToolDef = {
  name: 'lsp_complete',
  description: 'Get code completions at a specific position in a file. Uses LSP for intelligent suggestions.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to the source file' },
      line: { type: 'integer', description: 'Line number (0-indexed)' },
      character: { type: 'integer', description: 'Character position (0-indexed)' },
    },
    required: ['file_path', 'line', 'character'],
  },
  async execute({ file_path, line, character }) {
    try {
      const result = await lspComplete(file_path, line, character)
      if (result.items.length === 0) return ok('没有可用的补全建议。')
      const items = result.items.slice(0, 20).map(i => {
        let detail = i.label
        if (i.detail) detail += ` - ${i.detail}`
        return detail
      })
      return ok(`补全建议（${result.items.length} 个${result.isIncomplete ? ', 未完全' : ''}）:\n${items.join('\n')}`)
    } catch (e: any) {
      return err(`LSP 补全失败: ${e.message}`)
    }
  },
}

export const lspDefinitionTool: ToolDef = {
  name: 'lsp_definition',
  description: 'Find the definition of a symbol at a specific position. Jump to where it is defined.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to the source file' },
      line: { type: 'integer', description: 'Line number (0-indexed)' },
      character: { type: 'integer', description: 'Character position (0-indexed)' },
    },
    required: ['file_path', 'line', 'character'],
  },
  async execute({ file_path, line, character }) {
    try {
      const result = await lspDefinition(file_path, line, character)
      if (result.locations.length === 0) return ok('没有找到定义。')
      const locs = result.locations.map(l =>
        `${l.uri.replace('file://', '')}:${l.range.start.line + 1}:${l.range.start.character + 1}`
      )
      return ok(`定义位置:\n${locs.join('\n')}`)
    } catch (e: any) {
      return err(`LSP 查找定义失败: ${e.message}`)
    }
  },
}

export const lspReferencesTool: ToolDef = {
  name: 'lsp_references',
  description: 'Find all references to a symbol at a specific position across the codebase.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to the source file' },
      line: { type: 'integer', description: 'Line number (0-indexed)' },
      character: { type: 'integer', description: 'Character position (0-indexed)' },
    },
    required: ['file_path', 'line', 'character'],
  },
  async execute({ file_path, line, character }) {
    try {
      const result = await lspReferences(file_path, line, character)
      if (result.locations.length === 0) return ok('没有找到引用。')
      const locs = result.locations.map(l =>
        `${l.uri.replace('file://', '')}:${l.range.start.line + 1}:${l.range.start.character + 1}`
      )
      return ok(`引用位置（${result.locations.length} 个）:\n${locs.slice(0, 30).join('\n')}${locs.length > 30 ? `\n... 还有 ${locs.length - 30} 个` : ''}`)
    } catch (e: any) {
      return err(`LSP 查找引用失败: ${e.message}`)
    }
  },
}

export const lspHoverTool: ToolDef = {
  name: 'lsp_hover',
  description: 'Get hover information (type, documentation) for a symbol at a specific position.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to the source file' },
      line: { type: 'integer', description: 'Line number (0-indexed)' },
      character: { type: 'integer', description: 'Character position (0-indexed)' },
    },
    required: ['file_path', 'line', 'character'],
  },
  async execute({ file_path, line, character }) {
    try {
      const result = await lspHover(file_path, line, character)
      if (!result) return ok('没有悬停信息。')
      return ok(result.content)
    } catch (e: any) {
      return err(`LSP 悬停失败: ${e.message}`)
    }
  },
}

// ─── Agent Tool (Sub-agent) ────────────────────────────────────────────
import { runSubAgent } from '../agent/subagent.js'

export const agentTool: ToolDef = {
  name: 'agent',
  description: 'Launch a sub-agent to execute a task in an isolated context. Sub-agents have their own session and token budget.',
  parameters: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'Short description of the task' },
      prompt: { type: 'string', description: 'Full prompt for the sub-agent' },
      subagent_type: { type: 'string', enum: ['Explore', 'Plan', 'Verification', 'general-purpose'], default: 'general-purpose', description: 'Agent type determines available tools' },
      name: { type: 'string', description: 'Optional name for the sub-agent' },
      model: { type: 'string', description: 'Optional model override' },
    },
    required: ['description', 'prompt'],
    examples: [
      { description: 'Explore project structure', prompt: 'List all source files and their purposes', subagent_type: 'Explore' },
    ],
  },
  async execute(args: Record<string, any>) {
    const { description, prompt, subagent_type, name, model } = args

    const toolWhitelist: Record<string, string[]> = {
      'Explore': ['read_file', 'glob', 'grep', 'fetch', 'web_search'],
      'Plan': ['read_file', 'glob', 'grep', 'fetch', 'web_search', 'todo_write'],
      'Verification': ['read_file', 'glob', 'grep', 'bash'],
      'general-purpose': [],
    }

    const allowedTools = toolWhitelist[subagent_type] || []

    try {
      const config = (await import('../config/index.js')).loadConfig()
      const result = await runSubAgent({
        task: prompt,
        maxTurns: subagent_type === 'Explore' ? 15 : 10,
        allowedTools: allowedTools.length > 0 ? allowedTools : undefined,
        systemPromptSuffix: name ? `你是一个名为 "${name}" 的子代理。` : undefined,
      }, model ? { ...config, model } : config)

      const agentsDir = resolve(process.cwd(), '.edgecli-agents')
      mkdirSync(agentsDir, { recursive: true })
      const agentFile = resolve(agentsDir, `${name || 'agent'}-${Date.now()}.md`)
      writeFileSync(agentFile, `# Agent: ${description}\n\nType: ${subagent_type}\n\n## Result\n\n${result.content}\n\n## Error\n\n${result.error || 'none'}\n`)

      if (result.error) {
        return { content: `🤖 子代理完成（${subagent_type}）: ${description}\n错误: ${result.error}\n结果已保存到 ${agentFile}`, isError: true }
      }
      return { content: `🤖 子代理完成（${subagent_type}）: ${description}\n\n${result.content}`, isError: false }
    } catch (ex: any) {
      return { content: `子代理执行失败: ${ex.message}`, isError: true }
    }
  },
}

// ─── ToolSearch Tool ───────────────────────────────────────────────────
const ALL_TOOL_DEFS: ToolDef[] = [readFileTool, writeFileTool, editFileTool, patchFileTool, bashTool, globTool, grepTool, thinkTool, testRunnerTool, fetchTool, todoTool, webSearchTool, agentTool, lspCompleteTool, lspDefinitionTool, lspReferencesTool, lspHoverTool]

export const toolSearchTool: ToolDef = {
  name: 'tool_search',
  description: 'Search available tools by keyword. Use this to discover tools not in the core set.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Search keywords' } },
    required: ['query'],
  },
  timeout: 5,
  execute({ query }) {
    const q = query.toLowerCase()
    const matches = ALL_TOOL_DEFS.filter(t =>
      t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)
    )
    if (!matches.length) return ok(`没有找到匹配 "${query}" 的工具。`)
    return ok(matches.map(t => `- ${t.name}: ${t.description.split('\n')[0]}`).join('\n'))
  },
}

// ─── 注册表 ────────────────────────────────────────────────────────────
// 核心工具（始终注册）
export const CORE_TOOLS: ToolDef[] = [readFileTool, writeFileTool, editFileTool, patchFileTool, bashTool, globTool, grepTool]
// 延迟工具（按需加载）
export const LAZY_TOOLS: ToolDef[] = [thinkTool, testRunnerTool, fetchTool, todoTool, webSearchTool, agentTool, toolSearchTool, lspCompleteTool, lspDefinitionTool, lspReferencesTool, lspHoverTool]
// 全部工具
export const ALL_TOOLS: ToolDef[] = [...CORE_TOOLS, ...LAZY_TOOLS]

export function findTool(n: string) { return ALL_TOOLS.find(t => t.name === n) }

// 按活跃工具集转换格式（核心 + 已激活的延迟工具）
let activeLazyTools: Set<string> = new Set()

export function activateLazyTool(name: string) {
  activeLazyTools.add(name)
}

export function getActiveTools(): ToolDef[] {
  const active = [...CORE_TOOLS]
  for (const t of LAZY_TOOLS) {
    if (activeLazyTools.has(t.name)) active.push(t)
  }
  return active
}

export function toOpenAI(active?: ToolDef[]) {
  const tools = active || getActiveTools()
  return tools.map(t => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.parameters } }))
}
export function toAnthropic(active?: ToolDef[]) {
  const tools = active || getActiveTools()
  return tools.map(t => ({ name: t.name, description: t.description, input_schema: { type: 'object' as const, ...t.parameters } }))
}

// Alias for backward compatibility
export type Tool = ToolDef
