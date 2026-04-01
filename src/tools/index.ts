// ─── Layer 4: Tools ───────────────────────────────────────────────────────
// CC-inspired: clear constraints per tool, banned commands, safety checks

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'fs'
import { resolve, dirname, basename } from 'path'
import { execSync } from 'child_process'

const MAX = 12000
export interface ToolResult { content: string; isError: boolean }
export interface ToolDef { name: string; description: string; parameters: Record<string, unknown>; execute: (args: Record<string, any>) => ToolResult | Promise<ToolResult> }

function ok(s: string): ToolResult { return { content: s, isError: false } }
function err(s: string): ToolResult { return { content: s, isError: true } }

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

// ─── Tools ─────────────────────────────────────────────────────────────
export const readFileTool: ToolDef = {
  name: 'read_file',
  description: 'Read file contents with line numbers. Use offset/limit for large files. DO NOT use bash cat for reading files.',
  parameters: { type: 'object', properties: { file_path: { type: 'string', description: 'Path to file' }, offset: { type: 'integer', default: 0 }, limit: { type: 'integer', default: 200 } }, required: ['file_path'] },
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
  parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] },
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
  description: `Edit file by replacing exact old_string with new_string. For MODIFYING existing files.

OpenCode 风格注意事项：
- 包含足够上下文确保唯一匹配
- 如果找到多处匹配，需要更多上下文
- 缩进必须完全一致
- 先读取文件再编辑（Read before Edit）`,
  parameters: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['file_path', 'old_string', 'new_string'] },
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

export const bashTool: ToolDef = {
  name: 'bash',
  description: `Execute shell command. Dangerous commands blocked.

OpenCode 风格注意事项：
- 文件操作请用专用工具（read_file/write_file/edit_file/glob/grep）
- 不要用 cat/head/tail 读文件（用 read_file）
- 不要用 find 搜索（用 glob）
- 不要用 grep 搜索内容（用 grep 工具）
- 支持 workdir 参数切换目录`,
  parameters: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'integer', default: 30 } }, required: ['command'] },
  execute({ command, timeout = 30 }) {
    for (const b of BANNED) if (command.includes(b)) return err(`🚫 Blocked: '${b}'`)
    // OpenCode 风格：检测文件操作命令，建议用专用工具
    const cmdName = command.trim().split(/\s+/)[0]
    if (FILE_OPS.has(cmdName)) {
      return ok(`⚠️ 建议使用专用工具代替 bash ${cmdName}：
- 读文件: read_file
- 写文件: write_file
- 编辑: edit_file
- 搜索文件: glob
- 搜索内容: grep

（命令仍可执行，但专用工具更安全、更精确）`)
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
  description: 'Find files by glob pattern. NOT for content search (use grep). NOT for reading files (use read_file).',
  parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
  execute({ pattern }) {
    try { return ok(execSync(`find . -name '${pattern}' -not -path './.git/*' -not -path './node_modules/*' 2>/dev/null | head -100`, { encoding: 'utf-8', timeout: 10000 }).trim() || `No matches: ${pattern}`) }
    catch { return ok(`No matches: ${pattern}`) }
  }
}

export const grepTool: ToolDef = {
  name: 'grep',
  description: 'Search file contents with regex. Returns file:line format. NOT for finding files by name (use glob).',
  parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', default: '.' }, include: { type: 'string', default: '' } }, required: ['pattern'] },
  execute({ pattern, path = '.', include = '' }) {
    try {
      let cmd = `grep -rn '${pattern}' ${path} --color=never -I 2>/dev/null | head -60`
      if (include) cmd = `grep -rn '${pattern}' ${path} --include='${include}' --color=never -I 2>/dev/null | head -60`
      return ok(execSync(cmd, { encoding: 'utf-8', timeout: 15000 }).trim() || `No matches: ${pattern}`)
    } catch { return ok(`No matches: ${pattern}`) }
  }
}

export const fetchTool: ToolDef = {
  name: 'fetch',
  description: 'Fetch URL and return text content. NOT for local files (use read_file).',
  parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  async execute({ url }) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) })
      const ct = r.headers.get('content-type') || ''
      if (ct.includes('text') || ct.includes('json') || ct.includes('html')) { let t = await r.text(); return ok(t.length > MAX ? t.slice(0, MAX) + '\n...' : t) }
      return ok(`Binary: ${ct}`)
    } catch (ex: any) { return err(ex.message) }
  }
}

// ─── 新增工具（CC 风格）────────────────────────────────────────────────
import { todoTool } from './todo.js'
import { webSearchTool } from './websearch.js'

export const ALL_TOOLS = [readFileTool, writeFileTool, editFileTool, bashTool, globTool, grepTool, fetchTool, todoTool, webSearchTool]
export function findTool(n: string) { return ALL_TOOLS.find(t => t.name === n) }
export function toOpenAI() { return ALL_TOOLS.map(t => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.parameters } })) }
export function toAnthropic() { return ALL_TOOLS.map(t => ({ name: t.name, description: t.description, input_schema: { type: 'object' as const, ...t.parameters } })) }

// Alias for backward compatibility
export type Tool = ToolDef
