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
- **7 tools**: read_file, write_file, edit_file, bash, glob, grep, fetch
- **Safety**: Banned commands, non-readonly approval flow
- **TUI**: React + Ink terminal interface (interactive mode)
- **Print mode**: `--print` for scripting and CI/CD
- **Session history**: Per-project conversation persistence

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

## Environment

```bash
export OPENROUTER_API_KEY=sk-...   # For OpenRouter
export OPENAI_API_KEY=sk-...       # For OpenAI
export ANTHROPIC_API_KEY=sk-...    # For Anthropic
```

## Inspired By

- **Claude Code**: Architecture, prompt design, tool system, anti-hallucination patterns
- **OpenCode**: Provider-specific prompts, environment info injection
- **OpenAI Codex**: Safety, session management, execution policy

## License

MIT
