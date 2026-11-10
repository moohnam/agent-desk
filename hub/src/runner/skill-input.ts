import { join } from 'node:path';

/** Native skill items alone are not expanded by Codex's mid-turn steering path. */
export function steeringSkillText(text: string, skills: string[] | undefined, skillsHome: string | undefined): string {
  if (!skillsHome || !skills?.length) return text;
  const files = skills.map(name => `#${name}: ${JSON.stringify(join(skillsHome, 'skills', name, 'SKILL.md'))}`).join('\n');
  const header = `[데스크 스킬] 이 메시지에는 먼저 다음 스킬 파일을 읽고 그 지침을 따르세요:\n${files}\n\n`;
  return text.startsWith(header) ? text : header + (text || '(추가 지시 없음)');
}
