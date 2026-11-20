import { useEffect, useRef, useSyncExternalStore } from 'react';
import { getDraft, setDraft, useDraftSync } from './drafts.ts';

export const ANSWER_COMPOSE = 'desk-answer-compose';
interface Target { key: string; taskId: string; title: string }
interface Handler { active: boolean; accept: (text: string) => Promise<void> }
const handlers = new Map<string, Map<symbol, { current: Handler }>>();
const targets = new Map<string, Target>();
const listeners = new Set<() => void>();
const pending = new Set<string>();
const operations = new Set<string>();
export async function answerOperation(key: string, action: () => Promise<unknown>) {
  if (operations.has(key)) throw new Error('이 질문의 답변을 전송 중입니다.');
  operations.add(key); emit();
  try { await action(); } finally { operations.delete(key); emit(); }
}
export function useAnswerPending(key: string) {
  return useSyncExternalStore(subscribe, () => operations.has(key), () => false);
}
const emit = () => listeners.forEach(fn => fn());
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
// Old destinations could point to a choice or a member of a question batch.
const draftKey = (taskId: string) => `open-answer-target:${taskId}`;
function current(taskId: string) {
  if (!targets.has(taskId)) {
    const saved = getDraft<Target>(draftKey(taskId));
    if (saved?.taskId === taskId) targets.set(taskId, saved);
  }
  return targets.get(taskId);
}
function clear(target: Target) {
  if (current(target.taskId) !== target || pending.has(target.taskId)) return;
  targets.delete(target.taskId);
  setDraft(draftKey(target.taskId), null, { empty: true }); emit();
}

/** A persisted destination has no callback; mounted cards register their current handlers separately. */
export function useAnswerWriter(taskId: string, questionId: string, active: boolean, accept: Handler['accept']) {
  const owner = useRef(Symbol());
  const latest = useRef({ active, accept });
  latest.current = { active, accept };
  const key = `${taskId}:${questionId}`;
  useEffect(() => {
    let group = handlers.get(key);
    if (!group) handlers.set(key, group = new Map());
    group.set(owner.current, latest);
    return () => { group.delete(owner.current); if (!group.size) handlers.delete(key); };
  }, [key]);
  return (title: string) => {
    if (!latest.current.active || pending.has(taskId)) return;
    const target = { key, taskId, title };
    targets.set(taskId, target);
    setDraft(draftKey(taskId), target, { taskId, empty: false }); emit();
    window.dispatchEvent(new CustomEvent(ANSWER_COMPOSE, { detail: { taskId } }));
  };
}

export function useAnswerTarget(taskId: string) {
  useDraftSync<Target>(draftKey(taskId), value => {
    if (value?.taskId === taskId) targets.set(taskId, value); else targets.delete(taskId);
    emit();
  });
  // Keep only mounted composers cached; the small destination record survives in the draft store.
  useEffect(() => () => { targets.delete(taskId); }, [taskId]);
  return useSyncExternalStore(subscribe, () => current(taskId), () => undefined);
}
export async function submitAnswer(target: Target, text: string) {
  if (!text.trim()) throw new Error('답변을 입력해 주세요.');
  if (current(target.taskId) !== target || pending.has(target.taskId)) throw new Error('답변을 처리 중이거나 대상이 변경되었습니다.');
  const handler = [...(handlers.get(target.key)?.values() ?? [])].reverse().find(ref => ref.current.active)?.current;
  if (!handler) throw new Error('이 질문이 종료되었거나 아직 로딩되지 않았습니다. 질문을 확인하고 답변 대상을 다시 선택해 주세요.');
  pending.add(target.taskId);
  try { await handler.accept(text.trim()); }
  catch (error) { pending.delete(target.taskId); throw error; }
  pending.delete(target.taskId); clear(target);
}
export function AnswerDestination({ taskId }: { taskId: string }) {
  const target = useAnswerTarget(taskId);
  if (!target) return null;
  return <div className="reply-note" role="status">답변 대상: <b>{target.title}</b> <button className="link" onClick={() => clear(target)}>취소</button></div>;
}
