import { memo, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MermaidBlock } from './MermaidBlock.tsx';
import { remarkKoreanSuffixStrong } from './markdownKoreanStrong.ts';
import { mermaidSource } from './mermaid.ts';

/** Links a local app opens: AKB documents (Lectern), file URLs, and paths (no scheme). */
const APP_LINK = /^(akb|lectern|file):/i;
// Strikethrough only with ~~two~~ tildes: a single one is common in prose ("1~2개", "~/path").
const REMARK_PLUGINS = [[remarkGfm, { singleTilde: false }] as [typeof remarkGfm, { singleTilde: boolean }], remarkKoreanSuffixStrong];

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
export const Markdown = memo(function Markdown({ text, onLocalLink }: { text: string; onLocalLink?: (href: string) => void }) {
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS}
      urlTransform={(url) => (APP_LINK.test(url) ? url : defaultUrlTransform(url))}
      components={{
        pre: CodeBlock,
        a: ({ node: _, ...props }) => onLocalLink && isLocalLink(props.href)
          ? <a {...props} className="local-link" title={`로컬 앱으로 열기: ${props.href}`}
              onClick={(e) => { e.preventDefault(); onLocalLink(props.href!); }} />
          : <a {...props} target="_blank" rel="noreferrer" />,
      }}>
      {text}
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
