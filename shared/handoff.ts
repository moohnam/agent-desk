// Context reset ("컨텍스트 재구성"), shared by the hub and the web UI (no Node imports here).
// The thread's agent writes a handoff summary of the whole conversation that keeps the key facts of
// the posts the user picked; the user revises it (by hand or by asking the agent again), checks the
// final message, and the task continues in a fresh engine session that gets only that message.

/** The summary sits between these lines in the agent's reply. */
export const HANDOFF_START = '<<<정리본 시작>>>';
export const HANDOFF_END = '<<<정리본 끝>>>';

/** The summary's sections, in order. */
export const HANDOFF_SECTIONS = ['목표', '지금까지의 결정과 근거', '진행 상황 (끝난 일 / 하던 일)', '꼭 알아야 할 정보', '남은 일과 주의할 점'];

/** A post quoted into a request or the final message. */
export interface Quoted { who: string; ts: string; text: string }

/** A thread post as quoted: my messages, the agent's replies, and other tasks' questions; null without text. */
export function quoteEvent(e: { kind: string; ts: string; payload: unknown }): Quoted | null {
  const p = e.payload as { text?: unknown; request?: { from?: string } };
  if (!['user', 'assistant', 'update'].includes(e.kind) || typeof p.text !== 'string') return null;
  return { who: e.kind !== 'user' ? '에이전트' : p.request ? `@${p.request.from} (다른 작업의 에이전트)` : '사용자', ts: e.ts, text: p.text };
}

const stamp = (ts: string) => {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export const quoteBlock = (posts: Quoted[]) => posts.map((q) => `--- ${q.who} · ${stamp(q.ts)}\n${q.text.trim()}`).join('\n\n');

const FORMAT = [HANDOFF_START, ...HANDOFF_SECTIONS.map((s) => `## ${s}`), HANDOFF_END].join('\n');

/** Asks the agent for the summary; `picked`: the posts whose key facts it must keep. */
export function draftPrompt(picked: Quoted[]): string {
  return [
    '[데스크: 컨텍스트 재구성 정리본 요청]',
    '곧 이 대화의 컨텍스트를 비우고, 새 세션에 정리본 하나만 넘겨 이 작업을 이어갑니다. 새 세션의 에이전트가 정리본만 읽고 바로 이어서 일할 수 있게 써 주세요.',
    '- 지금까지의 전체 대화를 요약합니다.',
    picked.length ? '- 아래 [선택한 글]의 핵심 정보(경로, 명령, 수치, 결정과 그 근거)는 빠짐없이 담습니다.' : null,
    '- 새로 조사하거나 파일을 고치지 말고, 이미 아는 내용으로만 씁니다.',
    '- 아래 형식을 지키고, 정리본 전체를 시작 줄과 끝 줄 사이에 넣습니다. 다른 말은 그 바깥에 씁니다.',
    '',
    FORMAT,
    ...(picked.length ? ['', '[선택한 글]', quoteBlock(picked)] : []),
  ].filter((l) => l !== null).join('\n');
}

/** Asks the agent to rewrite `current` (possibly edited by the user) as `feedback` says. */
export function revisePrompt(feedback: string, current: string): string {
  return [
    '[데스크: 정리본 수정 요청]',
    '아래 정리본을 요청대로 고쳐 다시 써 주세요. 형식과 시작 줄·끝 줄은 그대로 지키고, 고친 정리본 전체를 그 사이에 넣습니다.',
    `요청: ${feedback.trim()}`,
    '',
    HANDOFF_START,
    current.trim(),
    HANDOFF_END,
  ].join('\n');
}

/** The summary in an agent reply (the last one if several), or null. */
export function extractHandoff(text: string): string | null {
  const end = text.lastIndexOf(HANDOFF_END);
  if (end < 0) return null;
  const start = text.lastIndexOf(HANDOFF_START, end);
  if (start < 0) return null;
  return text.slice(start + HANDOFF_START.length, end).trim() || null;
}

/** The first message of the fresh session, before the user's final edits. */
export function handoffMessage(summary: string, appendix: Quoted[], next: string): string {
  return [
    '[데스크: 이전 세션에서 넘겨받은 정리본]',
    '이 작업은 컨텍스트를 비우고 새 세션으로 이어갑니다. 아래 정리본이 지금까지의 맥락입니다.',
    '',
    summary.trim(),
    ...(appendix.length ? ['', '[부록: 선택한 글 원문]', quoteBlock(appendix)] : []),
    ...(next.trim() ? ['', '[이어서 할 일]', next.trim()] : []),
  ].join('\n');
}
