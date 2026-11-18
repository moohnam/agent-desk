import { Copy } from 'lucide-react';
import { writeClipboardText } from './clipboard.ts';

export function CopyButton({ text, label, onNotice, className = '' }: {
  text: string | (() => string); label: string; onNotice?: (message: string) => void; className?: string;
}) {
  return <button type="button" className={`icon-btn ${className}`} title={label} aria-label={label}
    onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation(); }}
    onClick={event => {
      event.stopPropagation();
      const button = event.currentTarget;
      void writeClipboardText(typeof text === 'string' ? text : text(), button).then(copied => {
        if (button.isConnected) onNotice?.(copied ? '클립보드에 복사했습니다.' : '클립보드에 복사하지 못했습니다.');
      });
    }}><Copy aria-hidden="true" /></button>;
}
