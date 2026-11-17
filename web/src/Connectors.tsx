import { useSettingsPanel } from './settingsPanel.tsx';
import { useEffect, useRef, useState } from 'react';
import { connectorApi, type ConnectorAuthorization, type ConnectorService, type ConnectorStatus, type ConnectorTool } from './connectorApi.ts';

const names = { slack: 'Slack', jira: 'Jira · Confluence' };
const statusLabels = { authorizing: '승인 대기', connected: '연결됨', disconnected: '연결 안 됨' };
type Details = { authorization?: ConnectorAuthorization; tools?: ConnectorTool[]; error?: string; notice?: string };
type Session = {
  alive: boolean;
  visible: boolean;
  busy: boolean;
  request?: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  items: ConnectorStatus[];
};
const message = (error: unknown) => error instanceof Error ? error.message : '요청을 처리하지 못했습니다. 다시 시도하세요.';
const dateLabel = (value: string | number) => new Date(value).toLocaleString();

export function ConnectorsPanel({ local }: { local: boolean }) {
  return <section className="form" aria-label="외부 서비스 연결">
    <h3>외부 서비스 연결</h3>
    {local ? <LocalConnectors /> : <p className="muted small">외부 서비스 연결은 허브가 실행 중인 기기의 localhost 화면에서 관리하세요.</p>}
  </section>;
}

