// Parses the compose box syntax shared by the hub and the web UI (no Node imports here).
//   @name          continue the latest task of an existing project
//   @name#N        continue task N of the project (tasks are numbered 1, 2, … per project)
//   @name:/path    define a project (or reuse it) and start a new task there
//   #tag           each tag maps to one effect and applies to this message only. Some effects
//                  change state that later messages see:
//     #auto          switch the session to automatic approval (stays until #ask)
//     #ask           switch the session to ask before each tool use (DEFAULT_MODE; the SDK's 'default')
//     #claude/#codex engine for a new task (default claude); an existing task keeps its engine
//     #opus/#sonnet/#haiku  Claude model, #sol/#astra/#terra/#luna  Codex model family (the latest
//                    version of it); stays with the task until another model tag. A model tag also picks
//                    the engine of a new task. Untagged new tasks use the desk's default for the engine,
//                    else the engine's own default
//     #low…#max      reasoning effort for the task, kept the same way; a model that lacks the level
//                    runs at the nearest one it supports. #ultra is Codex only
//     #later/#now    what to do with a message sent while the task is still working: run it after
//                    the current turn (#later, the default) or add it to the running turn (#now)
//     #new           start a new task in the project instead of continuing one: a fresh session in
//                    the same directory that knows nothing of the other tasks
//     #fork          start a new task that carries on from a copy of the task's conversation so far
//     #<skill>       use that desk skill for this message (skills live in one directory both engines read)
// Unknown tags stay in the text as written.

export type PermissionMode = 'auto' | 'default';

/** Mode for new work when no tag is given. */
export const DEFAULT_MODE: PermissionMode = 'default';

export const MODE_TAGS: Record<string, PermissionMode> = { auto: 'auto', ask: 'default' };
export const MODE_LABEL: Record<PermissionMode, string> = { auto: '#auto', default: '#ask' };

export type EngineName = 'claude' | 'codex';
export const DEFAULT_ENGINE: EngineName = 'claude';
export const ENGINE_LABEL: Record<EngineName, string> = { claude: 'Claude', codex: 'Codex' };

/**
 * Models by alias: Claude Code resolves a Claude alias to its latest version; for Codex the runner
 * picks the latest model of the family (codex.ts).
 */
export type ModelName = 'opus' | 'sonnet' | 'haiku' | 'sol' | 'astra' | 'terra' | 'luna';
export const ENGINE_MODELS: Record<EngineName, ModelName[]> = {
  claude: ['opus', 'sonnet', 'haiku'],
  codex: ['sol', 'astra', 'terra', 'luna'],
};
export const MODEL_TAGS: ModelName[] = [...ENGINE_MODELS.claude, ...ENGINE_MODELS.codex];
export const MODEL_LABEL: Record<ModelName, string> = {
  opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', sol: 'Sol', astra: 'Astra', terra: 'Terra', luna: 'Luna',
};
export const modelEngine = (m: ModelName): EngineName => (ENGINE_MODELS.claude.includes(m) ? 'claude' : 'codex');

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export const EFFORT_TAGS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const ENGINE_EFFORTS: Record<EngineName, Effort[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: EFFORT_TAGS,
};

/**
 * Why a model/effort pair can't run on `engine`, or null. The engine is the task's, or for a new
 * task the one the tags pick (`wantedEngine`).
 */
export function modelProblem(engine: EngineName, c: { model?: ModelName; effort?: Effort }): string | null {
  if (c.model && modelEngine(c.model) !== engine) {
    return `#${c.model}은(는) ${ENGINE_LABEL[modelEngine(c.model)]} 모델입니다. 이 작업은 ${ENGINE_LABEL[engine]}입니다`;
  }
  if (c.effort && !ENGINE_EFFORTS[engine].includes(c.effort)) return `#${c.effort}는 ${ENGINE_LABEL[engine]}에서 쓸 수 없습니다`;
  return null;
}

/** How a message reaches a task that may be busy; see the header. */
export type Delivery = 'later' | 'now' | 'new' | 'fork';
export const DELIVERY_TAGS: Delivery[] = ['later', 'now', 'new', 'fork'];
export const DELIVERY_LABEL: Record<Delivery, string> = { later: '대기', now: '끼워넣기', new: '새 작업', fork: '포크' };

/** The engine a new task gets: an engine tag, else the one a model tag implies, else the default. */
export const wantedEngine = (c: { engine?: EngineName; model?: ModelName }): EngineName | undefined =>
  c.engine ?? (c.model ? modelEngine(c.model) : undefined);

/** Built-in tags; a skill cannot take one of these names. */
export const RESERVED_TAGS = ['auto', 'ask', 'claude', 'codex', ...MODEL_TAGS, ...EFFORT_TAGS, ...DELIVERY_TAGS];
/** Skill names: what a #tag can hold, and a safe directory name. */
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface Composed {
  /** `no`: the task number after `#`. */
  mention?: { name: string; no?: number; path?: string };
  mode?: PermissionMode;
  engine?: EngineName;
  model?: ModelName;
  effort?: Effort;
  delivery?: Delivery;
  /** Skills named by #tags, in order of appearance, without duplicates. */
  skills: string[];
  /** The text with the mention and recognised tags removed; what the agent receives. */
  body: string;
}

const MENTION = /(^|\s)@([^\s:@#]+)(?:#(\d+))?(?::(\S+))?/;
const TAG = /(^|\s)#([a-z0-9][a-z0-9-]*)(?=\s|$)/gi;

/** `skills`: names of the skills that exist; a #tag naming none of them stays as text. */
export function parseCompose(text: string, skills: Iterable<string> = []): Composed {
  const known = new Set(skills);
  let body = text;
  let mention: Composed['mention'];
  const m = MENTION.exec(body);
  if (m) {
    mention = { name: m[2], no: m[3] ? Number(m[3]) : undefined, path: m[4] };
    body = body.slice(0, m.index) + m[1] + body.slice(m.index + m[0].length);
  }
  let mode: PermissionMode | undefined;
  let engine: EngineName | undefined;
  let model: ModelName | undefined;
  let effort: Effort | undefined;
  let delivery: Delivery | undefined;
  const used: string[] = [];
  body = body.replace(TAG, (all, pre: string, tag: string) => {
    const t = tag.toLowerCase();
    if (t === 'claude' || t === 'codex') { engine ??= t; return pre; }
    if (MODE_TAGS[t]) { mode ??= MODE_TAGS[t]; return pre; }
    if ((MODEL_TAGS as string[]).includes(t)) { model ??= t as ModelName; return pre; }
    if ((EFFORT_TAGS as string[]).includes(t)) { effort ??= t as Effort; return pre; }
    if ((DELIVERY_TAGS as string[]).includes(t)) { delivery ??= t as Delivery; return pre; }
    if (known.has(t)) { if (!used.includes(t)) used.push(t); return pre; }
    return all;
  });
  return { mention, mode, engine, model, effort, delivery, skills: used, body: body.trim() };
}
