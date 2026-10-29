// Parses the compose box syntax shared by the hub and the web UI (no Node imports here).
//   @name          continue the latest task of an existing project
//   @name#N        continue task N of the project (tasks are numbered 1, 2, … per project)
//   @name:/path    define a project (or reuse it) and start a new task there
//   #tag           each tag maps to one effect and applies to this message only. Some effects
//                  change state that later messages see:
//     #auto          switch the session to automatic approval (stays until #ask)
//     #ask           switch the session to ask before each tool use (DEFAULT_MODE; the SDK's 'default')
//     #<engine>      engine for a new task (ENGINE_INFO; default claude); an existing task keeps its engine
//     #<model>       a model of an engine (ENGINE_INFO.models: a Claude alias, or a Codex or agy family whose
//                    latest version runs); stays with the task until another model tag. A model tag also picks
//                    the engine of a new task. Untagged new tasks use the desk's default for the engine,
//                    else the engine's own default
//     #low…#max      reasoning effort for the task, kept the same way; a model that lacks the level
//                    runs at the nearest one it supports (agy: #xhigh and #max run as high). #ultra is Codex only
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

export type EngineName = 'claude' | 'codex' | 'agy';
export type ModelName = 'opus' | 'sonnet' | 'haiku' | 'sol' | 'astra' | 'terra' | 'luna' | 'argon' | 'flash';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export const EFFORT_TAGS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/**
 * The engines, one row each; everything else about engines here and in the web UI derives from
 * it. Adding an engine also takes a runner adapter (hub/src/runner) and, for usage, a reader (usage.ts).
 * `short`: avatar letters. `models`: its model tags, the first-listed family shown first.
 * `modelOwner`: whose models the tags name in help texts. `family`: a tag names a model family, whose latest
 * version runs (else a model alias).
 */
