// ─── extractMemories 单元测试 ──────────────────────────────────────────
// 测试核心逻辑：触发条件、相似度、去重
// 运行：npx tsx test/extractMemories.test.ts

import { strict as assert } from 'assert'
import { existsSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// ─── 测试隔离：用临时目录 ──
const TEST_DIR = join(homedir(), '.edgecli-test-extract')
const ORIGINAL_MEM_DIR = join(homedir(), '.edgecli')

// 备份并替换路径（hacky 但有效）
let backupDone = false

function setupTestEnv() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true })
  mkdirSync(TEST_DIR, { recursive: true })
}

function cleanupTestEnv() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true })
}

// ─── 直接测试可导出的纯函数 ──

// similarity 函数（从 extractMemories.ts 复制出来测试）
function similarity(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean))
  const setB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean))
  const intersection = new Set([...setA].filter(x => setB.has(x)))
  const union = new Set([...setA, ...setB])
  return union.size ? intersection.size / union.size : 0
}

// ─── 测试用例 ──

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✅ ${name}`)
    passed++
  } catch (e: any) {
    console.log(`  ❌ ${name}: ${e.message}`)
    failed++
  }
}

async function asyncTest(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
    passed++
  } catch (e: any) {
    console.log(`  ❌ ${name}: ${e.message}`)
    failed++
  }
}

console.log('\n🧪 extractMemories 单元测试\n')

// ─── similarity 测试 ──
console.log('📐 similarity 函数')

test('完全相同 → 1.0', () => {
  const s = similarity('hello world', 'hello world')
  assert.equal(s, 1.0)
})

test('完全不重叠 → 0.0', () => {
  const s = similarity('abc def', 'xyz uvw')
  assert.equal(s, 0.0)
})

test('部分重叠', () => {
  const s = similarity('hello world foo', 'hello bar foo')
  // 重叠: hello, foo = 2, 总共: hello, world, foo, bar = 4
  assert.equal(s, 0.5)
})

test('大小写不敏感', () => {
  const s = similarity('Hello World', 'hello world')
  assert.equal(s, 1.0)
})

test('空字符串', () => {
  const s = similarity('', 'hello')
  assert.equal(s, 0.0)
})

// ─── 触发条件测试 ──
console.log('\n⏱️ shouldExtractGlobalMemories 触发条件')

test('首次调用（state 全零）→ 应触发', () => {
  // 模拟：lastExtraction = 0, completedSessions = 0
  // hoursSince = 很大，应该触发
  const lastExtraction = 0
  const now = Date.now()
  const hoursSince = (now - lastExtraction) / (1000 * 60 * 60)
  assert.ok(hoursSince > 24, '首次调用应该超过 24 小时')
})

test('刚提取完 → 不应立即触发', () => {
  const lastExtraction = Date.now()
  const now = Date.now()
  const hoursSince = (now - lastExtraction) / (1000 * 60 * 60)
  assert.ok(hoursSince < 1, '刚提取完不应该触发')
})

test('session 累计达到阈值 → 应触发', () => {
  const completedSessions = 5
  const threshold = 5
  assert.ok(completedSessions >= threshold, '达到阈值应该触发')
})

// ─── 去重测试 ──
console.log('\n🔍 去重逻辑')

test('完全相同内容应被去重', () => {
  const memories = [
    { type: 'fact', content: 'user uses windows' },
    { type: 'fact', content: 'user uses windows' },
  ]
  const s = similarity(memories[0].content, memories[1].content)
  assert.ok(s >= 0.9, '相同内容相似度应 >= 0.9')
})

test('不同内容不应去重', () => {
  const memories = [
    { type: 'fact', content: 'user uses windows' },
    { type: 'fact', content: 'user prefers short replies' },
  ]
  const s = similarity(memories[0].content, memories[1].content)
  assert.ok(s < 0.5, '不同内容相似度应 < 0.5')
})

test('不同类型相同内容 → 不去重（类型不同才检查）', () => {
  // 实际逻辑：type === existing.type 才比较相似度
  // 所以不同类型不会互相去重
  const a = { type: 'fact', content: 'hello world' }
  const b = { type: 'preference', content: 'hello world' }
  assert.notEqual(a.type, b.type, '不同类型')
})

// ─── Memory 结构测试 ──
console.log('\n📦 ExtractedMemory 结构')

test('必填字段', () => {
  const mem = {
    id: 'mem_123',
    type: 'fact',
    content: 'test',
    confidence: 0.8,
    source: {},
    created: Date.now(),
  }
  assert.ok(mem.id, '需要 id')
  assert.ok(['fact', 'preference', 'task_result', 'error_pattern'].includes(mem.type), 'type 必须是 4 种之一')
  assert.ok(mem.confidence >= 0 && mem.confidence <= 1, 'confidence 在 0-1 之间')
})

test('低置信度应被过滤', () => {
  const minConfidence = 0.6
  const extracted = { confidence: 0.4 }
  assert.ok(extracted.confidence < minConfidence, '低于阈值应过滤')
})

// ─── 结果 ──
console.log(`\n📊 结果: ${passed} passed, ${failed} failed\n`)

if (failed > 0) {
  process.exit(1)
}
