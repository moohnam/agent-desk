import { useState, type FormEvent } from 'react';
import { api } from './api.ts';
import { Modal } from './Modal.tsx';
import { safeChannelUrl } from './channelEntries.ts';
import type { Channel, ChannelTokenReceipt } from './types.ts';
import './channels.css';

/** Hub-wide channel management. Tokens exist only in this dialog, never in browser storage. */
export function ChannelsDialog({ channels, onClose, onOpen, onChanged }: {
  channels: Channel[]; onClose: () => void; onOpen: (channel: Channel) => void; onChanged: () => Promise<unknown>;
}) {
  const [editing, setEditing] = useState<Channel | null>(null);
  const [name, setName] = useState('');
  const [source, setSource] = useState<'push' | 'feed'>('push');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<ChannelTokenReceipt | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string>();
  const [confirmRotate, setConfirmRotate] = useState<string>();
  const perform = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); await onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const reset = () => { setEditing(null); setName(''); setSource('push'); setUrl(''); };
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (source === 'feed' && !safeChannelUrl(url)) { setError('RSS·Atom 구독 주소는 http:// 또는 https:// 주소여야 합니다.'); return; }
    void perform(async () => {
      if (editing) await api.updateChannel(editing.id, { name: name.trim(), ...(source === 'feed' ? { feed_url: url.trim() } : {}) });
      else {
        const created = await api.createChannel({ name: name.trim(), source, ...(source === 'feed' ? { feed_url: url.trim() } : {}) });
        if (created.token) { setReceipt(created); setCopied(false); }
      }
      reset();
    });
  };
  return <Modal title="읽기 전용 채널" wide onClose={onClose}>
    <div className="channel-manager">
      <p className="muted small">봇이 보내는 알림과 RSS·Atom 구독을 F1 컬럼에서 읽습니다. 읽음 위치는 이 허브에 연결된 모든 기기가 공유합니다.</p>
      {receipt?.token && <section className="channel-token" aria-label="채널 발행 토큰">
        <strong>{receipt.channel.name} 발행 토큰 · 지금 한 번만 표시합니다</strong>
        <p className="small">복사해 봇의 비밀 설정에 보관하세요. 이 창을 닫으면 다시 볼 수 없으며, 재발급하면 이전 토큰이 무효가 됩니다.</p>
        <textarea className="input" readOnly rows={2} aria-label="발행 토큰" value={receipt.token} onFocus={(event) => event.currentTarget.select()} />
        <p className="small">발행 경로: <code>/api/channels/{receipt.channel.id}/entries</code> · Authorization: Bearer 토큰</p>
        <div className="channel-row-actions"><button className="btn" disabled={!navigator.clipboard?.writeText} onClick={() => {
          void navigator.clipboard.writeText(receipt.token!).then(() => setCopied(true), () => setError('복사하지 못했습니다. 토큰을 직접 선택해 복사해 주세요.'));
        }}>{copied ? '복사했습니다' : '토큰 복사'}</button><button className="btn" onClick={() => setReceipt(null)}>보관했습니다</button></div>
      </section>}
      {error && <p className="error" role="alert">{error}</p>}
      <form className="channel-form" onSubmit={save}>
        <label>이름<input className="input" value={name} onChange={(event) => setName(event.target.value)} required maxLength={200} /></label>
        <label>종류<select className="input" value={source} disabled={!!editing} onChange={(event) => setSource(event.target.value as 'push' | 'feed')}><option value="push">봇 알림 (API)</option><option value="feed">RSS·Atom 구독</option></select></label>
        {source === 'feed' && <label>구독 URL<input className="input" type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/feed.xml" required /></label>}
        <div className="channel-row-actions"><button className="btn primary" disabled={busy || !name.trim() || (!editing && !!receipt)}>{editing ? '채널 저장' : '채널 추가'}</button>{editing && <button type="button" className="btn" onClick={reset}>편집 취소</button>}</div>
      </form>
      <ul className="channel-list">{channels.map((channel) => <li key={channel.id}>
        <div><strong>{channel.name}</strong><span className="muted small"> · {channel.source === 'feed' ? 'RSS·Atom' : '봇 알림'} · {channel.unread_count} 안 읽음{!channel.enabled ? ' · 일시 중지' : ''}</span></div>
        {channel.feed_url && <p className="small channel-url">{channel.feed_url}</p>}
        {channel.last_error && <p className="error">{channel.last_error}</p>}
        {channel.last_checked_at && <p className="muted small">최근 확인 {new Date(channel.last_checked_at).toLocaleString('ko-KR')}</p>}
        <div className="channel-row-actions">
          <button className="btn" onClick={() => onOpen(channel)}>컬럼에서 열기</button>
          <button className="btn" disabled={busy} onClick={() => { setEditing(channel); setName(channel.name); setSource(channel.source); setUrl(channel.feed_url ?? ''); }}>편집</button>
          <button className="btn" disabled={busy} onClick={() => void perform(() => api.updateChannel(channel.id, { enabled: !channel.enabled }))}>{channel.enabled ? '일시 중지' : '다시 시작'}</button>
          {channel.source === 'feed' && <button className="btn" disabled={busy} onClick={() => void perform(() => api.refreshChannel(channel.id))}>지금 갱신</button>}
          {channel.source === 'push' && <button className="btn" disabled={busy || !!receipt} onClick={() => {
            if (confirmRotate !== channel.id) { setConfirmRotate(channel.id); return; }
            void perform(async () => { setReceipt(await api.rotateChannelToken(channel.id)); setCopied(false); setConfirmRotate(undefined); });
          }}>{confirmRotate === channel.id ? '다시 눌러 이전 토큰 폐기·재발급' : '토큰 재발급'}</button>}
          <button className="btn danger" disabled={busy} onClick={() => {
            if (confirmDelete !== channel.id) { setConfirmDelete(channel.id); return; }
            void perform(async () => { await api.deleteChannel(channel.id); if (editing?.id === channel.id) reset(); if (receipt?.channel.id === channel.id) setReceipt(null); setConfirmDelete(undefined); });
          }}>{confirmDelete === channel.id ? '다시 눌러 채널·글 삭제' : '삭제'}</button>
        </div>
      </li>)}</ul>
      {!channels.length && <p className="muted">아직 채널이 없습니다. 위에서 채널을 추가해 주세요.</p>}
    </div>
  </Modal>;
}
