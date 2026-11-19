import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { markdownImageSource } from './markdownImageSource.ts';

function ExternalImage({ url, host, alt, title }: { url: string; host: string; alt: string; title?: string }) {
  const [image, setImage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  const objectUrl = useRef('');
  useEffect(() => () => {
    request.current?.abort();
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
  }, []);

  const load = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault(); event.stopPropagation();
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError('');
    void (async () => {
      try {
        const response = await fetch('/api/markdown-image', { method: 'POST', signal: controller.signal,
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) });
        if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? '이미지를 불러오지 못했습니다.');
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        objectUrl.current = URL.createObjectURL(blob);
        setImage(objectUrl.current);
      } catch (error) {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '이미지를 불러오지 못했습니다.');
      } finally {
        request.current = null;
        if (!controller.signal.aborted) setBusy(false);
      }
    })();
  };
  if (image) return <img src={image} alt={alt} title={title} decoding="async" onError={() => {
    URL.revokeObjectURL(image); objectUrl.current = ''; setImage(''); setError('이미지 파일을 표시할 수 없습니다.');
  }}/>;
  return <span className="markdown-external-image">
    {alt && <span>{alt} </span>}
    <button type="button" className="link" disabled={busy} title={host} onClick={load}
      onMouseDown={event => event.stopPropagation()}
      aria-label={alt ? `${alt} 이미지 불러오기 · ${host}` : `이미지 불러오기 · ${host}`}>
      {busy ? '이미지 불러오는 중…' : '이미지 불러오기'}
    </button>
    {error && <span className="error small" role="status"> {error}</span>}
  </span>;
}

export function MarkdownImage({ src, alt = '', title, resourceBase }: { src?: string; alt?: string; title?: string; resourceBase?: string }) {
  const image = markdownImageSource(src, resourceBase);
  if (image?.kind === 'local') return <img src={image.src} alt={alt} title={title} loading="lazy" decoding="async"/>;
  if (image?.kind === 'external') return <ExternalImage key={image.src} url={image.src} host={image.host} alt={alt} title={title}/>;
  return <span>{alt || '지원하지 않는 이미지 경로'}</span>;
}
