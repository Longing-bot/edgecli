// ─── Linter 系统（Aider Linter 风格）────────────────────────────────────
// 支持多语言 lint，包括：
//   - TypeScript/JavaScript: tsc + eslint
//   - Python: py_compile + flake8
//   - Go: go vet
//   - Rust: cargo check
//   - 通用：tree-sitter 基础语法检查（通过 grep_ast 风格启发式）
//
// 特性：
//   - 每语言可配置 lint 命令
//   - LintResult 带行号，可用于上下文展示
//   - 支持外部 lint 命令（用户自定义）
//   - 异步执行，超时控制

import { existsSync, readFileSync } from 'fs'
import { resolve, extname, dirname, basename, join } from 'path'
import { execSync } from 'child_process'

// ─── 类型定义 ──────────────────────────────────────────────────────────
export interface LintResult {
  text: string        // 错误文本
  lines: number[]     // 错误行号（0-indexed）
  hasErrors: boolean
}

export interface LintOutput {
  filePath: string
  result: LintResult | null  // null = 无需 lint 或不支持的语言
}

// ─── Linter 类（Aider 风格）─────────────────────────────────────────────
export class Linter {
  private root: string
  private customLinters: Map<string, string>  // lang → command
  private allLintCmd: string | null = null

  constructor(root: string = process.cwd()) {
    this.root = root
    this.customLinters = new Map()
  }

  /**
   * 设置自定义 lint 命令
   */
  setLinter(lang: string | null, cmd: string): void {
    if (lang) {
      this.customLinters.set(lang, cmd)
    } else {
      this.allLintCmd = cmd
    }
  }

  /**
   * 获取相对路径
   */
  getRelFname(fname: string): string {
    try {
      return resolve(fname).replace(this.root + '/', '')
    } catch {
      return fname
    }
  }

  /**
   * 主 lint 入口
   */
  lint(fname: string, cmd?: string): LintOutput | null {
    const absPath = resolve(fname)
    if (!existsSync(absPath)) return null

    const relFname = this.getRelFname(fname)
    let code: string
    try {
      code = readFileSync(absPath, 'utf-8')
    } catch {
      return null
    }

    const ext = extname(absPath).toLowerCase()
    const lang = extToLang(ext)

    // 确定 lint 命令
    let lintCmd: string | null | undefined = cmd
    if (!lintCmd) {
      lintCmd = this.allLintCmd || (lang ? this.customLinters.get(lang) : null)
    }

    // 执行 lint
    let result: LintResult | null = null

    if (lintCmd) {
      result = this.runExternalLint(lintCmd, relFname)
    } else if (lang) {
      // 内置 lint
      result = this.builtinLint(lang, absPath, relFname, code)
    }

    if (!result || (!result.hasErrors && !result.text)) {
      return { filePath: fname, result: null }
    }

    return { filePath: fname, result }
  }

