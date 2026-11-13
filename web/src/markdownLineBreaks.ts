import type { Parent, Root, RootContent } from 'mdast';

/** Treat prose soft breaks as visible line breaks, without rewriting code or block boundaries. */
export function remarkLineBreaks() {
  const visit = (parent: Parent) => {
    parent.children = parent.children.flatMap((child): RootContent[] => {
      if ('children' in child) visit(child);
      if (child.type !== 'text' || !/[\r\n]/.test(child.value)) return [child];
      return child.value.split(/\r\n|\r|\n/).flatMap((value, index): RootContent[] =>
        [...(index ? [{ type: 'break' } as const] : []), ...(value ? [{ type: 'text' as const, value }] : [])]);
    });
  };
  return (tree: Root) => visit(tree);
}
