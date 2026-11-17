import { EFFORT_TAGS, ENGINE_LABEL, RESERVED_TAGS, SKILL_NAME, catalogModelName, variantModelName, modelEngine, modelReference, type Effort, type EngineName, type ModelName } from './compose.ts';

/** Exact provider IDs are separate from the desk's stable alias/family tags. null means unknown. */
export interface CatalogModel { id: string; label: string; resolvedId?: string; aliases?: string[]; efforts: Effort[] | null; defaultEffort?: Effort; isDefault?: boolean }
export interface EngineModelCatalog {
  engine: EngineName; models: CatalogModel[];
  /** Last attempt and last successful reading; failure keeps the successful models. */
  checkedAt: string; updatedAt: string | null; error?: string;
}
export type ModelCatalogs = Partial<Record<EngineName, EngineModelCatalog>>;
export interface RunnerModelCatalog { runnerId: string; label: string; connected: boolean; supported?: boolean; catalogs: ModelCatalogs }
export const validModelId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._/\[\]-]{0,199}$/.test(value);

/** The wire is untrusted, including optional fields advertised by old/new remote runners. */
export function checkModelCatalogs(value: unknown): value is ModelCatalogs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([engine, raw]) => {
    const c = raw as EngineModelCatalog;
    return ['claude', 'codex', 'agy'].includes(engine) && c?.engine === engine
      && typeof c.checkedAt === 'string' && Number.isFinite(Date.parse(c.checkedAt))
      && (c.updatedAt === null || (typeof c.updatedAt === 'string' && Number.isFinite(Date.parse(c.updatedAt))))
      && (c.error === undefined || (typeof c.error === 'string' && c.error.length <= 2000))
      && Array.isArray(c.models) && c.models.length <= 1000
      && c.models.every(m => validModelId(m?.id) && typeof m.label === 'string' && m.label.length <= 500
        && (m.resolvedId === undefined || validModelId(m.resolvedId))
        && (m.aliases === undefined || (Array.isArray(m.aliases) && m.aliases.length <= 100 && m.aliases.every(validModelId)))
        && (m.efforts === null || (Array.isArray(m.efforts) && m.efforts.every(e => EFFORT_TAGS.includes(e))))
        && (m.defaultEffort === undefined || EFFORT_TAGS.includes(m.defaultEffort))
        && (m.isDefault === undefined || typeof m.isDefault === 'boolean'))
      && new Set(c.models.map(m => m.id)).size === c.models.length;
  });
}

/** Numeric versions, never provider list order, decide the latest member of a family. */
export function latestOfFamily(ids: string[], family: string): string | undefined {
  const version = (id: string) => (id.match(/\d+(?:\.\d+)*/)?.[0] ?? '0').split('.').map(Number);
  const newer = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
    return 0;
  };
  return ids.filter(id => id.endsWith(`-${family}`)).sort((a,b) => newer(version(b),version(a)) || a.localeCompare(b))[0];
}

export function catalogModel(catalog: EngineModelCatalog, choice?: ModelName, effort?: Effort): CatalogModel | undefined {
  if (!choice) return catalog.models.find(m => m.isDefault);
  if (modelEngine(choice) !== catalog.engine) return undefined;
  const reference = modelReference(choice);
  if (reference) {
    if (!reference.variants) return catalog.models.find(m => m.id === reference.id);
    const members = catalog.models.filter(m => m.id.startsWith(`${reference.id}-`));
    const supported = EFFORT_TAGS.filter(level => members.some(m => m.id === `${reference.id}-${level}`));
    const level = nearestEffort(effort ?? 'medium',supported);
    return members.find(m => m.id === `${reference.id}-${level}`);
  }
  if (catalog.engine === 'claude') return catalog.models.find(m => m.id === choice || m.aliases?.includes(choice))
    ?? catalog.models.find(m => new RegExp(`^claude-${choice}(?:-|$)`).test(m.id));
  const ids = catalog.models.map(m => m.id);
  if (catalog.engine === 'codex') return catalog.models.find(m => m.id === latestOfFamily(ids,choice));
  const base = latestOfFamily(ids.map(id => id.replace(/-(low|medium|high|xhigh|max|ultra)$/,'')),choice);
  if (!base) return undefined;
  const members = catalog.models.filter(m => m.id.startsWith(`${base}-`));
  const supported = EFFORT_TAGS.filter(level => members.some(m => m.id === `${base}-${level}`));
  const level = nearestEffort(effort ?? 'medium',supported);
  return members.find(m => m.id === `${base}-${level}`);
}

