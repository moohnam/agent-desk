import type { Root, Element, ElementContent, RootContent } from 'hast';

/** Highlight desk tags in prose without rewriting links, code, math or the submitted source. */
export function rehypeMentions() {
  return (root: Root) => {
    const walk = (parent: Root | Element) => {
      if (parent.type === 'element' && (['a','code','pre','math','script','style'].includes(parent.tagName)
        || (parent.properties.className as string[] | undefined)?.some(name => /^(katex|mention)/.test(name)))) return;
      parent.children = (parent.children as RootContent[]).flatMap<RootContent>(child => {
        if (child.type === 'element') { walk(child); return [child]; }
        if (child.type !== 'text') return [child];
        const parts: ElementContent[] = []; let start = 0;
        for (const match of child.value.matchAll(/(^|\s)([@#][^\s]+)/g)) {
          const at = match.index! + match[1].length;
          if (at > start) parts.push({type: 'text', value: child.value.slice(start, at)});
          parts.push({type: 'element', tagName: 'span', properties: {className: ['mention']}, children: [{type: 'text', value: match[2]}]});
          start = at + match[2].length;
        }
        if (!parts.length) return [child];
        if (start < child.value.length) parts.push({type: 'text', value: child.value.slice(start)});
        return parts;
      }) as typeof parent.children;
    };
    walk(root);
  };
}
