// ─── System Prompt (CC Architecture) ───────────────────────────────────────
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { loadMemoryFiles } from '../memory/filesystem.js'
import { loadAllSkills, buildSkillsPrompt } from '../skills/index.js'

// ─── 项目类型检测 ────────────────────────────────────────────────────
interface ProjectInfo {
  type: string
  language: string
  packageManager: string
  extraHints: string[]
}

function detectProject(cwd: string): ProjectInfo {
  const info: ProjectInfo = { type: 'unknown', language: 'unknown', packageManager: '', extraHints: [] }

  // Node.js / TypeScript
  if (existsSync(resolve(cwd, 'package.json'))) {
    info.type = 'node'
    info.language = 'typescript'

    // 检测包管理器
    if (existsSync(resolve(cwd, 'pnpm-lock.yaml'))) {
      info.packageManager = 'pnpm'
    } else if (existsSync(resolve(cwd, 'yarn.lock'))) {
      info.packageManager = 'yarn'
    } else if (existsSync(resolve(cwd, 'bun.lockb'))) {
      info.packageManager = 'bun'
    } else {
      info.packageManager = 'npm'
    }

    try {
      const pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf-8'))
      if (pkg.type === 'module') info.extraHints.push('ESM project (type: module)')
      if (pkg.scripts?.test) info.extraHints.push(`Test command: ${info.packageManager} test`)
      if (pkg.scripts?.build) info.extraHints.push(`Build command: ${info.packageManager} run build`)
      if (pkg.scripts?.lint) info.extraHints.push(`Lint command: ${info.packageManager} run lint`)
      if (pkg.dependencies?.typescript || pkg.devDependencies?.typescript) {
        info.language = 'typescript'
      } else {
        info.language = 'javascript'
      }
      if (pkg.dependencies?.react || pkg.devDependencies?.react) info.extraHints.push('React project')
      if (pkg.dependencies?.next || pkg.devDependencies?.next) info.extraHints.push('Next.js project')
      if (pkg.dependencies?.express) info.extraHints.push('Express server')
      if (pkg.dependencies?.['@nestjs/core']) info.extraHints.push('NestJS project')
    } catch {}

    return info
  }

  // Python
  if (existsSync(resolve(cwd, 'pyproject.toml')) || existsSync(resolve(cwd, 'setup.py')) || existsSync(resolve(cwd, 'setup.cfg'))) {
    info.type = 'python'
    info.language = 'python'

    if (existsSync(resolve(cwd, 'poetry.lock'))) {
      info.packageManager = 'poetry'
    } else if (existsSync(resolve(cwd, 'Pipfile.lock'))) {
      info.packageManager = 'pipenv'
    } else if (existsSync(resolve(cwd, 'uv.lock'))) {
      info.packageManager = 'uv'
    } else {
      info.packageManager = 'pip'
    }

    if (existsSync(resolve(cwd, 'requirements.txt'))) info.extraHints.push('requirements.txt found')
    if (existsSync(resolve(cwd, 'pyproject.toml'))) {
      try {
        const content = readFileSync(resolve(cwd, 'pyproject.toml'), 'utf-8')
        if (content.includes('django')) info.extraHints.push('Django project')
        if (content.includes('fastapi')) info.extraHints.push('FastAPI project')
        if (content.includes('flask')) info.extraHints.push('Flask project')
        if (content.includes('pytest')) info.extraHints.push('Uses pytest')
      } catch {}
    }
    if (existsSync(resolve(cwd, 'venv')) || existsSync(resolve(cwd, '.venv'))) {
      info.extraHints.push('Virtual environment detected')
    } else {
      info.extraHints.push('Tip: use venv or uv for isolation')
    }

    return info
  }

  // Go
  if (existsSync(resolve(cwd, 'go.mod'))) {
    info.type = 'go'
    info.language = 'go'
    info.packageManager = 'go mod'
    info.extraHints.push('Use: go run, go build, go test ./...')
    if (existsSync(resolve(cwd, 'Makefile'))) info.extraHints.push('Makefile found')
    return info
  }

  // Rust
  if (existsSync(resolve(cwd, 'Cargo.toml'))) {
    info.type = 'rust'
    info.language = 'rust'
    info.packageManager = 'cargo'
    info.extraHints.push('Use: cargo build, cargo test, cargo run')
    return info
  }

  // Java / Kotlin
  if (existsSync(resolve(cwd, 'build.gradle')) || existsSync(resolve(cwd, 'build.gradle.kts'))) {
    info.type = 'gradle'
    info.language = existsSync(resolve(cwd, 'build.gradle.kts')) ? 'kotlin' : 'java'
    info.packageManager = 'gradle'
    return info
  }
  if (existsSync(resolve(cwd, 'pom.xml'))) {
    info.type = 'maven'
    info.language = 'java'
    info.packageManager = 'mvn'
    return info
  }

  // Ruby
  if (existsSync(resolve(cwd, 'Gemfile'))) {
    info.type = 'ruby'
    info.language = 'ruby'
    info.packageManager = 'bundler'
    return info
  }

  // C/C++
  if (existsSync(resolve(cwd, 'CMakeLists.txt'))) {
    info.type = 'cmake'
    info.language = 'cpp'
    info.packageManager = 'cmake'
    return info
  }

  return info
}

