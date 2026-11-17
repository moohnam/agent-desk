import { execFile, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { EFFORT_TAGS, ENGINES, type Effort, type EngineName } from '../../../shared/compose.ts';
import { validModelId, type CatalogModel, type EngineModelCatalog, type ModelCatalogs } from '../../../shared/model-catalog.ts';
import { config } from '../config.ts';

export const MODEL_CATALOG_TTL_MS = 5 * 60_000;
const RETRY_MS = 30_000;
const TIMEOUT_MS = 30_000;
type Reader = () => Promise<CatalogModel[]>;
type Json = any;
const efforts = (value: unknown): Effort[] | null => Array.isArray(value)
  ? [...new Set(value.map(v => typeof v === 'string' ? v : v?.reasoningEffort).filter((v): v is Effort => EFFORT_TAGS.includes(v)))] : null;

export function claudeCatalog(rows: Json[]): CatalogModel[] {
  const models = new Map<string,CatalogModel>();
  for (const row of rows) {
    if (!validModelId(row?.value)) continue;
    // The SDK's value may be an alias. Exact selections use its canonical wire ID, retaining context suffixes.
    const suffix = /\[[a-zA-Z0-9]+\]$/.exec(row.value)?.[0] ?? '';
    const id = validModelId(row.resolvedModel) ? row.resolvedModel + suffix : row.value;
    if (!validModelId(id)) continue;
    const previous = models.get(id);
    const aliases = [...new Set([...(previous?.aliases ?? []),...(row.value !== id ? [row.value] : [])])];
    models.set(id,{id,label:String(row.value === 'default' ? previous?.label ?? row.displayName ?? id : row.displayName ?? id),
      ...(validModelId(row.resolvedModel) ? {resolvedId:row.resolvedModel} : {}),...(aliases.length ? {aliases} : {}),
      efforts:row.supportsEffort === false ? [] : efforts(row.supportedEffortLevels),
      ...((row.value === 'default' || previous?.isDefault) ? {isDefault:true} : {})});
  }
  return [...models.values()];
}

export function codexCatalog(rows: Json[]): CatalogModel[] {
  return rows.filter(m => validModelId(m?.id)).map(m => ({id:m.id, label:String(m.displayName ?? m.id),
    efforts:efforts(m.supportedReasoningEfforts), ...(EFFORT_TAGS.includes(m.defaultReasoningEffort) ? {defaultEffort:m.defaultReasoningEffort} : {}),
    ...(m.isDefault === true ? {isDefault:true} : {})}));
}
export function agyCatalog(output: string): CatalogModel[] {
  // The CLI also exposes Claude and GPT models; the execution engine remains AGY.
  const rows = output.replace(/\x1b\[[0-9;]*m/g,'').split('\n').map(line => line.split('\t'));
  const seen = new Set<string>();
  return rows.flatMap(([rawId,rawLabel]) => {
    const id = rawId?.trim();
    if (!validModelId(id) || !id.includes('-') || seen.has(id)) return [];
    seen.add(id);
    const level = /-(low|medium|high|xhigh|max|ultra)$/.exec(id)?.[1] as Effort | undefined;
    return [{id,label:rawLabel?.trim() || id,efforts:level ? [level] : null,...(level ? {defaultEffort:level} : {})}];
  });
}

/** Pagination errors and repeated cursors fail the entire reading, preserving the last good list. */
export async function readCodexModels(request: (method:string,params:Json,timeoutMs?:number)=>Promise<Json>,deadline=Date.now()+29_000): Promise<CatalogModel[]> {
  const rows: Json[] = [], seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const remaining = deadline-Date.now();
    if (remaining <= 0) throw new Error('Codex 모델 목록 페이지 조회 시간 초과');
    const r = await request('model/list',{cursor,includeHidden:false},remaining);
    if (!Array.isArray(r?.data)) throw new Error('Codex 모델 목록 형식이 잘못되었습니다');
    rows.push(...r.data);
    cursor = r.nextCursor ?? null;
    if (cursor !== null && (typeof cursor !== 'string' || seen.has(cursor) || seen.size >= 100)) throw new Error('Codex 모델 목록 페이지가 반복되었습니다');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return codexCatalog(rows);
}
function timeout<T>(promise:Promise<T>, engine:string, timeoutMs=TIMEOUT_MS):Promise<T> {
  return new Promise((resolve,reject) => {
    const timer=setTimeout(()=>reject(new Error(`${engine} 모델 조회 시간 초과`)),timeoutMs);
    promise.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});
  });
}
async function readClaude():Promise<CatalogModel[]> {
  const idle:AsyncIterable<never> = {[Symbol.asyncIterator]:()=>({next:()=>new Promise(()=>{})})};
  const q=query({prompt:idle,options:{cwd:tmpdir(),settingSources:[],tools:[]}});
  try { return claudeCatalog(await timeout(q.supportedModels(),'Claude')); } finally {q.close();}
}
function readCodex():Promise<CatalogModel[]> {
  const child=spawn(config.codexBin,['app-server'],{stdio:['pipe','pipe','ignore'],cwd:tmpdir()});
  const calls=new Map<number,{resolve:(v:Json)=>void;reject:(e:Error)=>void}>();
  let id=0;
  const request=(method:string,params:Json)=>new Promise<Json>((resolve,reject)=>{
    calls.set(++id,{resolve,reject});child.stdin.write(JSON.stringify({id,method,params})+'\n');
  });
  const fail=(error:Error)=>{for(const c of calls.values())c.reject(error);calls.clear();};
  child.on('error',fail); child.on('exit',()=>fail(new Error('Codex 모델 조회 프로세스 종료')));
  child.stdin.on('error',fail);
  createInterface({input:child.stdout}).on('line',line=>{
    let m:Json;try{m=JSON.parse(line);}catch{return;}
    const c=m.method===undefined?calls.get(m.id):undefined;if(!c)return;calls.delete(m.id);
    if(m.error)c.reject(new Error(m.error.message??'Codex 모델 조회 실패'));else c.resolve(m.result);
  });
  return timeout((async()=>{
    await request('initialize',{clientInfo:{name:'agent-desk',title:'Agent Desk',version:'0.1.0'},capabilities:{experimentalApi:false,requestAttestation:false}});
    child.stdin.write(JSON.stringify({method:'initialized'})+'\n');return readCodexModels(request);
  })(),'Codex').finally(()=>child.kill());
}
function readAgy():Promise<CatalogModel[]> {
  return new Promise((resolve,reject)=>execFile(config.agyBin,['models'],{cwd:tmpdir(),timeout:TIMEOUT_MS,maxBuffer:1024*1024},(error,stdout)=>{
    if(error)reject(error);else resolve(agyCatalog(stdout));
  }));
}

