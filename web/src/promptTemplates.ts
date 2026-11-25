import { api } from './api.ts';
import type { PromptTemplates } from '../../shared/prompt-templates.ts';
export async function promptTemplates(input?: PromptTemplates, signal?: AbortSignal, source='', operationId?:string): Promise<PromptTemplates> {
  const timeout=AbortSignal.timeout(15000);
  const data=await api.promptTemplates(source,input,signal?AbortSignal.any([signal,timeout]):timeout,operationId);
  if(typeof data.revision!=='string'||!Array.isArray(data.items))throw new Error('템플릿 응답을 확인하지 못했습니다');
  return data;
}
