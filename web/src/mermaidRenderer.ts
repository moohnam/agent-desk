import type { MermaidConfig } from 'mermaid';
import { colorHandDrawnNodes } from './mermaidColors.ts';
import { MAX_DIAGRAM_TEXT, type DiagramReply } from './mermaidProtocol.ts';

let library: Promise<typeof import('mermaid')['default']> | undefined;
let nextId = 0;
class LibraryLoadError extends Error {}
// Mermaid's diagram identifiers sometimes differ from their config keys.
const CONFIG_KEYS: Record<string, keyof MermaidConfig> = {
  'flowchart-v2': 'flowchart', 'flowchart-elk': 'flowchart', classDiagram: 'class', stateDiagram: 'state',
  xychart: 'xyChart', railroadAbnf: 'railroad', railroadEbnf: 'railroad', railroadPeg: 'railroad',
};

/** Render off-screen, then display as an image so SVG links/scripts never join the app's DOM. */
async function renderDiagram(source: string): Promise<{ image: string; background: string }> {
  if (source.length > MAX_DIAGRAM_TEXT) throw new Error('도표가 너무 커서 원문으로 표시합니다.');
  library ??= import('mermaid').then((m) => m.default)
    .catch(() => { library = undefined; throw new LibraryLoadError('도표 라이브러리를 불러오지 못했습니다.'); });
  const mermaid = await library;
  const render = async () => {
    // Configuration is global in Mermaid: change it only inside our serial render queue.
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
        imageSvg = colorHandDrawnNodes(svg, appearance, authored);
      }
      return {
        image: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(imageSvg)}`,
        background: typeof background === 'string' ? background : '#fff',
      };
    } finally { scratch.remove(); }
  };
  return render();
}

// This document owns Mermaid's module caches and detached render nodes. The parent releases
// the entire realm after a burst, while keeping only the generated images in its own UI.
const connect = (event: MessageEvent) => {
  if (event.source !== parent || event.origin !== location.origin || event.data?.type !== 'desk-mermaid-connect') return;
  const port = event.ports[0];
  if (!port) return;
  window.removeEventListener('message', connect);
  port.onmessage = async ({ data }: MessageEvent<{ id: number; source: string }>) => {
    if (!Number.isSafeInteger(data?.id) || typeof data.source !== 'string') return;
    let reply: DiagramReply;
    try { reply = { id: data.id, result: await renderDiagram(data.source) }; }
    catch (error) { reply = {
      id: data.id,
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof LibraryLoadError ? { errorKind: 'infrastructure' as const } : {}),
    }; }
    port.postMessage(reply);
  };
  port.postMessage({ ready: true });
};
window.addEventListener('message', connect);
