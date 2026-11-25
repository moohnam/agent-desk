import { Component, type ReactNode } from 'react';
import './code-panel.css';

export class CodePanelBoundary extends Component<{children: ReactNode; onClose: () => void}> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <aside className="code-panel" aria-label="코드 변경 보기" onKeyDown={event => { if (event.key !== 'Escape') event.stopPropagation(); }}>
      <header><strong>코드 변경</strong><button onClick={this.props.onClose} aria-label="코드 보기 닫기">닫기</button></header>
      <p role="alert">코드 변경을 표시하지 못했습니다. 화면을 새로고침한 뒤 다시 열어 주세요.</p>
      <button type="button" onClick={() => window.location.reload()}>화면 새로고침</button>
    </aside>;
  }
}
