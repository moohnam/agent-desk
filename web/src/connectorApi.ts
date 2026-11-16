export type ConnectorService = 'slack' | 'jira';
export interface ConnectorStatus {
  service: ConnectorService;
  configured: boolean;
  status: 'authorizing' | 'connected' | 'disconnected';
  connected_at?: string;
  expires_at?: number;
  scopes: string[];
}
export interface ConnectorTool { name: string; description?: string }
export interface ConnectorAuthorization { authorization_url: string; expires_at: number }

const loginAddresses = {
  slack: ['https://slack.com/oauth/v2_user/authorize'],
  jira: ['https://mcp.atlassian.com/v1/authorize', 'https://auth.atlassian.com/authorize'],
};

export function validAuthorizationUrl(service: ConnectorService, value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash
      && loginAddresses[service].includes(url.origin + url.pathname);
  } catch { return false; }
}

// Connections belong to this local hub, never to a federated task source.
async function request(path: string, signal: AbortSignal, method = 'GET'): Promise<unknown> {
  const response = await fetch('/api/connectors' + path, {
    method, signal, mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(typeof value?.error === 'string' ? value.error : `연결 요청 실패 (HTTP ${response.status})`);
  return value;
}

export const connectorApi = {
  async list(signal: AbortSignal): Promise<ConnectorStatus[]> {
    const value = await request('', signal);
    if (!Array.isArray(value) || value.length !== 2 || !['slack', 'jira'].every(service =>
      value.filter(item => item?.service === service).length === 1)
      || !value.every(item => typeof item.configured === 'boolean'
        && ['authorizing', 'connected', 'disconnected'].includes(item.status)
        && Array.isArray(item.scopes) && item.scopes.every((scope: unknown) => typeof scope === 'string')))
      throw new Error('연결 상태 응답을 확인하지 못했습니다. 다시 조회하세요.');
    return value;
  },
  async connect(service: ConnectorService, signal: AbortSignal): Promise<ConnectorAuthorization> {
    const value = await request(`/${service}/connect`, signal, 'POST') as Partial<ConnectorAuthorization> | null;
    if (!validAuthorizationUrl(service, value?.authorization_url) || typeof value?.expires_at !== 'number'
      || !Number.isFinite(value.expires_at) || value.expires_at <= Date.now())
      throw new Error('유효한 공식 승인 주소를 받지 못했습니다. 연결을 다시 시작하세요.');
    return value as ConnectorAuthorization;
  },
  async disconnect(service: ConnectorService, signal: AbortSignal): Promise<void> {
    const value = await request(`/${service}`, signal, 'DELETE') as { disconnected?: boolean } | null;
    if (value?.disconnected !== true) throw new Error('연결 해제 결과를 확인하지 못했습니다. 상태를 다시 조회하세요.');
  },
  async tools(service: ConnectorService, signal: AbortSignal): Promise<ConnectorTool[]> {
    const value = await request(`/${service}/tools`, signal);
    if (!Array.isArray(value) || !value.every(tool => tool && typeof tool.name === 'string'
      && (tool.description === undefined || typeof tool.description === 'string')))
      throw new Error('도구 목록 응답을 확인하지 못했습니다. 다시 조회하세요.');
    return value;
  },
};
