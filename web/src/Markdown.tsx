import { rehypeMentions } from './markdownMentions.ts';
import { scheduleLayoutRead } from './layoutBatch.ts';
import { createContext, memo, useContext, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type ExtraProps, type Components } from 'react-markdown';
import 'katex/dist/katex.min.css';
import { MermaidBlock } from './MermaidBlock.tsx';
import { mermaidSource } from './mermaid.ts';
import { documentPath, isDocumentLink } from './documentLinks.ts';
import { DocumentLink } from './DocumentLink.tsx';
import { CopyButton } from './CopyButton.tsx';
import { MARKDOWN_REHYPE_PLUGINS, MARKDOWN_REMARK_PLUGINS } from './markdownMath.ts';
import { prepareMarkdown } from './markdownSource.ts';
import { MarkdownImage } from './MarkdownImage.tsx';

/** Links a local app opens: AKB documents (Lectern), file URLs, and paths (no scheme). */
const APP_LINK = /^(akb|lectern|file):/i;
const transformUrl = (url: string) => APP_LINK.test(url) ? url : defaultUrlTransform(url);

export const isLocalLink = (href: string | undefined) =>
  !!href && (APP_LINK.test(href) || (!/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('#') && !href.startsWith('//')));

const CopySource = createContext<{ markdown: ReturnType<typeof prepareMarkdown>; onNotice?: (message: string) => void } | null>(null);

function useBlockCopy(node: ExtraProps['node'], label: string) {
  const source = useContext(CopySource);
  const position = node?.position;
  if (!source || position?.start.offset == null || position.end.offset == null) return null;
  return <CopyButton text={() => source.markdown.blockSource(position)} label={label} onNotice={source.onNotice} />;
}

function CodeBlock({ node, ...props }: ComponentProps<'pre'> & ExtraProps) {
  const source = mermaidSource(node);
  const copy = useBlockCopy(node, source == null ? '코드 블록 Markdown 복사' : 'Mermaid Markdown 복사');
  if (source != null) return <MermaidBlock source={source} copy={copy} />;
  const pre = <pre {...props} />;
  return copy ? <div className="markdown-copy-block">{pre}{copy}</div> : pre;
}

function Table({ node, ...props }: ComponentProps<'table'> & ExtraProps) {
  const copy = useBlockCopy(node, '표 Markdown 복사');
  const table = <table {...props} />;
  return copy ? <div className="markdown-copy-block">{table}{copy}</div> : table;
}

/**
 * Conversation bodies are Markdown. Raw HTML is not rendered. Web links open in a new tab; local links
 * go to `onLocalLink` (the hub opens them, since a web page can't reach local apps or files).
 */
export const Markdown = memo(function Markdown({ text, onLocalLink, onNotice, resourceBase, taskId, linkBase, mentions = false }: {
  text: string; mentions?: boolean; onLocalLink?: (href: string) => void; onNotice?: (message: string) => void;
  resourceBase?: string; taskId?: string; linkBase?: string;
}) {
  const rehypePlugins = useMemo(() => mentions ? [...MARKDOWN_REHYPE_PLUGINS, rehypeMentions] : MARKDOWN_REHYPE_PLUGINS, [mentions]);
  const markdown = useMemo(() => prepareMarkdown(text), [text]);
  const copySource = useMemo(() => ({ markdown, onNotice }), [markdown, onNotice]);
  const components = useMemo<Components>(() => ({
        pre: CodeBlock,
        table: Table,
        img: ({ src, alt, title }) => <MarkdownImage src={src} alt={alt} title={title} resourceBase={resourceBase}/>,
        a: ({ node: _, ...props }) => {
          if (!onLocalLink || !isLocalLink(props.href)) return <a {...props} target="_blank" rel="noreferrer" />;
          const path=documentPath(props.href!,linkBase), document=!!taskId&&isDocumentLink(path);
          if (document) return <DocumentLink {...props} path={path} taskId={taskId!} previewId={resourceBase?.match(/^\/_preview\/([^/]+)\//)?.[1]} onPreview={()=>onLocalLink(path)} />;
          return <a {...props} className="local-link"
            title={`로컬 앱으로 열기: ${path}`}
            onClick={(e) => {
              e.preventDefault();onLocalLink(path);
            }} />;
        },
  }), [resourceBase, onLocalLink, taskId, linkBase]);
  return (
    <CopySource.Provider value={copySource}>
      <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS} rehypePlugins={rehypePlugins}
        urlTransform={transformUrl} components={components}>
        {markdown.text}
      </ReactMarkdown>
    </CopySource.Provider>
  );
});

/** Clamps a long body in the feed with a "더 보기" toggle; `full` shows everything. */
export function LongText({ full, className, onToggle, children }: {
  full: boolean; className: string; onToggle?: () => void; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  // Content updates may change overflow without changing the clamped box's dimensions.
  // Batch new bodies and resize notifications into one read phase, then update their toggles.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || full) return;
    let cancel: (() => void) | undefined;
    const measure = () => {
      cancel?.();
      cancel = scheduleLayoutRead(() => {
        const overflows = el.scrollHeight > el.clientHeight + 1;
        return () => setLong(overflows);
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => { observer.disconnect(); cancel?.(); };
  }, [full, children]);
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
