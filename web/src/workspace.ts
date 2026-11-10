export const workspaceId = typeof location === 'undefined' ? '' : /^\/shared\/([a-zA-Z0-9-]+)\/?$/.exec(location.pathname)?.[1] ?? '';
export const apiBase = workspaceId ? `/api/workspaces/${workspaceId}` : '/api';
export const workspaceKey = (key:string) => workspaceId ? `${key}.workspace.${workspaceId}` : key;
/** The hub accepted it durably; a task result does not exist until the runner receives it. */
export class SharedPending extends Error {
  constructor() { super('허브에 입력을 보관했습니다. 공유 러너에 다시 연결되면 자동 전달합니다. 상단의 전달 내역에서 확인할 수 있습니다.'); }
}
