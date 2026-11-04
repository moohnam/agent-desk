import type { Element } from 'hast';
import type { MermaidConfig } from 'mermaid';
import { colorHandDrawnNodes } from './mermaidColors.ts';

export const MAX_DIAGRAM_TEXT = 20_000;
let library: Promise<typeof import('mermaid')['default']> | undefined;
let nextId = 0;
let rendering: Promise<unknown> = Promise.resolve();
// Mermaid's diagram identifiers sometimes differ from their config keys.
const CONFIG_KEYS: Record<string, keyof MermaidConfig> = {
  'flowchart-v2': 'flowchart', 'flowchart-elk': 'flowchart', classDiagram: 'class', stateDiagram: 'state',
  xychart: 'xyChart', railroadAbnf: 'railroad', railroadEbnf: 'railroad', railroadPeg: 'railroad',
};

/** Defer work until visible, cancel queued work on exit, and keep a completed diagram. */
export function renderWhenVisible(element: HTMLElement, render: (signal: AbortSignal) => Promise<void>): () => void {
  let complete = false;
  let pending: AbortController | undefined;
  let observer: IntersectionObserver | undefined;
  const start = () => {
    if (complete || pending) return;
    const controller = pending = new AbortController();
    const finish = () => {
      if (controller.signal.aborted) return;
      complete = true;
      observer?.disconnect();
    };
    void render(controller.signal).then(finish, finish);
  };
  if (typeof IntersectionObserver === 'undefined') start();
  else {
    observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting && entry.intersectionRatio > 0)) start();
      else { pending?.abort(); pending = undefined; }
    }, { threshold: 0.001 }); // No prefetch margin: respect feed/body/viewport clipping.
    observer.observe(element);
  }
  return () => { complete = true; pending?.abort(); observer?.disconnect(); };
}

/** Only fenced Mermaid blocks, not inline code or other languages. */
export function mermaidSource(node: Element | undefined): string | null {
  const code = node?.children[0];
  if (node?.children.length !== 1 || code?.type !== 'element' || code.tagName !== 'code') return null;
  const classes = code.properties.className;
  if (!Array.isArray(classes) || !classes.some((c) => /^language-mermaid$/i.test(String(c)))) return null;
  return code.children.filter((c) => c.type === 'text').map((c) => c.value).join('').replace(/\n$/, '');
}

/** Render off-screen, then display as an image so SVG links/scripts never join the app's DOM. */
export async function renderMermaid(source: string, signal?: AbortSignal): Promise<{ image: string; background: string }> {
  if (source.length > MAX_DIAGRAM_TEXT) throw new Error('도표가 너무 커서 원문으로 표시합니다.');
  signal?.throwIfAborted();
  library ??= import('mermaid').then((m) => m.default)
    .catch((error: unknown) => { library = undefined; throw error; });
  const mermaid = await library;
  const render = async () => {
    // Configuration is global in Mermaid: change it only inside our serial render queue.
    signal?.throwIfAborted();
    mermaid.initialize({
      startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
      theme: 'redux-color', look: 'handDrawn', handDrawnSeed: 1, htmlLabels: false, fontFamily: 'sans-serif',
      maxTextSize: MAX_DIAGRAM_TEXT, maxEdges: 300,
      secure: ['secure', 'securityLevel', 'startOnLoad', 'suppressErrorRendering', 'maxTextSize', 'maxEdges',
        'htmlLabels', 'dompurifyConfig'],
    });
    const scratch = document.createElement('div');
    scratch.setAttribute('aria-hidden', 'true');
    scratch.style.cssText = 'position:absolute;left:-10000px;top:0;width:1000px;visibility:hidden;pointer-events:none';
    document.body.append(scratch);
    try {
      const { svg, diagramType } = await mermaid.render(`desk-mermaid-${++nextId}`, source, scratch);
      signal?.throwIfAborted();
      const config = mermaid.mermaidAPI.getConfig();
      let appearance = config;
      let authored: MermaidConfig | undefined;
      let background = config.themeVariables?.background;
      const section = config[(CONFIG_KEYS[diagramType] ?? diagramType) as keyof MermaidConfig];
      if (section && typeof section === 'object' && 'theme' in section && typeof section.theme === 'string' && section.theme !== config.theme) {
        // render() clears the diagram scope before returning. Ask Mermaid to resolve the
        // scoped theme's background with the author's variables, without hardcoded palettes.
        authored = (await mermaid.parse(source)).config;
        const authoredSection = authored[(CONFIG_KEYS[diagramType] ?? diagramType) as keyof MermaidConfig];
        if (authoredSection && typeof authoredSection === 'object' && 'theme' in authoredSection && authoredSection.theme === section.theme) {
          mermaid.initialize({ theme: section.theme as MermaidConfig['theme'], themeVariables: authored.themeVariables });
          const resolved = mermaid.mermaidAPI.getConfig();
          if (resolved.theme === section.theme) {
            background = resolved.themeVariables?.background;
            appearance = resolved;
          }
        }
      }
      let imageSvg = svg;
      if ((CONFIG_KEYS[diagramType] ?? diagramType) === 'flowchart' && svg.includes('data-look="handDrawn"')
        && ['redux-color', 'redux-dark-color'].includes(appearance.theme ?? '')) {
        authored ??= (await mermaid.parse(source)).config;
        signal?.throwIfAborted();
        imageSvg = colorHandDrawnNodes(svg, appearance, authored);
      }
      signal?.throwIfAborted();
      return {
        image: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(imageSvg)}`,
        background: typeof background === 'string' ? background : '#fff',
      };
    } finally { scratch.remove(); }
  };
  const result = rendering.then(render);
  rendering = result.catch(() => {});
  return result;
}
