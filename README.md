# edgecli

AI coding assistant for the terminal. Architecture from Claude Code. Model-agnostic by design.

## Architecture (6 layers)

```
src/
├── ui/         ← React + Ink terminal UI
├── repl/       ← Read-Eval-Print Loop
├── query/      ← LLM call + tool execution loop
├── tools/      ← Tool definitions & execution
├── api/        ← API calls (OpenAI / Anthropic / OpenRouter)
└── config/     ← Configuration, state, session persistence
```

## Features

- **CC-inspired architecture**: Dynamic prompt assembly, tool-gated execution loop
- **Model-agnostic**: Works with OpenAI, Anthropic, OpenRouter, any OpenAI-compatible API
- **12+ tools**: read_file, write_file, edit_file, patch_file, bash, glob, grep, fetch, think, test_runner, agent, web_search, todo, LSP tools
- **Project-aware**: Auto-detects Node.js/Python/Go/Rust projects, injects relevant hints
- **Safety**: Banned commands, non-readonly approval flow, configurable permissions
- **TUI**: React + Ink terminal interface (interactive mode)
- **Print mode**: `--print` for scripting and CI/CD
- **Session history**: SQLite-backed per-project conversation persistence
- **Command autocomplete**: Tab completion and fuzzy matching for commands
- **Session search & export**: Search, tag, export, and clean up old sessions
- **Config validation**: Detect invalid config, suggest fixes, version migration
- **Project-level config**: `.edgeclirc` overrides global `~/.edgecli/config.json`

## Tools

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents with line numbers, offset/limit support |
| `write_file` | Create new file or complete rewrite |
| `edit_file` | Replace exact text match in file |
| `patch_file` | Precise line-range replacement (1-indexed) |
| `bash` | Execute shell command (auto-blocks dangerous commands) |
| `glob` | Find files by glob pattern |
| `grep` | Search file contents with regex |
| `fetch` | Fetch URL content |
| `think` | Record reasoning without executing action |
| `test_runner` | Auto-detect test framework and run tests |
| `agent` | Launch sub-agent in isolated context |
| `web_search` | Search the web |
| `todo` | Todo list management |
| `lsp_*` | Code completions, definitions, references, hover |

## Install

```bash
npm install -g .
# or
npx tsx src/index.tsx "your prompt"
```

## Usage

```bash
# Interactive TUI
edgecli

# One-shot
edgecli "explain this codebase"

# Print mode (for scripts)
edgecli --print "list all Python files"

# Specific model
edgecli -m "anthropic/claude-sonnet-4" "refactor auth module"

# Show config
edgecli --config
```

## Commands

| Command | Description |
|---------|-------------|
| `/help` | Show help |
| `/clear` | Clear conversation |
| `/compact` | Compress context |
| `/history` | Message stats |
| `/resume [id]` | Resume session |
| `/sessions` | List sessions |
| `/search <kw>` | Search sessions |
| `/export <id>` | Export session to Markdown |
| `/tag <id> <tags>` | Tag a session |
| `/cleanup` | Clean old sessions (keep 50) |
| `/model <name>` | Switch model |
| `/config` | Show config |
| `/policy <mode>` | Switch permission mode |
| `/approval <mode>` | Switch approval mode |
| `/init` | Generate default config |
| `/diff` | Show file changes |
| `/revert <file>` | Revert file changes |
| `/context` | Context usage info |
| `/usage` | Token usage & cost |
| `/skills` | List loaded skills |
| `/mcp` | List MCP servers |
| `/doctor` | Health check |
| `/dream` | Consolidate memory |
| `/quit` | Exit |

## Configuration

### Global config (`~/.edgecli/config.json`)

```json
{
  "version": 2,
  "apiKey": "sk-...",
  "baseUrl": "https://api.openai.com/v1",
  "model": "gpt-4o",
  "maxTokens": 8192,
  "provider": "openai",
  "autoApprove": false
}
```

### Project config (`.edgeclirc`)

Place a `.edgeclirc` in your project root to override global settings:

```json
{
  "model": "claude-sonnet-4-20250514",
  "maxTokens": 16384
}
```

### Environment variables

```bash
export OPENROUTER_API_KEY=sk-...   # For OpenRouter
export OPENAI_API_KEY=sk-...       # For OpenAI
export ANTHROPIC_API_KEY=sk-...    # For Anthropic
```

## Project Detection

edgecli auto-detects project type and injects relevant hints:

| Files | Type | Package Manager |
|-------|------|----------------|
| `package.json` | Node.js | npm/pnpm/yarn/bun |
| `pyproject.toml` / `setup.py` | Python | pip/poetry/uv |
| `go.mod` | Go | go mod |
| `Cargo.toml` | Rust | cargo |
| `build.gradle` | Java/Kotlin | gradle |
| `pom.xml` | Java | maven |
| `Gemfile` | Ruby | bundler |
| `CMakeLists.txt` | C/C++ | cmake |

## Inspired By

- **Claude Code**: Architecture, prompt design, tool system, anti-hallucination patterns
- **OpenCode**: Provider-specific prompts, environment info injection
- **OpenAI Codex**: Safety, session management, execution policy

## License

MIT