function LocalConnectors() {
  const [items, setItems] = useState<ConnectorStatus[]>([]);
  const [details, setDetails] = useState<Partial<Record<ConnectorService, Details>>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<ConnectorService>();
  const [error, setError] = useState('');
  const panel = useSettingsPanel(false, !!busy);
  const session = useRef<Session | null>(null);

  function stopRequest(context: Session) {
    clearTimeout(context.timer);
    context.request?.abort();
    const controller = new AbortController();
    context.request = controller;
    return controller;
  }
  const current = (context: Session, controller: AbortController) => context.alive && context.request === controller && !controller.signal.aborted;

  async function refresh(context: Session) {
    if (!context.alive || !context.visible || context.busy) return;
    const controller = stopRequest(context);
    setLoading(true);
    try {
      const next = await connectorApi.list(controller.signal);
      if (!current(context, controller)) return;
      const previous = context.items;
      context.items = next;
      setItems(next);
      setError('');
      setDetails(old => Object.fromEntries(next.map(item => {
        const info = old[item.service] ?? {};
        return [item.service, { ...info,
          authorization: item.status === 'authorizing' && (info.authorization?.expires_at ?? 0) > Date.now() ? info.authorization : undefined,
          tools: item.status === 'connected' && previous.find(p => p.service === item.service)?.connected_at === item.connected_at ? info.tools : undefined,
        }];
      })));
    } catch (cause) {
      if (current(context, controller)) setError(message(cause));
    } finally {
      if (current(context, controller)) {
        setLoading(false);
        if (context.visible && context.items.some(item => item.status === 'authorizing'))
          context.timer = setTimeout(() => { void refresh(context); }, 3000);
      }
    }
  }

  useEffect(() => {
    const context: Session = { alive: true, visible: panel.active, busy: false, items: [] };
    session.current = context;
    return () => { context.alive = false; context.request?.abort(); clearTimeout(context.timer); };
  }, []);
  useEffect(() => {
    const context = session.current;
    if (!context) return;
    context.visible = panel.active;
    if (panel.active) void refresh(context);
    else { clearTimeout(context.timer); if (!context.busy) context.request?.abort(); }
  }, [panel.active]);

  async function act(item: ConnectorStatus, action: 'connect' | 'disconnect' | 'tools') {
    const context = session.current;
    if (!context?.alive || context.busy) return;
    if (action === 'disconnect' && !window.confirm(`${names[item.service]}의 승인 대기와 이 허브에 저장된 연결을 모두 해제할까요? 서비스 자체의 앱 권한은 별도로 철회해야 합니다.`)) return;
    context.busy = true;
    const controller = stopRequest(context);
    setLoading(false);
    setBusy(item.service);
    setDetails(old => ({ ...old, [item.service]: {} }));
    try {
      let result: Details;
      if (action === 'connect') result = { authorization: await connectorApi.connect(item.service, controller.signal) };
      else if (action === 'tools') result = { tools: await connectorApi.tools(item.service, controller.signal) };
      else {
        await connectorApi.disconnect(item.service, controller.signal);
        result = { notice: '이 허브의 연결과 승인 대기를 해제했습니다. 서비스 자체의 앱 권한은 유지됩니다.' };
      }
      if (current(context, controller)) {
        setDetails(old => ({ ...old, [item.service]: result }));
        // Keep polling after a successful begin even if the first status refresh fails.
        if (action === 'connect') {
          context.items = context.items.map(entry => entry.service === item.service ? { ...entry, status: 'authorizing' } : entry);
          setItems(context.items);
        }
      }
    } catch (cause) {
      if (current(context, controller)) setDetails(old => ({ ...old, [item.service]: { error: message(cause) } }));
    } finally {
      if (current(context, controller)) {
        context.busy = false;
        setBusy(undefined);
        void refresh(context);
      }
    }
  }

  return <>
    <p className="small muted">검색과 읽기 권한으로 연결합니다. 이 허브에서 보낸 입력은 최신 러너의 Codex·Claude 대화에서 연결을 사용할 수 있습니다. 계정 인증정보는 허브에만 보관합니다.</p>
    <div className="row">
      <button type="button" className="btn" disabled={loading || !!busy} onClick={() => { if (session.current) void refresh(session.current); }}>상태 새로고침</button>
      {loading && <span className="small muted" role="status">상태 확인 중…</span>}
    </div>
    {error && <p className="error" role="alert">상태 조회 실패: {error}{items.length > 0 && ' 아래 상태는 마지막으로 확인한 결과입니다.'}</p>}
    {items.map(item => {
      const info = details[item.service] ?? {};
      const authorization = info.authorization && info.authorization.expires_at > Date.now() ? info.authorization : undefined;
      return <fieldset className="field-group" key={item.service}>
        <legend>{names[item.service]}</legend>
        <p className="small" role="status">{statusLabels[item.status]}{!item.configured && ' · 앱 설정 필요'}</p>
        {item.connected_at && <p className="small muted">연결 시각: {dateLabel(item.connected_at)}</p>}
        {item.expires_at != null && <p className="small muted">현재 인증 만료 시각: {dateLabel(item.expires_at)} · 조회 시 자동 갱신을 시도합니다.</p>}
        <details><summary className="small">요청 권한</summary><ul className="small">{item.scopes.map(scope => <li key={scope}><code>{scope}</code></li>)}</ul></details>
        {!item.configured && <p className="small muted">허브 관리자에게 Slack 앱 설정을 요청하세요. 허브의 AGENT_DESK_SLACK_CLIENT_FILE 설정에 인증 파일을 지정한 뒤 허브를 재시작해야 합니다.</p>}
        <div className="row">
          {item.configured && <button type="button" className="btn" disabled={!!busy} onClick={() => { void act(item, 'connect'); }}>{item.status === 'authorizing' ? '승인 다시 시작' : item.status === 'connected' ? '다시 연결' : '연결'}</button>}
          {item.status !== 'disconnected' && <button type="button" className="btn" disabled={!!busy} onClick={() => { void act(item, 'disconnect'); }}>{item.status === 'authorizing' ? '승인 취소·연결 해제' : '연결 해제'}</button>}
          {item.status === 'connected' && <button type="button" className="btn" disabled={!!busy} onClick={() => { void act(item, 'tools'); }}>사용 가능한 도구 조회</button>}
          {busy === item.service && <span className="small muted" role="status">처리 중…</span>}
        </div>
        {authorization && <p className="small"><a className="btn" href={authorization.authorization_url} target="_blank" rel="noopener noreferrer">승인 화면 열기</a>{' '}승인 후 이 화면에서 상태를 확인하세요. 링크 만료: {dateLabel(authorization.expires_at)}</p>}
        {item.status === 'authorizing' && !authorization && !busy && <p className="small muted">열어 둔 승인 화면에서 계속하거나 승인을 다시 시작하세요.</p>}
        {info.notice && <p className="small" role="status">{info.notice}</p>}
        {info.error && <p className="error" role="alert">{info.error}</p>}
        {info.tools !== undefined && <details open><summary className="small">조회 완료 · 사용 가능한 읽기 도구 {info.tools.length}개</summary>
          {info.tools.length ? <ul className="small">{info.tools.map(tool => <li key={tool.name}><strong>{tool.name}</strong>{tool.description && <p className="muted">{tool.description}</p>}</li>)}</ul>
            : <p className="small muted">목록 조회는 성공했지만 이 계정에서 사용할 수 있는 읽기 도구가 없습니다.</p>}
        </details>}
      </fieldset>;
    })}
    <p className="small muted">연결 해제는 이 허브에 저장된 인증정보만 삭제합니다. 앱의 접근 권한을 완전히 철회하려면 Slack 또는 Atlassian 계정 설정에서도 취소하세요.</p>
  </>;
}