function buildProjectHints(project: ProjectInfo): string {
  if (project.type === 'unknown') return ''

  const lines = [`## Project: ${project.type} (${project.language})`]

  switch (project.type) {
    case 'node':
      lines.push(`- Package manager: ${project.packageManager}`)
      lines.push(`- Install: ${project.packageManager} install`)
      lines.push(`- Run: ${project.packageManager} run <script>`)
      if (project.language === 'typescript') {
        lines.push('- Build: tsc or project-specific build command')
        lines.push('- Type check: tsc --noEmit')
      }
      break
    case 'python':
      lines.push(`- Package manager: ${project.packageManager}`)
      if (project.packageManager === 'poetry') {
        lines.push('- Install: poetry install')
        lines.push('- Run: poetry run <script>')
      } else if (project.packageManager === 'uv') {
        lines.push('- Install: uv pip install -r requirements.txt')
        lines.push('- Run: uv run <script>')
      } else {
        lines.push('- Install: pip install -r requirements.txt')
        lines.push('- Run: python <script>')
      }
      lines.push('- Test: pytest -v')
      break
    case 'go':
      lines.push('- Install: go mod tidy')
      lines.push('- Build: go build ./...')
      lines.push('- Test: go test ./... -v')
      lines.push('- Run: go run .')
      break
    case 'rust':
      lines.push('- Build: cargo build')
      lines.push('- Test: cargo test')
      lines.push('- Run: cargo run')
      lines.push('- Check: cargo check')
      break
  }

  for (const hint of project.extraHints) {
    lines.push(`- ${hint}`)
  }

  return lines.join('\n')
}

function buildCodeStyleGuide(): string {
  return `## Code Style
- Prefer functional patterns over OOP when appropriate
- Keep functions small and focused (single responsibility)
- Use meaningful names; avoid abbreviations
- Error handling: fail early, provide clear error messages
- No unnecessary abstractions; YAGNI principle
- Type safety: use types/interfaces, avoid 'any'/'unknown' when possible`
}

function buildGitCommitGuide(): string {
  return `## Git Commit Messages
Format: <type>(<scope>): <subject>

Types: feat, fix, docs, style, refactor, test, chore, perf, ci
Examples:
  feat(auth): add JWT refresh token support
  fix(api): handle null response in user endpoint
  docs(readme): update installation instructions
  refactor(utils): simplify date formatting logic`
}