export const ENGINE_INFO: Record<EngineName, {
  label: string; tagLabel: string; short: string; models: ModelName[]; efforts: Effort[]; modelOwner: string; family: boolean;
}> = {
  claude: { label: 'Claude', tagLabel: 'Claude', short: 'C', models: ['opus', 'sonnet', 'haiku'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'], modelOwner: 'Claude', family: false },
  codex: { label: 'Codex', tagLabel: 'Codex', short: 'Cx', models: ['sol', 'astra', 'terra', 'luna'],
    efforts: EFFORT_TAGS, modelOwner: 'Codex', family: true },
  agy: { label: 'Antigravity', tagLabel: 'Antigravity(agy)', short: 'Ag', models: ['argon', 'flash'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'], modelOwner: 'agy(Gemini)', family: true },
};
export const DEFAULT_ENGINE: EngineName = 'claude';
export const ENGINES = Object.keys(ENGINE_INFO) as EngineName[];
const byEngine = <T>(f: (e: EngineName) => T) => Object.fromEntries(ENGINES.map((e) => [e, f(e)])) as Record<EngineName, T>;
/** A stored engine name as an engine; anything unknown is Claude, the default. */
export const engineOf = (e: string | null | undefined): EngineName => (ENGINES as string[]).includes(e ?? '') ? e as EngineName : DEFAULT_ENGINE;
export const ENGINE_LABEL = byEngine((e) => ENGINE_INFO[e].label);
/** The engine's avatar letters in the web UI. */
export const ENGINE_SHORT = byEngine((e) => ENGINE_INFO[e].short);
/**
 * Models by alias: Claude Code resolves a Claude alias to its latest version; for Codex and agy the
 * runner picks the latest model of the family (codex.ts, agy.ts).
 */
export const ENGINE_MODELS = byEngine((e) => ENGINE_INFO[e].models);
export const ENGINE_EFFORTS = byEngine((e) => ENGINE_INFO[e].efforts);
export const MODEL_TAGS: ModelName[] = ENGINES.flatMap((e) => ENGINE_MODELS[e]);
/** Engines whose terminal sessions desk_handoff can take over (importer.ts reads their session files). */
export const HANDOFF_ENGINES = ['claude', 'codex'] as const satisfies readonly EngineName[];
export type HandoffEngine = typeof HANDOFF_ENGINES[number];

/** Each model's name, and how its tag reads in the compose box's suggestions. */
export const MODEL_INFO: Record<ModelName, { label: string; help: string }> = {
  opus: { label: 'Opus', help: 'Claude 모델을 Opus로' },
  sonnet: { label: 'Sonnet', help: 'Claude 모델을 Sonnet으로' },
  haiku: { label: 'Haiku', help: 'Claude 모델을 Haiku로' },
  sol: { label: 'Sol', help: 'Codex 모델을 Sol 계열 최신으로' },
  astra: { label: 'Astra', help: 'Codex 모델을 Astra 계열 최신으로' },
  terra: { label: 'Terra', help: 'Codex 모델을 Terra 계열 최신으로' },
  luna: { label: 'Luna', help: 'Codex 모델을 Luna 계열 최신으로' },
  argon: { label: 'Argon', help: 'agy 모델을 Gemini Argon 계열 최신으로' },
  flash: { label: 'Flash', help: 'agy 모델을 Gemini Flash 계열 최신으로' },
};
export const MODEL_LABEL = Object.fromEntries(MODEL_TAGS.map((m) => [m, MODEL_INFO[m].label])) as Record<ModelName, string>;
export const modelEngine = (m: ModelName): EngineName => ENGINES.find((e) => ENGINE_MODELS[e].includes(m))!;
/** What an engine's model tags do, for help texts: "Codex 모델 계열 고르기, 최신 버전". */
export const modelHelpOf = (e: EngineName) =>
  `${ENGINE_INFO[e].modelOwner} 모델${ENGINE_INFO[e].family ? ' 계열 고르기, 최신 버전' : ' 고르기'}`;
/** An engine's model tags as written: "#opus #sonnet #haiku". */
export const modelTagsOf = (e: EngineName) => ENGINE_MODELS[e].map((m) => `#${m}`).join(' ');
/** Effort tags only some engines take, for help texts: "#ultra는 Codex만". */
export const effortNote = () => EFFORT_TAGS.filter((t) => !ENGINES.every((e) => ENGINE_EFFORTS[e].includes(t)))
  .map((t) => `#${t}는 ${ENGINES.filter((e) => ENGINE_EFFORTS[e].includes(t)).map((e) => ENGINE_LABEL[e]).join('·')}만`).join(', ');

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
export const RESERVED_TAGS = [...Object.keys(MODE_TAGS), ...ENGINES, ...MODEL_TAGS, ...EFFORT_TAGS, ...DELIVERY_TAGS];

const EFFORT_HELP: Record<Effort, string> = {
  low: 'effort 낮게', medium: 'effort 보통', high: 'effort 높게', xhigh: 'effort 매우 높게',
  max: 'effort 최대, 지원하지 않는 모델은 high', ultra: 'Codex 전용 effort 최상',
};
/** Every built-in tag and what it does, in the order the compose box suggests them. */
export const TAG_HELP: { tag: string; help: string }[] = [
  { tag: 'auto', help: '이제부터 자동 승인' },
  { tag: 'ask', help: '이제부터 매번 확인 (기본)' },
  ...ENGINES.map((e) => ({ tag: e, help: `새 작업을 ${ENGINE_INFO[e].tagLabel}로${e === DEFAULT_ENGINE ? ' (기본)' : ''}` })),
  ...MODEL_TAGS.map((m) => ({ tag: m, help: `${MODEL_INFO[m].help} (작업에 유지)` })),
  ...EFFORT_TAGS.map((t) => ({ tag: t, help: `${EFFORT_HELP[t]} (작업에 유지)` })),
  { tag: 'later', help: '실행 중이면 지금 턴이 끝난 뒤 보내기 (기본)' },
  { tag: 'now', help: '실행 중인 턴에 바로 끼워넣기' },
  { tag: 'new', help: '같은 프로젝트에서 새 작업 시작 (이전 대화 없이)' },
  { tag: 'fork', help: '이 작업의 대화를 이어받은 새 작업으로 동시에 진행' },
];
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

/** The tool name of the approval card a desk_request (one agent asking another task's) waits on. */
export const REQUEST_TOOL = 'desk_request';

const MENTION = /(^|\s)@([^\s:@#]+)(?:#(\d+))?(?::(\S+))?/;
const TAG = /(^|\s)#([a-z0-9][a-z0-9-]*)(?=\s|$)/gi;

/** Every `@name` or `@name#N` in `text`, in order (paths dropped). */
export function mentionsIn(text: string): { name: string; no?: number }[] {
  return [...text.matchAll(new RegExp(MENTION.source, 'g'))].map((m) => ({ name: m[2], no: m[3] ? Number(m[3]) : undefined }));
}

/**
 * `skills`: names of the skills that exist; a #tag naming none of them stays as text. `route`: the
 * compose box's text, whose leading mention (only #tags before it) says where it goes and is taken
 * out; elsewhere, and in replies, mentions stay in the text the agent gets.
 */
export function parseCompose(text: string, skills: Iterable<string> = [], route = true): Composed {
  const known = new Set(skills);
  let body = text;
  let mention: Composed['mention'];
  const m = route ? MENTION.exec(body) : null;
  if (m && /^(\s*#[^\s#@]+)*\s*$/.test(body.slice(0, m.index))) {
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
    if ((ENGINES as string[]).includes(t)) { engine ??= t as EngineName; return pre; }
    if (MODE_TAGS[t]) { mode ??= MODE_TAGS[t]; return pre; }
    if ((MODEL_TAGS as string[]).includes(t)) { model ??= t as ModelName; return pre; }
    if ((EFFORT_TAGS as string[]).includes(t)) { effort ??= t as Effort; return pre; }
    if ((DELIVERY_TAGS as string[]).includes(t)) { delivery ??= t as Delivery; return pre; }
    if (known.has(t)) { if (!used.includes(t)) used.push(t); return pre; }
    return all;
  });
  return { mention, mode, engine, model, effort, delivery, skills: used, body: body.trim() };
}