/** Per-process runner cache: bounded retries, coalesced reads, last success on refresh failure. */
export class ModelCatalogCache {
  private values:ModelCatalogs={};
  private flights=new Map<EngineName,Promise<EngineModelCatalog>>();
  private readers: Record<EngineName,Reader>;
  private now: () => number;
  private ttl: number;
  private timeoutMs: number;
  constructor(readers:Record<EngineName,Reader>,now:()=>number=Date.now,ttl=MODEL_CATALOG_TTL_MS,timeoutMs=TIMEOUT_MS) {
    this.readers=readers;this.now=now;this.ttl=ttl;this.timeoutMs=timeoutMs;
  }
  snapshot():ModelCatalogs {return structuredClone(this.values);}
  read(engine:EngineName,force=false,reader?:Reader):Promise<EngineModelCatalog> {
    const flight=this.flights.get(engine);if(flight)return flight;
    const old=this.values[engine],now=this.now();
    if(!force&&old&&now-Date.parse(old.checkedAt)<(old.error?RETRY_MS:this.ttl))return Promise.resolve(structuredClone(old));
    const checkedAt=new Date(now).toISOString();
    const promise=timeout(Promise.resolve().then(reader??this.readers[engine]),engine,this.timeoutMs).then(models=>{
      if(!models.length||new Set(models.map(m=>m.id)).size!==models.length)throw new Error('비어 있거나 중복된 모델 목록입니다');
      const result:EngineModelCatalog={engine,models,checkedAt,updatedAt:checkedAt};this.values[engine]=result;return structuredClone(result);
    }).catch(error=>{
      const result:EngineModelCatalog={engine,models:old?.models??[],updatedAt:old?.updatedAt??null,checkedAt,
        error:(error instanceof Error?error.message:String(error)).slice(0,2000)};this.values[engine]=result;return structuredClone(result);
    }).finally(()=>this.flights.delete(engine));
    this.flights.set(engine,promise);return promise;
  }
  async refresh(force=false) {await Promise.all(ENGINES.map(engine=>this.read(engine,force)));return this.snapshot();}
}
export const runnerModelCatalogs=new ModelCatalogCache({claude:readClaude,codex:readCodex,agy:readAgy});