  /**
   * 运行外部 lint 命令
   */
  private runExternalLint(cmd: string, relFname: string): LintResult | null {
    try {
      const fullCmd = `${cmd} "${relFname}"`
      const output = execSync(fullCmd, {
        cwd: this.root,
        encoding: 'utf-8',
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim()

      if (!output) return null

      const lineNumbers = extractLineNumbers(output, relFname)
      return { text: output, lines: lineNumbers, hasErrors: true }
    } catch (ex: any) {
      const output = (ex.stdout || ex.stderr || '').trim()
      if (!output) return null

      const lineNumbers = extractLineNumbers(output, relFname)
      return { text: output, lines: lineNumbers, hasErrors: true }
    }
  }

  /**
   * 内置 lint（Aider basic_lint 风格，但不依赖 tree-sitter）
   */
  private builtinLint(lang: string, absPath: string, relFname: string, code: string): LintResult | null {
    switch (lang) {
      case 'typescript':
      case 'javascript':
        return this.lintTS(absPath, relFname, code)
      case 'python':
        return this.lintPython(absPath, relFname, code)
      case 'go':
        return this.lintGo(absPath, relFname)
      case 'rust':
        return this.lintRust(absPath, relFname)
      default:
        return null
    }
  }

  /**
   * TypeScript/JavaScript lint
   */
  private lintTS(absPath: string, relFname: string, code: string): LintResult | null {
    const results: LintResult[] = []

    // 1. TypeScript 类型检查
    if (absPath.endsWith('.ts') || absPath.endsWith('.tsx')) {
      const tscResult = this.runTSC(absPath)
      if (tscResult) results.push(tscResult)
    }

    // 2. ESLint
    const eslintResult = this.runESLint(absPath, relFname)
    if (eslintResult) results.push(eslintResult)

    // 3. 基础语法检查（括号/引号匹配）
    const syntaxResult = this.basicSyntaxCheck(code, relFname)
    if (syntaxResult) results.push(syntaxResult)

    if (results.length === 0) return null

    return mergeLintResults(results)
  }

  private runTSC(absPath: string): LintResult | null {
    // 找到最近的 tsconfig.json
    let dir = dirname(absPath)
    while (dir !== '/' && !existsSync(join(dir, 'tsconfig.json'))) {
      dir = dirname(dir)
    }
    if (dir === '/') return null

    try {
      execSync(`npx tsc --noEmit --skipLibCheck "${absPath}"`, {
        cwd: dir,
        encoding: 'utf-8',
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      return null // 无错误
    } catch (ex: any) {
      const output = ((ex.stderr || '') + (ex.stdout || '')).trim()
      if (!output) return null

      const lines = extractTSCLineNumbers(output)
      return { text: `## tsc\n${output.split('\n').slice(0, 8).join('\n')}`, lines, hasErrors: true }
    }
  }

  private runESLint(absPath: string, relFname: string): LintResult | null {
    const dir = dirname(absPath)
    const eslintPath = join(dir, 'node_modules', '.bin', 'eslint')
    if (!existsSync(eslintPath)) return null

    try {
      execSync(`npx eslint "${absPath}" --format compact --no-error-on-unmatched-pattern 2>/dev/null`, {
        cwd: dir,
        encoding: 'utf-8',
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      return null
    } catch (ex: any) {
      const output = (ex.stdout || '').trim()
      if (!output || output.includes('not found') || output.includes('Cannot find')) return null

      const lineNumbers = extractLineNumbers(output, relFname)
      return { text: `## eslint\n${output.split('\n').slice(0, 8).join('\n')}`, lines: lineNumbers, hasErrors: true }
    }
  }

  /**
   * Python lint（Aider py_lint 风格）
   */
  private lintPython(absPath: string, relFname: string, code: string): LintResult | null {
    const results: LintResult[] = []

    // 1. compile 检查
    const compileResult = this.pythonCompileCheck(absPath, code)
    if (compileResult) results.push(compileResult)

    // 2. flake8
    const flakeResult = this.runFlake8(relFname)
    if (flakeResult) results.push(flakeResult)

    // 3. 基础语法检查
    const syntaxResult = this.basicSyntaxCheck(code, relFname)
    if (syntaxResult) results.push(syntaxResult)

    if (results.length === 0) return null
    return mergeLintResults(results)
  }

  private pythonCompileCheck(absPath: string, code: string): LintResult | null {
    try {
      execSync(`python3 -m py_compile "${absPath}"`, {
        encoding: 'utf-8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      return null
    } catch (ex: any) {
      const errOutput = (ex.stderr || ex.stdout || '').trim()
      if (!errOutput) return null

      const lineNumbers: number[] = []
      const lineMatch = errOutput.match(/line (\d+)/)
      if (lineMatch) lineNumbers.push(parseInt(lineMatch[1]) - 1)

      return {
        text: `## py_compile\n${errOutput.split('\n').slice(0, 5).join('\n')}`,
        lines: lineNumbers,
        hasErrors: true,
      }
    }
  }

  private runFlake8(relFname: string): LintResult | null {
    try {
      execSync(`python3 -m flake8 --select=E9,F821,F823,F831,F406,F407,F701,F702,F704,F706 --show-source --isolated "${relFname}"`, {
        cwd: this.root,
        encoding: 'utf-8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      return null
    } catch (ex: any) {
      const output = ((ex.stdout || '') + (ex.stderr || '')).trim()
      if (!output) return null

      const lineNumbers = extractLineNumbers(output, relFname)
      return {
        text: `## flake8\n${output.split('\n').slice(0, 8).join('\n')}`,
        lines: lineNumbers,
        hasErrors: true,
      }
    }
  }

  /**
   * Go lint
   */
  private lintGo(absPath: string, relFname: string): LintResult | null {
    try {
      execSync(`go vet "${absPath}"`, {
        encoding: 'utf-8',
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      return null
    } catch (ex: any) {
      const output = (ex.stderr || '').trim()
      if (!output) return null

      const lineNumbers = extractLineNumbers(output, relFname)
      return { text: `## go vet\n${output.split('\n').slice(0, 5).join('\n')}`, lines: lineNumbers, hasErrors: true }
    }
  }

  /**
   * Rust lint
   */
  private lintRust(absPath: string, relFname: string): LintResult | null {
    // 找 Cargo.toml
    let dir = dirname(absPath)
    while (dir !== '/' && !existsSync(join(dir, 'Cargo.toml'))) {
      dir = dirname(dir)
    }
    if (dir === '/') return null

    try {
      execSync(`cargo check --message-format=short 2>&1`, {
        cwd: dir,
        encoding: 'utf-8',
        timeout: 60000,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      return null
    } catch (ex: any) {
      const output = (ex.stdout || ex.stderr || '').trim()
      if (!output) return null

      // 只保留与当前文件相关的错误
      const relInProject = absPath.replace(dir + '/', '')
      const relevantLines = output.split('\n')
        .filter((l: string) => l.includes(relInProject) || l.includes(basename(absPath)))
        .slice(0, 10)
        .join('\n')

      if (!relevantLines) return null

      const lineNumbers = extractLineNumbers(relevantLines, relFname)
      return { text: `## cargo check\n${relevantLines}`, lines: lineNumbers, hasErrors: true }
    }
  }

  /**
   * 基础语法检查（启发式，不依赖编译器）
   */
  private basicSyntaxCheck(code: string, fname: string): LintResult | null {
    const lines = code.split('\n')
    const errors: number[] = []
    const errorTexts: string[] = []

    // 括号匹配检查
    let paren = 0, bracket = 0, brace = 0
    let inString: string | null = null
    let inComment = false

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      for (let j = 0; j < line.length; j++) {
        const ch = line[j]
        const prev = j > 0 ? line[j - 1] : ''

        // 字符串处理
        if (inString) {
          if (ch === inString && prev !== '\\') inString = null
          continue
        }
        if (ch === '"' || ch === "'" || ch === '`') {
          inString = ch
          continue
        }

        // 注释处理
        if (ch === '/' && line[j + 1] === '/') break
        if (ch === '#' && fname.endsWith('.py')) break

        // 括号计数
        if (ch === '(') paren++
        else if (ch === ')') paren--
        else if (ch === '[') bracket++
        else if (ch === ']') bracket--
        else if (ch === '{') brace++
        else if (ch === '}') brace--

        // 提前发现不匹配
        if (paren < 0 || bracket < 0 || brace < 0) {
          errors.push(i)
          errorTexts.push(`${fname}:${i + 1}: 括号不匹配`)
          // 重置以继续检查
          if (paren < 0) paren = 0
          if (bracket < 0) bracket = 0
          if (brace < 0) brace = 0
        }
      }
    }

    // 文件末尾括号不匹配
    if (paren !== 0) {
      errors.push(lines.length - 1)
      errorTexts.push(`${fname}: EOF: 圆括号不匹配 (差值: ${paren})`)
    }
    if (bracket !== 0) {
      errors.push(lines.length - 1)
      errorTexts.push(`${fname}: EOF: 方括号不匹配 (差值: ${bracket})`)
    }
    if (brace !== 0) {
      errors.push(lines.length - 1)
      errorTexts.push(`${fname}: EOF: 花括号不匹配 (差值: ${brace})`)
    }

    if (errors.length === 0) return null

    return {
      text: `## 基础语法检查\n${errorTexts.join('\n')}`,
      lines: [...new Set(errors)],
      hasErrors: true,
    }
  }

  /**
   * 格式化 lint 结果为用户友好输出（Aider tree_context 风格）
   */
  formatLintOutput(output: LintOutput): string {
    if (!output.result) return ''

    const { text, lines, hasErrors } = output.result
    if (!hasErrors) return ''

    let result = `# Fix any errors below, if possible.\n\n${text}\n`

    // 显示相关代码行（类似 Aider 的 tree_context）
    if (lines.length > 0) {
      try {
        const absPath = resolve(output.filePath)
        const code = readFileSync(absPath, 'utf-8')
        const codeLines = code.split('\n')

        result += `\n## See relevant lines:\n\n`
        const uniqueLines = [...new Set(lines)].sort((a, b) => a - b)

        for (const lineNum of uniqueLines.slice(0, 10)) {
          const display = lineNum + 1
          const codeLine = codeLines[lineNum] || ''
          result += `${display.toString().padStart(4)} → ${codeLine}\n`
        }

        if (uniqueLines.length > 10) {
          result += `  ... (${uniqueLines.length - 10} more)\n`
        }
      } catch { /* 忽略读取失败 */ }
    }

    return result
  }
}

// ─── 辅助函数 ──────────────────────────────────────────────────────────
function extToLang(ext: string): string | null {
  const map: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.py': 'python',
    '.go': 'go',
    '.rs': 'rust',
  }
  return map[ext] || null
}

function extractLineNumbers(text: string, fname: string): number[] {
  const numbers: number[] = []
  // 匹配 filename:line 或 filename:line:col
  const escaped = fname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(`${escaped}:(\\d+)`, 'g')
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    numbers.push(parseInt(match[1]) - 1) // 转为 0-indexed
  }
  return numbers
}

function extractTSCLineNumbers(text: string): number[] {
  const numbers: number[] = []
  const regex = /\((\d+),\d+\):/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    numbers.push(parseInt(match[1]) - 1)
  }
  return numbers
}

function mergeLintResults(results: LintResult[]): LintResult {
  const allLines = new Set<number>()
  const texts: string[] = []

  for (const r of results) {
    r.lines.forEach(l => allLines.add(l))
    if (r.text) texts.push(r.text)
  }

  return {
    text: texts.join('\n\n'),
    lines: [...allLines].sort((a, b) => a - b),
    hasErrors: results.some(r => r.hasErrors),
  }
}

// ─── 便捷函数 ──────────────────────────────────────────────────────────
const defaultLinter = new Linter()

/**
 * 快速 lint 单个文件
 */
export function lintFile(filePath: string, root?: string): LintOutput | null {
  if (root) {
    const linter = new Linter(root)
    return linter.lint(filePath)
  }
  return defaultLinter.lint(filePath)
}

/**
 * 快速格式化 lint 结果
 */
export function formatLint(filePath: string, root?: string): string {
  const output = lintFile(filePath, root)
  if (!output || !output.result) return ''

  const linter = root ? new Linter(root) : defaultLinter
  return linter.formatLintOutput(output)
}
