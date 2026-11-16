import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { auth, discoverOAuthServerInfo, refreshAuthorization, selectResourceURL, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { InvalidClientError, InvalidGrantError, UnauthorizedClientError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ConnectorVault, readConnectorSecret } from './connector-vault.ts';
import { HttpError } from './errors.ts';

export type ConnectorService = 'slack' | 'jira';
const SERVICES: ConnectorService[] = ['slack', 'jira'];
// No arbitrary remote endpoints or write scopes. DM access is deliberately opt-in in a future phase.
export const CONNECTOR_PROVIDERS = {
  slack: {
    endpoint: 'https://mcp.slack.com/mcp',
    hosts: ['mcp.slack.com', 'slack.com'],
    scope: 'search:read.public search:read.private channels:history groups:history channels:read groups:read',
  },
  jira: {
    endpoint: 'https://mcp.atlassian.com/v2/mcp?tools=all',
    hosts: ['mcp.atlassian.com', 'auth.atlassian.com'],
    scope: 'read:me read:account read:jira:agent-interface search:jira:agent-interface read:confluence:agent-interface search:confluence:agent-interface offline_access',
  },
} as const;
const ATLASSIAN_READ = new Set(['atlassianUserInfo', 'getAccessibleAtlassianResources', 'getJiraIssue',
  'searchJiraIssuesUsingJql', 'listJiraProjects', 'listJiraIssueComments', 'listJiraIssueChangelogs',
  'searchConfluence', 'getConfluenceContent', 'listConfluenceContent', 'listConfluenceSpaces',
  'getConfluenceSpace', 'listConfluenceComments']);
// Only allow named read operations, never a generic execute/proxy tool, even if it claims readOnlyHint.
const SLACK_READ = new Set(['slack_search_all', 'slack_search_messages', 'slack_search_channels',
  'slack_read_channel', 'slack_read_thread']);
export const connectorReadTool = (service: ConnectorService, tool: Tool) =>
  (service === 'jira' ? ATLASSIAN_READ : SLACK_READ).has(tool.name)
  && tool.annotations?.readOnlyHint !== false;
export const connectorReadToolNames = (service: ConnectorService): string[] => [...(service === 'jira' ? ATLASSIAN_READ : SLACK_READ)];

interface Credential {
  client?: OAuthClientInformationMixed;
  registeredScope?: string;
  tokens?: OAuthTokens;
  expiresAt?: number;
  connectedAt?: string;
  generation?: string;
  redirectUrl: string;
}
type Credentials = Partial<Record<ConnectorService, Credential>>;
interface Pending { state: string; expires: number; verifier?: string; url?: string; credential: Credential }
export interface ConnectorOptions {
  directory: string;
  slackClientId?: string;
  slackClientSecret?: string;
  slackClientFile?: string;
  fetch?: typeof fetch;
}
const TTL = 10 * 60_000;
const LIMIT = 2 * 1024 * 1024;

/** Initial foundation: one local-owner connection per service. No runner/peer access or tool injection. */
export class Connectors {
  private vault: ConnectorVault<Credentials>;
  private saved?: Credentials;
  private pending = new Map<ConnectorService, Pending>();
  private active = new Map<ConnectorService, AbortController>();
  private options: ConnectorOptions;
  private closed = false;
  private storageFailed = false;
  constructor(options: ConnectorOptions) {
    this.options = options;
    this.vault = new ConnectorVault(options.directory);
  }

  private credentials() {
    if (this.storageFailed) throw new HttpError(503, '인증정보 저장에 실패했습니다. 저장소를 복구하고 허브를 재시작한 뒤 다시 연결하세요');
    try { return this.saved ??= this.vault.read() ?? {}; }
    catch { throw new HttpError(503, '외부 연결 인증 저장소를 읽지 못했습니다. 파일 권한과 암호화 키를 확인하세요'); }
  }
  private persist(saved: Credentials) {
    try { this.vault.write(saved); }
    catch {
      this.storageFailed = true;
      throw new HttpError(503, '인증정보 저장에 실패했습니다. 저장소를 복구하고 허브를 재시작한 뒤 다시 연결하세요');
    }
  }
  private slackClient() {
    if (this.options.slackClientFile) {
      try {
        const value = JSON.parse(readConnectorSecret(this.options.slackClientFile).toString('utf8'));
        if (typeof value.client_id !== 'string' || !value.client_id || typeof value.client_secret !== 'string' || !value.client_secret) throw Error();
        return { client_id: value.client_id as string, client_secret: value.client_secret as string };
      } catch { throw new HttpError(409, 'Slack 앱 인증 파일의 형식·소유자·권한을 확인하세요 (client_id, client_secret, 권한 600)'); }
    }
    if (this.options.slackClientId && this.options.slackClientSecret)
      return { client_id: this.options.slackClientId, client_secret: this.options.slackClientSecret };
  }
  private prune() {
    for (const [service, pending] of this.pending) if (pending.expires <= Date.now()) this.pending.delete(service);
  }
  list() {
    this.prune();
    return SERVICES.map(service => {
      const saved = this.credentials()[service];
      return { service, configured: service !== 'slack' || !!this.slackClient(),
        status: this.pending.has(service) ? 'authorizing' : saved?.tokens ? 'connected' : 'disconnected',
        connected_at: saved?.connectedAt, expires_at: saved?.expiresAt,
        scopes: CONNECTOR_PROVIDERS[service].scope.split(' ') };
    });
  }

  /** Non-secret account identities. Refresh keeps the generation; a new consent replaces it. */
  connections(): { service: ConnectorService; generation: string }[] {
    const saved = this.credentials();
    const legacy = SERVICES.filter(service => saved[service]?.tokens && !saved[service]?.generation);
    if (legacy.length) {
      const next = { ...saved };
      for (const service of legacy) next[service] = { ...saved[service]!, generation: randomUUID() };
      this.persist(next);
      // Keep credential identity stable for any in-flight refresh.
      for (const service of legacy) saved[service]!.generation = next[service]!.generation;
    }
    return SERVICES.filter(service => saved[service]?.tokens)
      .map(service => ({ service, generation: saved[service]!.generation! }));
  }

  private network(service: ConnectorService, controller: AbortController): typeof fetch {
    return async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.protocol !== 'https:' || url.port || url.username || url.password
        || !(CONNECTOR_PROVIDERS[service].hosts as readonly string[]).includes(url.hostname))
        throw new HttpError(502, '공식 서비스 이외의 인증·조회 주소는 허용하지 않습니다');
      const response = await (this.options.fetch ?? fetch)(input, { ...init, redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45_000), ...(init?.signal ? [init.signal] : [])]) });
      if (response.status === 429) {
        await response.body?.cancel();
        throw new HttpError(429, '외부 서비스의 요청 한도에 도달했습니다. 잠시 뒤 다시 시도하세요');
      }
      if (Number(response.headers.get('content-length')) > LIMIT) {
        await response.body?.cancel();
        throw new HttpError(502, '외부 서비스 응답이 너무 큽니다');
      }
      let size = 0;
      const body = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, out) {
          size += chunk.byteLength;
          if (size > LIMIT) throw new HttpError(502, '외부 서비스 응답이 너무 큽니다');
          out.enqueue(chunk);
        },
      }));
      const bounded = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      if (service === 'slack' && url.pathname === '/api/oauth.v2.user.access' && response.ok) {
        // Slack can report comma-separated user scopes in authed_user, which the SDK schema strips.
        const value = await bounded.json() as Record<string, any>;
        if (value.ok === false) {
          if (['invalid_refresh_token', 'invalid_code', 'bad_code_verifier'].includes(value.error))
            throw new InvalidGrantError('Slack 인증이 만료되거나 취소되었습니다');
          if (['invalid_client_id', 'bad_client_secret', 'invalid_client', 'invalid_client_secret'].includes(value.error))
            throw new InvalidClientError('Slack 앱 인증을 확인하세요');
          if (value.error === 'unauthorized_client') throw new UnauthorizedClientError('Slack 앱 사용 승인이 필요합니다');
          if (value.error === 'ratelimited') throw new HttpError(429, 'Slack 요청 한도에 도달했습니다. 잠시 뒤 다시 시도하세요');
          throw new HttpError(502, 'Slack 인증 요청을 처리하지 못했습니다. 앱 설정이나 서비스 상태를 확인하세요');
        }
        const scopes = [value.scope, value.authed_user?.scope].filter(scope => typeof scope === 'string') as string[];
        if (scopes.length) value.scope = [...new Set(scopes.flatMap(scope => scope.split(/[\s,]+/).filter(Boolean)))].join(' ');
        const headers = new Headers(response.headers);
        headers.delete('content-length'); headers.delete('content-encoding'); headers.set('content-type', 'application/json');
        return new Response(JSON.stringify(value), { status: response.status, headers });
      }
      return bounded;
    };
  }

  private provider(service: ConnectorService, credential: Credential, controller: AbortController, pending?: Pending): OAuthClientProvider {
    const check = () => {
      controller.signal.throwIfAborted();
      if (pending && (this.pending.get(service) !== pending || pending.expires <= Date.now()))
        throw new HttpError(409, '로그인 요청이 만료되었거나 취소되었습니다');
      if (!pending && this.credentials()[service] !== credential) throw new HttpError(409, '연결이 해제되었습니다');
    };
    const update = (change: (next: Credential) => void) => {
      check(); const next = { ...credential }; change(next);
      if (!pending) this.persist({ ...this.credentials(), [service]: next });
      // Preserve the object identity used to invalidate in-flight requests on replacement.
      for (const key of Object.keys(credential)) delete credential[key as keyof Credential];
      Object.assign(credential, next);
    };
    return {
      redirectUrl: credential.redirectUrl,
      clientMetadata: { client_name: 'Agent Desk', redirect_uris: [credential.redirectUrl],
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
        token_endpoint_auth_method: service === 'slack' ? 'client_secret_post' : 'none', scope: CONNECTOR_PROVIDERS[service].scope },
      state: () => { check(); if (!pending) throw new HttpError(409, '서비스에 다시 로그인해야 합니다'); return pending.state; },
      clientInformation: () => credential.client,
      saveClientInformation: client => update(next => { next.client = client; next.registeredScope = CONNECTOR_PROVIDERS[service].scope; }),
      tokens: () => credential.tokens,
      saveTokens: tokens => {
        check();
        // Reject an unexpected upscope rather than exposing new privileges through this connection.
        const allowed = new Set(CONNECTOR_PROVIDERS[service].scope.split(' '));
        const scope = tokens.scope ?? credential.tokens?.scope;
        if (!scope?.trim()) throw new HttpError(403, '승인된 읽기 권한을 확인하지 못했습니다. 다시 연결하세요');
        if (scope.split(/\s+/).filter(Boolean).some(scope => !allowed.has(scope)))
          throw new HttpError(403, '요청하지 않은 권한이 반환되었습니다. 읽기 권한으로 다시 연결하세요');
        update(next => {
          next.tokens = { ...tokens, scope };
          next.expiresAt = tokens.expires_in == null ? undefined : Date.now() + tokens.expires_in * 1000;
        });
      },
      redirectToAuthorization: url => {
        check();
        if (!pending) throw new HttpError(409, '서비스에 다시 로그인해야 합니다');
        const expected = service === 'slack' ? ['https://slack.com/oauth/v2_user/authorize']
          : ['https://mcp.atlassian.com/v1/authorize', 'https://auth.atlassian.com/authorize'];
        if (!expected.includes(url.origin + url.pathname)) throw new HttpError(502, '공식 로그인 주소가 아닙니다');
        pending.url = url.href;
      },
      saveCodeVerifier: verifier => { check(); if (!pending) throw new HttpError(409, '서비스에 다시 로그인해야 합니다'); pending.verifier = verifier; },
      codeVerifier: () => { check(); if (!pending?.verifier) throw new HttpError(400, '로그인을 다시 시작하세요'); return pending.verifier; },
      invalidateCredentials: scope => update(next => {
        if (scope === 'all' || scope === 'tokens') { delete next.tokens; delete next.expiresAt; }
        if ((scope === 'all' || scope === 'client') && service !== 'slack') delete next.client;
      }),
    };
  }

  private async run<T>(service: ConnectorService, fn: (controller: AbortController) => Promise<T>): Promise<T> {
    if (this.closed) throw new HttpError(503, '허브가 종료 중입니다');
    this.credentials();
    if (this.active.has(service)) throw new HttpError(409, '이 서비스의 연결 요청을 처리하고 있습니다');
    const controller = new AbortController();
    this.active.set(service, controller);
    const deadline = setTimeout(() => controller.abort(), 60_000);
    try { const result = await fn(controller); controller.signal.throwIfAborted(); return result; }
    catch (error) {
      if (controller.signal.aborted) throw new HttpError(409, '외부 연결 요청이 취소되었거나 시간이 초과되었습니다');
      if (error instanceof HttpError) throw error;
      // Provider errors can contain token bodies, query data, or callback codes. Never echo them.
      throw new HttpError(502, '외부 서비스 연결에 실패했습니다. 앱 설정·권한·로그인 상태를 확인하세요');
    } finally {
      clearTimeout(deadline);
      if (this.active.get(service) === controller) this.active.delete(service);
    }
  }

  async begin(service: ConnectorService, origin: string) {
    const url = new URL(origin);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
      throw new HttpError(400, '첫 연결은 허브 머신의 localhost 주소에서 시작하세요');
    const slack = service === 'slack' ? this.slackClient() : undefined;
    if (service === 'slack' && !slack)
      throw new HttpError(409, 'AGENT_DESK_SLACK_CLIENT_FILE에 Slack 앱 인증 파일 경로를 설정하세요');
    return this.run(service, async controller => {
      const previous = this.credentials()[service];
      const redirectUrl = `${url.origin}/api/connectors/${service}/callback`;
      const reusable = previous?.redirectUrl === redirectUrl && previous?.registeredScope === CONNECTOR_PROVIDERS[service].scope;
      const credential: Credential = { redirectUrl,
        client: service === 'slack' ? { ...slack!, issuer: 'https://mcp.slack.com' }
          : reusable ? previous?.client : undefined,
        ...(reusable ? { registeredScope: previous?.registeredScope } : {}) };
      const pending: Pending = { state: randomBytes(32).toString('base64url'), expires: Date.now() + TTL, credential };
      this.pending.set(service, pending);
      try {
        await auth(this.provider(service, credential, controller, pending), { serverUrl: CONNECTOR_PROVIDERS[service].endpoint,
          scope: CONNECTOR_PROVIDERS[service].scope, fetchFn: this.network(service, controller) });
        if (!pending.url) throw new HttpError(502, '로그인 주소를 받지 못했습니다');
        return { authorization_url: pending.url, redirect_uri: credential.redirectUrl, expires_at: pending.expires };
      } catch (error) { if (this.pending.get(service) === pending) this.pending.delete(service); throw error; }
    });
  }

  async finish(service: ConnectorService, state: string, code: string, denied = false) {
    this.prune();
    const pending = this.pending.get(service);
    if (!pending || !state || pending.state !== state) throw new HttpError(400, '로그인 요청이 만료되었거나 일치하지 않습니다');
    if (denied) { this.pending.delete(service); throw new HttpError(400, '서비스 로그인이 취소되었습니다'); }
    if (!code || code.length > 4096) throw new HttpError(400, '인증 코드가 필요합니다');
    return this.run(service, async controller => {
      try {
        const result = await auth(this.provider(service, pending.credential, controller, pending), {
          serverUrl: CONNECTOR_PROVIDERS[service].endpoint, scope: CONNECTOR_PROVIDERS[service].scope,
          authorizationCode: code, fetchFn: this.network(service, controller),
        });
        controller.signal.throwIfAborted();
        if (result !== 'AUTHORIZED' || !pending.credential.tokens) throw new HttpError(502, '로그인을 완료하지 못했습니다');
        const saved = { ...this.credentials(), [service]: { ...pending.credential, connectedAt: new Date().toISOString(), generation: randomUUID() } };
        this.persist(saved);
        this.saved = saved;
        return { connected: true };
      } finally { if (this.pending.get(service) === pending) this.pending.delete(service); }
    });
  }

  disconnect(service: ConnectorService) {
    this.pending.delete(service);
    this.active.get(service)?.abort();
    const saved = { ...this.credentials() };
    delete saved[service];
    this.persist(saved);
    this.saved = saved;
    // Local erasure is immediate. Provider-wide app revocation is a separate user action.
    return { disconnected: true, provider_revoked: false };
  }

  private async session<T>(service: ConnectorService, use: (client: Client) => Promise<T>) {
    return this.run(service, async controller => {
      const credential = this.credentials()[service];
      if (!credential?.tokens) throw new HttpError(409, '먼저 서비스를 연결하세요');
      const refresh = async () => {
        const provider = this.provider(service, credential, controller), fetchFn = this.network(service, controller);
        if (!credential.tokens?.refresh_token) {
          await provider.invalidateCredentials?.('tokens');
          throw new HttpError(409, '서비스에 다시 로그인해야 합니다');
        }
        const info = await discoverOAuthServerInfo(CONNECTOR_PROVIDERS[service].endpoint, { fetchFn });
        const issuer = info.authorizationServerUrl;
        if (!credential.client || credential.client.issuer !== issuer || credential.tokens.issuer !== issuer)
          throw new HttpError(409, '인증 서버가 기존 연결과 일치하지 않습니다. 다시 연결하세요');
        const resource = await selectResourceURL(CONNECTOR_PROVIDERS[service].endpoint, provider, info.resourceMetadata);
        try {
          const tokens = await refreshAuthorization(issuer, { metadata: info.authorizationServerMetadata,
            clientInformation: credential.client, refreshToken: credential.tokens.refresh_token,
            resource: resource && (info.resourceMetadata?.resource ?? resource), fetchFn });
          await provider.saveTokens({ ...tokens, issuer });
        } catch (error) {
          if (error instanceof InvalidGrantError || error instanceof InvalidClientError || error instanceof UnauthorizedClientError) {
            await provider.invalidateCredentials?.(error instanceof InvalidClientError ? 'all' : 'tokens');
            throw new HttpError(409, '서비스 인증이 만료되거나 취소되었습니다. 다시 연결하세요');
          }
          throw error;
        }
      };
      let refreshed = false;
      if (credential.expiresAt != null && credential.expiresAt <= Date.now() + 30_000) { await refresh(); refreshed = true; }
      for (;;) {
        const client = new Client({ name: 'agent-desk-connectors', version: '1.0.0' });
        const transport = new StreamableHTTPClientTransport(new URL(CONNECTOR_PROVIDERS[service].endpoint), {
          requestInit: { headers: { Authorization: `Bearer ${credential.tokens!.access_token}` } },
          fetch: this.network(service, controller), reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
        });
        const abort = () => { void client.close().catch(() => {}); };
        controller.signal.addEventListener('abort', abort, { once: true });
        try {
          await client.connect(transport);
          const result = await use(client);
          controller.signal.throwIfAborted();
          if (this.credentials()[service] !== credential) throw new HttpError(409, '연결이 해제되었습니다');
          return result;
        } catch (error) {
          if (!(error instanceof StreamableHTTPError && error.code === 401 && !refreshed)) throw error;
        } finally {
          controller.signal.removeEventListener('abort', abort);
          if (!controller.signal.aborted) await transport.terminateSession().catch(() => {});
          await client.close().catch(() => {});
        }
        await refresh(); refreshed = true;
      }
    });
  }

  private async catalog(service: ConnectorService, client: Client) {
    const tools: Tool[] = [], cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...result.tools.filter(tool => connectorReadTool(service, tool)));
      cursor = result.nextCursor;
      if (!cursor) return tools;
      if (cursors.has(cursor)) break;
      cursors.add(cursor);
    }
    throw new HttpError(502, '외부 도구 목록을 끝까지 확인하지 못했습니다');
  }

  tools(service: ConnectorService) { return this.session(service, client => this.catalog(service, client)); }
  read(service: ConnectorService, name: string, args: Record<string, unknown>) {
    if (!connectorReadTool(service, { name, inputSchema: { type: 'object' } }))
      throw new HttpError(403, '허용된 읽기 도구만 사용할 수 있습니다');
    return this.session(service, async client => {
      const tools = await this.catalog(service, client);
      if (!tools.some(tool => tool.name === name)) throw new HttpError(403, '현재 계정에서 사용할 수 없는 읽기 도구입니다');
      const result = await client.callTool({ name, arguments: args });
      return { service, tool: name, retrieved_at: new Date().toISOString(), result };
    });
  }

  close() { this.closed = true; this.pending.clear(); for (const controller of this.active.values()) controller.abort(); }
}
