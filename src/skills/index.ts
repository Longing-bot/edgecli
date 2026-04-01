// ─── 技能系统（OpenClaw Skills 风格）────────────────────────────────────────
// OpenClaw 的技能系统：按需加载 SKILL.md，注入到系统提示词
// 技能定义在 skills/ 目录下，每个技能一个子目录

import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join, resolve } from 'path'
import { homedir } from 'os'

export interface Skill {
  name: string
  description: string
  triggerCondition: string
  content: string
  path: string
}

const SKILL_FILE = 'SKILL.md'

// 扫描技能目录
export function loadSkills(skillsDir: string): Skill[] {
  if (!existsSync(skillsDir)) return []

  const skills: Skill[] = []
  const entries = readdirSync(skillsDir)

  for (const entry of entries) {
    const skillPath = join(skillsDir, entry)
    const stat = statSync(skillPath)

    if (stat.isDirectory()) {
      const skillFile = join(skillPath, SKILL_FILE)
      if (existsSync(skillFile)) {
        try {
          const content = readFileSync(skillFile, 'utf-8')
          const name = entry
          const description = parseDescription(content)
          const triggerCondition = parseTriggerCondition(content)

          skills.push({ name, description, triggerCondition, content, path: skillFile })
        } catch {}
      }
    }
  }

  return skills
}

function parseDescription(content: string): string {
  const lines = content.split('\n')
  // 取第一行标题
  const title = lines[0].replace(/^#\s*/, '').slice(0, 80)
  return title
}

function parseTriggerCondition(content: string): string {
  const match = content.match(/##\s*触发条件\s*\n([\s\S]*?)(?=\n##|\n#|$)/)
  if (match) {
    return match[1].trim().split('\n')[0].slice(0, 100)
  }
  return ''
}

// 构建技能提示词（注入到系统提示词）
export function buildSkillsPrompt(skills: Skill[]): string {
  if (skills.length === 0) return ''

  const skillList = skills.map(s => {
    const trigger = s.triggerCondition ? `（触发: ${s.triggerCondition}）` : ''
    return `- ${s.name}: ${s.description} ${trigger}`
  }).join('\n')

  return `
# Skills（按需加载）

可用技能：
${skillList}

当需要使用某个技能时，先读取其 SKILL.md 文件获取详细指令。
技能目录: ~/.edgecli/skills/
`
}

// 获取单个技能内容
export function getSkillContent(skill: Skill): string {
  return skill.content
}

// 注册自定义技能目录（支持多个目录）
export function loadAllSkills(dirs: string[]): Skill[] {
  const allSkills: Skill[] = []
  for (const dir of dirs) {
    allSkills.push(...loadSkills(dir))
  }
  return allSkills
}

// ─── 技能目录管理 ──────────────────────────────────────────────────
export function getSkillsDirectories(): string[] {
  return [
    join(process.cwd(), 'skills'),
    join(homedir(), '.edgecli', 'skills'),
  ]
}

export function listAllLoadedSkills(): Skill[] {
  return loadAllSkills(getSkillsDirectories())
}

export function formatSkillsList(skills: Skill[]): string {
  if (skills.length === 0) {
    return '没有加载任何技能。\n\n技能目录: ~/.edgecli/skills/\n每个技能一个子目录，包含 SKILL.md 文件。'
  }

  const lines: string[] = ['已加载的技能:\n']
  for (const skill of skills) {
    lines.push(`  📦 ${skill.name}`)
    lines.push(`     ${skill.description}`)
    if (skill.triggerCondition) {
      lines.push(`     触发: ${skill.triggerCondition}`)
    }
    lines.push(`     路径: ${skill.path}`)
    lines.push('')
  }
  lines.push(`共 ${skills.length} 个技能`)
  return lines.join('\n')
}
