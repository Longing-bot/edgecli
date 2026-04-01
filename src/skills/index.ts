// ─── 技能系统（OpenClaw Skills 风格）────────────────────────────────────────
// OpenClaw 的技能系统：按需加载 SKILL.md，注入到系统提示词
// 技能定义在 skills/ 目录下，每个技能一个子目录

import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join, resolve } from 'path'

export interface Skill {
  name: string
  description: string
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
          // 从第一行提取描述（# 标题）
          const firstLine = content.split('\n')[0]
          const name = entry
          const description = firstLine.replace(/^#\s*/, '').slice(0, 80)

          skills.push({ name, description, content, path: skillFile })
        } catch {}
      }
    }
  }

  return skills
}

// 构建技能提示词（注入到系统提示词）
export function buildSkillsPrompt(skills: Skill[]): string {
  if (skills.length === 0) return ''

  const skillList = skills.map(s => `- ${s.name}: ${s.description}`).join('\n')

  return `
# Skills（按需加载）

可用技能：
${skillList}

当需要使用某个技能时，先读取其 SKILL.md 文件获取详细指令。
技能目录: skills/
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
