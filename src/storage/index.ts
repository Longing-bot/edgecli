// ─── SQLite 持久化层 ─────────────────────────────────────────────────────
// 使用 better-sqlite3 存储会话、消息和文件变更记录
// Fallback 到 JSON 文件（兼容旧版本）

import Database from 'better-sqlite3'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { createHash } from 'crypto'
import type { Message, TokenUsage } from '../config/index.js'

const DIR = join(homedir(), '.edgecli')
const DB_PATH = join(DIR, 'sessions.db')

// ─── 数据库初始化 ──────────────────────────────────────────────────
let db: Database.Database | null = null

function getDb(): Database.Database | null {
  if (db) return db
  try {
    mkdirSync(DIR, { recursive: true })
    db = new Database(DB_PATH)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    initTables()
    return db
  } catch (e) {
    console.error('SQLite 初始化失败，使用 JSON fallback:', (e as Error).message)
    return null
  }
}

function initTables() {
  if (!db) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      model TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      workspace TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      tool_calls TEXT,
      usage TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS file_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      before_hash TEXT,
      after_hash TEXT,
      diff TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_file_changes_session ON file_changes(session_id);
  `)
}

// ─── Session CRUD ────────────────────────────────────────────────────
export function createSession(opts: { model?: string; title?: string; workspace?: string } = {}): string {
  const database = getDb()
  if (!database) return generateSessionId(opts.workspace)

  const id = generateSessionId(opts.workspace)
  database.prepare(
    'INSERT INTO sessions (id, model, title, workspace) VALUES (?, ?, ?, ?)'
  ).run(id, opts.model || '', opts.title || '', opts.workspace || process.cwd())
  return id
}

export function getSession(sessionId: string): SessionRecord | null {
  const database = getDb()
  if (!database) return null

  return database.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as SessionRecord | null
}

export function listSessions(limit = 50): SessionRecord[] {
  const database = getDb()
  if (!database) return []

  return database.prepare(
    'SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?'
  ).all(limit) as SessionRecord[]
}

export function updateSession(sessionId: string, updates: Partial<Pick<SessionRecord, 'model' | 'title'>>) {
  const database = getDb()
  if (!database) return

  const sets: string[] = []
  const vals: any[] = []
  if (updates.model !== undefined) { sets.push('model = ?'); vals.push(updates.model) }
  if (updates.title !== undefined) { sets.push('title = ?'); vals.push(updates.title) }
  sets.push("updated_at = datetime('now')")
  vals.push(sessionId)

  database.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
}

export function deleteSession(sessionId: string) {
  const database = getDb()
  if (!database) return
  database.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
}

// ─── Message CRUD ───────────────────────────────────────────────────
export function addMessage(sessionId: string, msg: Message): number | null {
  const database = getDb()
  if (!database) return null

  const result = database.prepare(
    'INSERT INTO messages (session_id, role, content, tool_calls, usage) VALUES (?, ?, ?, ?, ?)'
  ).run(
    sessionId,
    msg.role,
    msg.content,
    msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
    msg.usage ? JSON.stringify(msg.usage) : null
  )

  // 更新 session 的 updated_at
  updateSession(sessionId, {})

  return result.lastInsertRowid as number
}

export function getMessages(sessionId: string, limit = 200): Message[] {
  const database = getDb()
  if (!database) return []

  const rows = database.prepare(
    'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?'
  ).all(sessionId, limit) as MessageRow[]

  return rows.map(row => {
    const msg: Message = {
      role: row.role as Message['role'],
      content: row.content,
    }
    if (row.tool_calls) {
      try { msg.tool_calls = JSON.parse(row.tool_calls) } catch {}
    }
    if (row.usage) {
      try { msg.usage = JSON.parse(row.usage) } catch {}
    }
    if (msg.role === 'tool' && row.content) {
      // 尝试恢复 tool_call_id（从 tool_calls 中匹配）
    }
    return msg
  })
}

export function addMessages(sessionId: string, msgs: Message[]) {
  const database = getDb()
  if (!database) return

  const stmt = database.prepare(
    'INSERT INTO messages (session_id, role, content, tool_calls, usage) VALUES (?, ?, ?, ?, ?)'
  )

  const transaction = database.transaction((messages: Message[]) => {
    for (const msg of messages) {
      stmt.run(
        sessionId,
        msg.role,
        msg.content,
        msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
        msg.usage ? JSON.stringify(msg.usage) : null
      )
    }
  })

  transaction(msgs)
  updateSession(sessionId, {})
}

export function clearMessages(sessionId: string) {
  const database = getDb()
  if (!database) return
  database.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId)
}

// ─── File Change CRUD ───────────────────────────────────────────────
export function addFileChange(sessionId: string, change: {
  file_path: string
  before_hash?: string
  after_hash?: string
  diff?: string
}) {
  const database = getDb()
  if (!database) return

  database.prepare(
    'INSERT INTO file_changes (session_id, file_path, before_hash, after_hash, diff) VALUES (?, ?, ?, ?, ?)'
  ).run(sessionId, change.file_path, change.before_hash || null, change.after_hash || null, change.diff || null)
}

export function getFileChanges(sessionId: string): FileChangeRecord[] {
  const database = getDb()
  if (!database) return []

  return database.prepare(
    'SELECT * FROM file_changes WHERE session_id = ? ORDER BY created_at ASC'
  ).all(sessionId) as FileChangeRecord[]
}

// ─── JSON Fallback（兼容旧版）─────────────────────────────────────────
const HISTORY_DIR = join(DIR, 'history')

function generateSessionId(workspace?: string): string {
  const ws = workspace || process.cwd()
  return createHash('md5').update(ws + Date.now().toString()).digest('hex').slice(0, 12)
}

export function getWorkspaceSessionId(): string {
  return createHash('md5').update(process.cwd()).digest('hex').slice(0, 12)
}

export function getSessionFile(): string {
  mkdirSync(HISTORY_DIR, { recursive: true })
  return join(HISTORY_DIR, getWorkspaceSessionId() + '.json')
}

export function loadSessionFromJSON(): Message[] {
  const f = getSessionFile()
  if (existsSync(f)) {
    try {
      const raw = JSON.parse(readFileSync(f, 'utf-8'))
      if (Array.isArray(raw)) return raw
      if (raw.version && Array.isArray(raw.messages)) return raw.messages
      return []
    } catch {}
  }
  return []
}

export function saveSessionToJSON(msgs: Message[]) {
  mkdirSync(HISTORY_DIR, { recursive: true })
  writeFileSync(getSessionFile(), JSON.stringify({ version: 1, messages: msgs.slice(-40) }, null, 2))
}

// ─── 统一接口：优先 SQLite，fallback JSON ───────────────────────────
export function loadSession(sessionId?: string): Message[] {
  // 尝试 SQLite
  if (sessionId) {
    const msgs = getMessages(sessionId)
    if (msgs.length > 0) return msgs
  }

  // 使用 workspace session
  const wsId = getWorkspaceSessionId()
  const msgs = getMessages(wsId)
  if (msgs.length > 0) return msgs

  // Fallback to JSON
  return loadSessionFromJSON()
}

export function saveSession(sessionId: string | undefined, msgs: Message[]) {
  const sid = sessionId || getWorkspaceSessionId()

  // 确保 session 存在
  if (!getSession(sid)) {
    createSession({ workspace: process.cwd(), id: sid } as any)
  }

  // SQLite：先清空再重新插入
  clearMessages(sid)
  addMessages(sid, msgs.slice(-40))

  // 同时保存 JSON（备份兼容）
  saveSessionToJSON(msgs)
}

export function initWorkspaceSession(model?: string): string {
  const sid = getWorkspaceSessionId()
  if (!getSession(sid)) {
    createSession({ model: model || '', workspace: process.cwd() })
  }
  return sid
}

// ─── 类型定义 ───────────────────────────────────────────────────────
export interface SessionRecord {
  id: string
  created_at: string
  updated_at: string
  model: string
  title: string
  workspace: string
}

export interface MessageRow {
  id: number
  session_id: string
  role: string
  content: string
  tool_calls: string | null
  usage: string | null
  created_at: string
}

export interface FileChangeRecord {
  id: number
  session_id: string
  file_path: string
  before_hash: string | null
  after_hash: string | null
  diff: string | null
  created_at: string
}

export function isSQLiteAvailable(): boolean {
  return getDb() !== null
}
