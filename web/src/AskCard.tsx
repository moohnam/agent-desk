import { useEffect, useState } from 'react';
import { ASK_USER, type Answers } from '../../hub/src/runner/protocol.ts';
import { api } from './api.ts';
import { getDraft, setDraft } from './drafts.ts';
import type { Approval, Post } from './types.ts';

/** A multiple-choice question an engine session asks (Claude's AskUserQuestion, Codex's request_user_input). */
export const isAsk = (toolName: string | undefined) => toolName === ASK_USER;

interface AskOption { label: string; description?: string; preview?: string }
interface AskQuestion { question: string; header?: string; multiSelect?: boolean; secret?: boolean; options?: AskOption[] }

/** What the user has chosen for one question: picked option labels, plus free text ("기타"). */
interface Pick { labels: string[]; other: string; otherOn: boolean }
const EMPTY: Pick = { labels: [], other: '', otherOn: false };

function answerOf(q: AskQuestion, p: Pick): string {
  const other = p.otherOn || !q.options?.length ? p.other.trim() : '';
  return [...p.labels, ...(other ? [other] : [])].join(', ');
}

/** Short one-line summary for the approval queue. */
export function askSummary(input: Record<string, any>): string {
  const qs: AskQuestion[] = Array.isArray(input?.questions) ? input.questions : [];
  return qs.map((q) => q.question).join(' · ');
}

/**
 * The question card: pick an option per question (several when multiSelect), or write one's own
 * answer, then send them all at once. "답하지 않기" denies the request so the agent carries on.
 */
