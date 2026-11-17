import type { Root } from 'mdast';
import type { Processor } from 'unified';

/** Keep serialized, context-free syntax trees, never DOM, handlers, or transformed trees. */
export class MarkdownParseCache {
  private entries = new Map<string, string>();
  private bytes = 0;
  private limits: { entries: number; bytes: number; entryBytes: number };
  constructor(limits = { entries: 256, bytes: 4 * 1024 * 1024, entryBytes: 512 * 1024 }) { this.limits = { ...limits }; }

  get size() { return this.entries.size; }
  /** UTF-16 string storage budget; Map/string headers and transient render trees are separate. */
  get retainedBytes() { return this.bytes; }

  parse(source: string, parse: () => Root): Root {
    const saved = this.entries.get(source);
    if (saved !== undefined) {
      this.entries.delete(source); this.entries.set(source, saved);
      // Remark transforms mutate their input. Every render needs its own tree.
      return JSON.parse(saved) as Root;
    }
    const tree = parse();
    if (this.limits.entries < 1 || source.length * 2 > this.limits.entryBytes) return tree;
    const serialized = JSON.stringify(tree);
    const bytes = 2 * (source.length + serialized.length);
    if (bytes > this.limits.entryBytes || bytes > this.limits.bytes) return tree;
    while (this.entries.size >= this.limits.entries || this.bytes + bytes > this.limits.bytes) {
      const oldest = this.entries.entries().next().value;
      if (!oldest) break;
      this.entries.delete(oldest[0]);
      this.bytes -= 2 * (oldest[0].length + oldest[1].length);
    }
    this.entries.set(source, serialized); this.bytes += bytes;
    return tree;
  }
}

const syntax = new MarkdownParseCache();

/** Only attach to our fixed GFM (singleTilde:false) + math grammar, before tree transforms. */
export function remarkCachedParse(this: Processor) {
  const parser = this.parser;
  if (!parser) throw new Error('Markdown parser is required before its cache');
  this.parser = (source, file) => syntax.parse(source, () => parser(source, file) as Root);
}
