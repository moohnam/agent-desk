/** Only a single open question without a secret response can use a normal reply box. */
export function usesReplyComposer(questions: unknown): boolean {
  if (!Array.isArray(questions) || questions.length !== 1) return false;
  const question = questions[0];
  return !!question && typeof question === 'object' && !question.secret &&
    (question.options == null || Array.isArray(question.options) && question.options.length === 0);
}