export function AskCard({ post, approval, onError }: {
  post: Post; approval: Approval | undefined; onError?: (msg: string) => void;
}) {
  const p = post.event.payload;
  const qs: AskQuestion[] = Array.isArray(p.input?.questions) ? p.input.questions : [];
  const r = post.resolution?.payload;
  // Unsent choices are kept as a draft (drafts.ts) while the question waits; a secret answer never is.
  const draftKey = `ask:${p.approvalId}`;
  const [picks, setPicks] = useState<Pick[]>(() => {
    const saved = getDraft<Pick[]>(draftKey);
    return saved?.length === qs.length ? saved : qs.map(() => EMPTY);
  });
  const [busy, setBusy] = useState(false);
  // Shown between a successful answer and its approval event arriving.
  const [sent, setSent] = useState<Answers | null>(null);
  const answers: Answers | undefined = r?.answers ?? sent ?? undefined;
  const outcome = answers ? 'answered' : r ? (r.decision === 'allowed' ? 'empty' : r.decision === 'cancelled' ? 'cancelled' : 'skipped')
    : approval ? null : 'closed';

  useEffect(() => {
    const kept = picks.map((x, i) => (qs[i]?.secret ? { ...x, other: '' } : x));
    const empty = !!outcome || kept.every((x) => !x.labels.length && !x.other.trim());
    setDraft(draftKey, kept, { taskId: post.taskId, empty });
  }, [draftKey, picks, outcome, post.taskId]);

  const set = (i: number, f: (p: Pick) => Pick) => setPicks((ps) => ps.map((x, k) => (k === i ? f(x) : x)));
  const choose = (i: number, label: string) => set(i, (x) => qs[i].multiSelect
    ? { ...x, labels: x.labels.includes(label) ? x.labels.filter((l) => l !== label) : [...x.labels, label] }
    : { ...x, labels: [label], otherOn: false });
  const ready = qs.length > 0 && qs.every((q, i) => answerOf(q, picks[i]) !== '');

  const submit = async () => {
    if (!ready || busy || !approval) return;
    const out: Answers = Object.fromEntries(qs.map((q, i) => [q.question, answerOf(q, picks[i])]));
    setBusy(true);
    try { await api.resolve(approval.id, true, undefined, out); setSent(out); }
    catch (e) { onError?.(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const skip = async () => {
    if (busy || !approval) return;
    setBusy(true);
    try { await api.resolve(approval.id, false, '사용자가 답하지 않고 넘겼습니다. 질문 없이 판단해 진행하세요.'); }
    catch (e) { onError?.(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  if (outcome) {
    return (
      <div className="approve-card question-card ask-card resolved">
        <div className="what">에이전트의 질문</div>
        {qs.map((q, i) => (
          <div key={i} className="ask-q">
            {q.header && <span className="ask-head">{q.header}</span>} {q.question}
            {answers && <div className="resolution ok">✓ {q.secret ? '••••' : answers[q.question] ?? '(답 없음)'}</div>}
          </div>
        ))}
        {outcome !== 'answered' && (
          <div className="approve-actions"><span className="resolution no">
            {outcome === 'empty' ? '답 없이 넘어감' : outcome === 'skipped' ? '답하지 않음' : outcome === 'cancelled' ? '취소됨' : '닫힘'}
          </span></div>
        )}
      </div>
    );
  }

  return (
    <div className="approve-card question-card ask-card" onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); } }}>
      <div className="what">에이전트가 답을 기다립니다</div>
      {qs.map((q, i) => {
        const pick = picks[i];
        const opts = q.options ?? [];
        const shown = opts.find((o) => pick.labels.includes(o.label) && o.preview);
        return (
          <div key={i} className="ask-q">
            <div className="ask-title">{q.header && <span className="ask-head">{q.header}</span>} {q.question}
              {q.multiSelect && <span className="muted"> (여러 개 선택)</span>}</div>
            {opts.length > 0 && (
              <div className="ask-opts" role={q.multiSelect ? 'group' : 'radiogroup'}>
                {opts.map((o, k) => {
                  const on = pick.labels.includes(o.label);
                  return (
                    <button key={o.label} type="button" className={`ask-opt${on ? ' on' : ''}`} disabled={busy}
                      role={q.multiSelect ? 'checkbox' : 'radio'} aria-checked={on}
                      data-question={i === 0 && k === 0 ? approval!.id : undefined}
                      onClick={() => choose(i, o.label)}>
                      <span className="mark">{q.multiSelect ? (on ? '☑' : '☐') : (on ? '◉' : '○')}</span>
                      <span><b>{o.label}</b>{o.description && <span className="desc">{o.description}</span>}</span>
                    </button>
                  );
                })}
                <button type="button" className={`ask-opt${pick.otherOn ? ' on' : ''}`} disabled={busy}
                  role={q.multiSelect ? 'checkbox' : 'radio'} aria-checked={pick.otherOn}
                  onClick={() => set(i, (x) => ({ ...x, otherOn: !x.otherOn, labels: q.multiSelect ? x.labels : [] }))}>
                  <span className="mark">{q.multiSelect ? (pick.otherOn ? '☑' : '☐') : (pick.otherOn ? '◉' : '○')}</span>
                  <span><b>기타</b><span className="desc">직접 입력</span></span>
                </button>
              </div>
            )}
            {shown?.preview && <pre className="mono ask-preview">{shown.preview}</pre>}
            {(pick.otherOn || opts.length === 0) && (q.secret ? (
              // A secret (a password or token) is typed blind and kept out of autofill.
              <input className="input" type="password" autoComplete="off" value={pick.other} disabled={busy}
                autoFocus={opts.length > 0} data-question={i === 0 && opts.length === 0 ? approval!.id : undefined}
                placeholder="답 입력…"
                onChange={(e) => set(i, (x) => ({ ...x, other: e.target.value }))}
                onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.currentTarget.blur(); } }} />
            ) : (
              <textarea className="input" rows={2} value={pick.other} disabled={busy} autoFocus={opts.length > 0}
                data-question={i === 0 && opts.length === 0 ? approval!.id : undefined}
                placeholder="답 입력…"
                onChange={(e) => set(i, (x) => ({ ...x, other: e.target.value }))}
                onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.currentTarget.blur(); } }} />
            ))}
          </div>
        );
      })}
      <div className="approve-actions">
        <button className="no" disabled={busy} title="답하지 않고 에이전트가 알아서 진행하게 합니다" onClick={() => void skip()}>답하지 않기</button>
        <span className="spacer" />
        <span className="muted"><kbd>⌘</kbd><kbd>↵</kbd></span>
        <button className="yes" disabled={!ready || busy} onClick={() => void submit()}>답하기</button>
      </div>
    </div>
  );
}
