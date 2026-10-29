// Model choice shared by the engines whose tags name a model family (Codex, agy).

/**
 * The newest model of a family (#sol → gpt-6.1-sol): ids end in `-<family>`, and the version is the
 * numbers before it, compared part by part. Undefined when the catalog has none.
 */
export function latestOfFamily(ids: string[], family: string): string | undefined {
  const version = (id: string) => (id.match(/\d+(?:\.\d+)*/)?.[0] ?? '0').split('.').map(Number);
  const newer = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
    return 0;
  };
  return ids.filter((id) => id.endsWith(`-${family}`)).sort((a, b) => newer(version(b), version(a)))[0];
}
