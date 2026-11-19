const IMAGE = /\.(?:png|jpe?g|gif|webp|svg|ico)$/i;

/** A Markdown document can only auto-load images from its own preview grant. */
export function markdownImageSource(src?: string, resourceBase?: string):
  { kind: 'local'; src: string } | { kind: 'external'; src: string; host: string } | undefined {
  if (!src || /[\\\x00-\x1f\x7f]/.test(src)) return;
  if (/^(?:https?:\/\/|\/\/)/i.test(src)) {
    try {
      const url = new URL(src, 'https://desk.invalid');
      if (!url.username && !url.password) return { kind: 'external', src: url.href, host: url.host };
    } catch { /* The image can still show its alt text. */ }
    return;
  }
  const base = resourceBase?.match(/^\/_preview\/[\w-]+\//)?.[0];
  if (!base || src.startsWith('/')) return;
  const delimiter = src.search(/[?#]/);
  const path = delimiter < 0 ? src : src.slice(0, delimiter);
  const suffix = delimiter < 0 ? '' : src.slice(delimiter);
  try {
    const parts = path.split('/').filter(part => part !== '.').map(decodeURIComponent);
    if (parts.some(part => !part || part.startsWith('.') || /[\\/%\x00-\x1f\x7f:#?]/.test(part))
      || !IMAGE.test(parts.at(-1) ?? '')) return;
    return { kind: 'local', src: base + parts.map(encodeURIComponent).join('/') + suffix };
  } catch { /* Invalid escaping. */ }
}
