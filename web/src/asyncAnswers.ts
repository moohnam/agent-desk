import type { AsyncQuestion } from '../../shared/protocol.ts';

/** Async questions share one reply: send only when every question has an answer. */
export function asyncAnswerText(questions: AsyncQuestion[], answers: string[]): string | null {
  if (!questions.length || questions.some((_, i) => !answers[i]?.trim())) return null;
  if (questions.length === 1) return answers[0].trim();
  // Titles may mention compose controls such as #auto: do not re-send them as user commands.
  return questions.map((_, i) => `${i + 1}. ${answers[i].trim()}`).join('\n\n');
}