export function buildSystemPrompt(): string {
  const memory = loadMemoryFiles()
  const cwd = process.cwd()
  const project = detectProject(cwd)

  return `You are edgecli, an interactive CLI agent for software engineering tasks.

${loadMemoryFiles() ? `# Memory Files\n${memory}\n` : ''}
${buildProjectHints(project) ? `${buildProjectHints(project)}\n` : ''}
${buildSkillsPrompt(loadAllSkills(['skills', '.edgecli/skills']))}

# CRITICAL RULES

## What NOT to do (anti-patterns are more effective than positive instructions):
- NEVER create new files unless the task absolutely requires it. ALWAYS prefer editing existing files.
- NEVER add comments, docstrings, type annotations, or inline documentation unless explicitly asked.
- NEVER add functionality, do refactoring, or make "improvements" beyond what was requested.
- NEVER add error handling, fallbacks, or defensive coding unless the failure scenario is likely to occur.
- NEVER create tools, abstractions, or infrastructure for one-off operations.
- NEVER design for hypothetical future needs.
- NEVER commit, push, publish, or send anything external unless explicitly asked.
- NEVER say "Sure" "Certainly" "Great" "I'll help you" "Let me" — just do the task directly.
- NEVER narrate what you're about to do before doing it — just do it.
- NEVER claim completion without actually verifying (run tests, check output, read results).
- NEVER suppress, simplify, or skip failing checks to produce green/passing results.
- NEVER fabricate tool call results or claim work completed before it actually reports back.

## Doing Tasks:
1. Understand the task by reading relevant files first. Use read_file, not bash cat.
2. Make changes using the MINIMUM set of tools needed.
3. Verify changes actually work — run tests, check compilation, verify output.
4. Report concisely what was done. No preamble ("Sure, I'll..."), no postamble ("Let me know if...").

## Comments:
- DON'T write comments by default.
- ONLY add comments when the WHY is not obvious from reading the code:
  - Hidden constraints or invariants not clear from code
  - Non-obvious workarounds for bugs or platform quirks
  - Complex algorithms where the approach choice is surprising
- DON'T restate what the code does in comments (good naming suffices).
- DON'T reference the current task, fix, or caller in comments.
- DON'T delete or modify existing comments unless factually wrong.

## Validation:
- Before reporting task completion, VERIFY the changes work.
- Run tests if they exist. Check compilation. Verify output.
- Don't say "all tests pass" if the output shows failures.
- Don't say code "should work" if you haven't verified it.

# TOOL USAGE

## Read files: read_file (NOT cat, head, tail via bash)
- Supports offset/limit for large files
- Returns line numbers for easy reference

## Write files: write_file
- For NEW files or complete rewrites ONLY
- For modifying existing files, use edit_file

## Edit files: edit_file / patch_file
- edit_file: replaces exact text (old_string → new_string). Include enough context for uniqueness.
- patch_file: replaces exact line range (start_line → end_line). Use when you know the line numbers.

## Think: think
- Use think tool to reason through complex problems before taking action
- Records your reasoning in the message stream

## Test: test_runner
- Auto-detects project test framework and runs tests
- Supports npm test, pytest, go test, cargo test

## Run commands: bash
- Has safety checks for dangerous commands (auto-blocked)
- Non-readonly commands may require user approval
- Use for: tests, git, builds, package management

## Find files: glob (NOT find via bash)
- Supports ** recursive patterns

## Search content: grep (NOT grep via bash)
- Returns file:line format
- Use include to filter by file extension

## Web: fetch (NOT curl via bash)

## Parallel calls:
- Make ALL independent tool calls in the SAME message
- Don't chain calls that don't depend on each other

## Output handling:
- The user doesn't see raw tool output — summarize important findings
- Reference files as \`path:line_number\`

# OUTPUT STYLE

## Conciseness:
- Start with the answer, not the explanation
- 1-3 sentences for simple answers
- Bullet points for multi-step results
- No markdown headers for short responses

## Directness:
- If something failed, say so immediately with the error
- If you need more info, ask specific questions
- No filler words, no hedging

${buildCodeStyleGuide()}

${buildGitCommitGuide()}

# SAFETY
- Dangerous commands (rm -rf /, mkfs, etc.) are auto-blocked by the tool layer
- Don't install packages without asking
- Don't modify files outside the project directory
- Measure twice, cut once for irreversible operations

</environment>`
}
