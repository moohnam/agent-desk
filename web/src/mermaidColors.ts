import type { MermaidConfig } from 'mermaid';

/** Mermaid's hand-drawn flowchart shapes omit the redux palette. Fill that gap on the inert SVG. */
export function colorHandDrawnNodes(svg: string, config: MermaidConfig, authored: MermaidConfig): string {
  if (!['redux-color', 'redux-dark-color'].includes(config.theme ?? '') || authored.themeCSS || authored.themeVariables) return svg;
  const vars = config.themeVariables;
  const fills: unknown = vars?.bkgColorArray;
  const borders: unknown = vars?.borderColorArray;
  if (!Array.isArray(fills) || !Array.isArray(borders) || !borders.length) return svg;
  if (![...fills, ...borders].every((color) => typeof color === 'string' && CSS.supports('color', color))) return svg;
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  // A classDef for "default" explicitly styles otherwise unclassified nodes.
  if (Array.from(doc.querySelectorAll('style')).some((style) => /\.default\s+(?:rect|path|polygon|circle|ellipse)\s*\{/.test(style.textContent ?? ''))) return svg;
  let changed = false;
  doc.querySelectorAll('.nodes > g.rough-node[data-look="handDrawn"]').forEach((node, index) => {
    // Authored classes and direct shape styles take precedence, even if they use the default color.
    if (Array.from(node.classList).some((name) => name !== 'rough-node' && name !== 'default')) return;
    const shapes = Array.from(node.querySelectorAll(':scope > g:not(.label), :scope > g:not(.label) [style]'));
    if ([node, ...shapes].some((el) => /\b(?:fill|stroke)\s*:/.test(el.getAttribute('style') ?? ''))) return;
    let painted = false;
    node.querySelectorAll(':scope > g:not(.label) path[fill="none"][stroke]').forEach((path) => {
      const stroke = path.getAttribute('stroke')?.toLowerCase();
      // RoughJS draws the hatching with stroke=mainBkg; keep fill="none" and its geometry.
      const color = stroke === String(vars.mainBkg).toLowerCase() ? (fills.length ? fills[index % fills.length] : undefined)
        : stroke === String(vars.nodeBorder).toLowerCase() ? borders[index % borders.length] : undefined;
      if (color) {
        path.setAttribute('stroke', color);
        painted = true;
      }
    });
    if (painted) {
      node.setAttribute('data-desk-color', String(index));
      changed = true;
    }
  });
  return changed ? new XMLSerializer().serializeToString(doc.documentElement) : svg;
}
