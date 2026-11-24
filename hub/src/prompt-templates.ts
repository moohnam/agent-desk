import { randomUUID } from 'node:crypto';
import type { Store } from './db.ts';
import { HttpError } from './errors.ts';
import type { PromptTemplates } from '../../shared/prompt-templates.ts';
const KEY = 'prompt_templates';
// A full list can contain 1.6 million UTF-16 code units, each up to six JSON bytes.
export const MAX_PROMPT_TEMPLATES_BODY = 10 * 1024 * 1024;
export function readPromptTemplates(store: Store): PromptTemplates {
  const raw = store.setting(KEY);
  return raw ? JSON.parse(raw) : {revision:'initial',items:[]};
}
export function savePromptTemplates(store: Store, input: unknown): PromptTemplates {
  const value=input as PromptTemplates;
  if (!value || typeof value.revision!=='string' || !Array.isArray(value.items) || value.items.length>100)
    throw new HttpError(400,'템플릿 목록과 버전이 필요합니다 (최대 100개)');
  const ids=new Set<string>();
  const items=value.items.map(item=>{
    if(!item || typeof item.id!=='string' || !/^[a-zA-Z0-9-]{1,80}$/.test(item.id) || ids.has(item.id) ||
      typeof item.name!=='string' || !item.name.trim() || item.name.length>100 ||
      typeof item.text!=='string' || !item.text.trim() || item.text.length>16000)
      throw new HttpError(400,'템플릿 이름은 1~100자, 내용은 1~16000자이며 ID는 중복될 수 없습니다');
    ids.add(item.id);return {id:item.id,name:item.name.trim(),text:item.text};
  });
  if(value.revision!==readPromptTemplates(store).revision)
    throw new HttpError(409,'다른 화면에서 템플릿을 수정했습니다. 작성 내용을 복사한 뒤 최신 목록을 다시 불러오세요');
  const saved={revision:randomUUID(),items};
  store.setSetting(KEY,JSON.stringify(saved));
  return saved;
}
