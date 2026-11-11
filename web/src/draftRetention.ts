import { splitId } from './federation.ts';
import type { Draft } from './drafts.ts';

export function confirmedMissingTask(id: string, present: boolean, availableSources: ReadonlySet<string>) {
  const [source] = splitId(id);
  return !present && !!source && availableSources.has(source);
}

/** A plain missing task may be a legacy remote task whose link is not published yet. */
export function keepTaskDraft(key: string, draft: Draft, state: {
  tasks: ReadonlyMap<string, unknown>;
  questions: ReadonlyMap<string, unknown>;
  approvals: ReadonlyMap<string, unknown>;
  gone: ReadonlySet<string>;
  availableSources: ReadonlySet<string>;
}): boolean {
  const taskId = draft.taskId;
  if (taskId && state.gone.has(taskId)) return false;
  if (taskId && !state.tasks.has(taskId)) {
    return !confirmedMissingTask(taskId, false, state.availableSources);
  }
  const question = key.startsWith('question:') ? key.slice('question:'.length) : null;
  const approval = key.startsWith('ask:') ? key.slice('ask:'.length) : null;
  if (!question && !approval) return true;
  if (question ? state.questions.has(question) : state.approvals.has(approval!)) return true;
  const [source] = splitId(taskId ?? (question ?? approval!));
  // A missing plain task or an old answer without task context cannot prove ownership.
  if (!source && (!taskId || !state.tasks.has(taskId))) return true;
  return !state.availableSources.has(source);
}