/** Legacy aliases may use old runners; an exact new reference always requires a checked catalog. */
export function catalogProblem(engine: EngineName, choice: ModelName | undefined, effort: Effort | undefined, catalog?: EngineModelCatalog): string | null {
  if (choice && modelEngine(choice) !== engine) return `${ENGINE_LABEL[engine]} 모델이 아닙니다: ${choice}`;
  if (!catalog?.updatedAt) return choice && modelReference(choice) ? `${ENGINE_LABEL[engine]} 모델 목록을 아직 확인하지 못했습니다` : null;
  const model = catalogModel(catalog, choice, effort);
  if (choice && !model) return `${ENGINE_LABEL[engine]} 모델 목록에 ${modelReference(choice)?.id ?? `#${choice}`}이 없습니다`;
  // Family tags retain their documented nearest-level compatibility. Exact IDs never change silently.
  if (effort && choice && modelReference(choice) && model?.efforts && !model.efforts.includes(effort))
    return `${model.label}에서 ${effort} effort를 지원하지 않습니다 (${model.efforts.join(', ') || 'effort 없음'})`;
  return null;
}

/** A new provider value becomes a tag only when no control, skill, or other engine owns it. */
export function catalogModelTags(catalogs: ModelCatalogs[], skills: Iterable<string> = []): Record<string, ModelName> {
  const blocked = new Set([...RESERVED_TAGS, ...skills]);
  const candidates = new Map<string,Set<ModelName>>();
  for (const list of catalogs) for (const catalog of Object.values(list)) {
    if (!catalog?.updatedAt) continue;
    for (const model of catalog.models) {
      const family = catalog.engine === 'claude' ? /^claude-([a-z][a-z0-9-]*?)-[0-9]/.exec(model.resolvedId ?? model.id)?.[1] : undefined;
      const variant = catalog.engine === 'agy'
        ? /^(gemini-\d+(?:\.\d+)*-([a-z][a-z0-9-]*?))-(?:low|medium|high|xhigh|max|ultra)$/.exec(model.id) : null;
      const tags: [string,ModelName][] = [[model.id.toLowerCase(),catalogModelName(catalog.engine,model.id)],
        ...(model.aliases ?? []).map(alias => [alias.toLowerCase(),catalogModelName(catalog.engine,model.id)] as [string,ModelName]),
        ...(family ? [[family,catalogModelName(catalog.engine,model.id)] as [string,ModelName]] : []),
        ...(variant ? [[variant[2],variantModelName(variant[1])] as [string,ModelName]] : [])];
      for (const [tag,choice] of tags) {
        if (!SKILL_NAME.test(tag) || blocked.has(tag)) continue;
        const values = candidates.get(tag) ?? new Set<ModelName>();
        values.add(choice); candidates.set(tag,values);
      }
    }
  }
  return Object.fromEntries([...candidates].flatMap(([tag,values]) => {
    // Different versions on runners of the same engine are normal. Routing reparses against its runner.
    if (new Set([...values].map(modelEngine)).size !== 1) return [];
    const sorted = [...values].sort((a,b) => {
      const parts = (v:string) => (modelReference(v)?.id.match(/\d+(?:[.-]\d+)*/)?.[0] ?? '0').split(/[.-]/).map(Number);
      const av=parts(a),bv=parts(b);
      for (let i=0;i<Math.max(av.length,bv.length);i++) if ((av[i]??0)!==(bv[i]??0)) return (bv[i]??0)-(av[i]??0);
      return a.localeCompare(b);
    });
    return [[tag,sorted[0]!]];
  }));
}

export function nearestEffort(wanted: Effort, supported: Effort[]): Effort | undefined {
  return [...supported].sort((a,b) => Math.abs(EFFORT_TAGS.indexOf(a)-EFFORT_TAGS.indexOf(wanted))
    - Math.abs(EFFORT_TAGS.indexOf(b)-EFFORT_TAGS.indexOf(wanted)) || EFFORT_TAGS.indexOf(a)-EFFORT_TAGS.indexOf(b))[0];
}
/** Legacy tags retain nearest-supported effort; exact catalog references require a supported pair. */
export function catalogEffort(catalog: EngineModelCatalog, choice?: ModelName, effort?: Effort): Effort | undefined {
  if (!effort) return undefined;
  const model = catalogModel(catalog,choice,effort);
  return model?.efforts ? nearestEffort(effort,model.efforts) : effort;
}

/** Resolve a tag against its execution runner, never another runner's newer model. */
export function catalogsForTarget(runners: RunnerModelCatalog[], target?: {runnerId?: string; rootPath?: string}): ModelCatalogs[] {
  if (target?.runnerId) return runners.filter(r=>r.runnerId===target.runnerId).map(r=>r.catalogs);
  if (target?.rootPath) {
    const address=/^([^/]+):(?:\/|~\/)/.exec(target.rootPath)?.[1];
    if (address) {
      const exact=runners.filter(r=>r.label===address);
      const matches=exact.length?exact:runners.filter(r=>r.label.split('@').at(-1)===address);
      return matches.map(r=>r.catalogs);
    }
    return runners.filter(r=>!r.runnerId.startsWith('remote-')).map(r=>r.catalogs);
  }
  return runners.map(r=>r.catalogs);
}
