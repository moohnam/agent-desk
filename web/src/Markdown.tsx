import { memo, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type ExtraProps } from 'react-markdown';
import 'katex/dist/katex.min.css';
import { MermaidBlock } from './MermaidBlock.tsx';
import { mermaidSource } from './mermaid.ts';
import { documentHref, documentPath, isDocumentLink } from './documentLinks.ts';
import { MARKDOWN_REHYPE_PLUGINS, MARKDOWN_REMARK_PLUGINS, normalizeMathNotation } from './markdownMath.ts';

/** Links a local app opens: AKB documents (Lectern), file URLs, and paths (no scheme). */
const APP_LINK = /^(akb|lectern|file):/i;

export const isLocalLink = (href: string | undefined) =>
  !!href && (APP_LINK.test(href) || (!/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('#') && !href.startsWith('//')));

function CodeBlock({ node, children, ...props }: ComponentProps<'pre'> & ExtraProps) {
  const source = mermaidSource(node);
  return source == null ? <pre {...props}>{children}</pre> : <MermaidBlock source={source} />;
}

/**
 * Agent replies are Markdown. Raw HTML is not rendered. Web links open in a new tab; local links
 * go to `onLocalLink` (the hub opens them, since a web page can't reach local apps or files).
 */
export const Markdown = memo(function Markdown({ text, onLocalLink, resourceBase, taskId, linkBase }: { text: string; onLocalLink?: (href: string) => void; resourceBase?: string; taskId?: string; linkBase?: string }) {
  const normalizedText = useMemo(() => normalizeMathNotation(text), [text]);
  return (
    <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS} rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
      urlTransform={(url) => (APP_LINK.test(url) ? url : defaultUrlTransform(url))}
      components={{
        pre: CodeBlock,
        ...(resourceBase ? { img: ({ node: _, src, ...props }: ComponentProps<'img'> & ExtraProps) => {
          // Document images stay in its capability directory; no absolute filesystem requests.
          const path=typeof src==='string'&&!/^(?:[a-z][a-z\d+.-]*:|[~/])/i.test(src)&&!src.split('/').includes('..')
            ? resourceBase.replace(/[^/]*$/,'')+src : undefined;
          return path?<img {...props} src={path} loading="lazy"/>:<span>{props.alt??'이미지 경로를 지원하지 않습니다'}</span>;
        }} : {}),
        a: ({ node: _, ...props }) => {
          if (!onLocalLink || !isLocalLink(props.href)) return <a {...props} target="_blank" rel="noreferrer" />;
          const path=documentPath(props.href!,linkBase), document=!!taskId&&isDocumentLink(path);
          return <a {...props} href={document?documentHref(taskId!,path):props.href} className="local-link"
            title={`${document?'문서 미리보기':'로컬 앱으로 열기'}: ${path}`}
            onClick={(e) => {
              if(document&&(e.metaKey||e.ctrlKey||e.shiftKey||e.altKey))return;
              e.preventDefault();onLocalLink(path);
            }} />;
        },
      }}>
      {normalizedText}
    </ReactMarkdown>
  );
});

/** Clamps a long body in the feed with a "더 보기" toggle; `full` shows everything. */
export function LongText({ full, className, onToggle, children }: {
  full: boolean; className: string; onToggle?: () => void; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  // Measure only while clamped; once expanded the toggle stays so it can be folded again.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !full) setLong(el.scrollHeight > el.clientHeight + 1);
  }, [full, children]);
  // Column resizing can change wrapping without changing the text. Observe size changes
  // separately so selecting another post does not synchronously measure every body.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || full) return;
    const observer = new ResizeObserver(() => setLong(el.scrollHeight > el.clientHeight + 1));
    observer.observe(el);
    return () => observer.disconnect();
  }, [full]);
  return (
    <>
      <div ref={ref} className={`${className}${full ? '' : ' clamp'}`}>{children}</div>
      {long && onToggle && (
        <button className="link more" title="펼치기 (o)" onClick={(e) => { e.stopPropagation(); onToggle(); }}>
          {full ? '접기' : '더 보기'}
        </button>
      )}
    </>
  );
}
