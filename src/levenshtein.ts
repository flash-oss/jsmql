// Cheap Levenshtein distance + closest-name lookup. Used to power "did you
// mean?" suggestions in error messages — pipeline-stage typos and unknown
// method names today.

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

/**
 * Find the candidate string closest to `name` by edit distance. Returns null
 * when no candidate is close enough to be a likely typo (max 2 edits, and the
 * distance must be strictly less than the input's own length so a totally
 * unrelated short name doesn't trigger).
 */
export function closestNameTo(name: string, candidates: Iterable<string>): string | null {
  let best: { name: string; dist: number } | null = null;
  for (const candidate of candidates) {
    const d = levenshtein(name, candidate);
    if (best === null || d < best.dist) best = { name: candidate, dist: d };
  }
  if (best === null) return null;
  if (best.dist <= 2 && best.dist < name.length) return best.name;
  return null;
}

/**
 * Build the trailing " Did you mean 'X'?" hint for a rejection against a closed
 * set of names — the canonical way to satisfy the closest-name DX mandate (see
 * the error-consistency rules in CLAUDE.md). Returns "" when no candidate is
 * close enough, so the call site can interpolate the result unconditionally.
 *
 * `format` renders the suggestion the way the surrounding message spells the
 * name: the default is the instance-method form (`.foo()`); pass
 * `(s) => \`Class.\${s}\`` for statics, or `(s) => s` for bare names (stages).
 */
export function didYouMean(
  name: string,
  candidates: Iterable<string>,
  format: (s: string) => string = (s) => `.${s}()`,
): string {
  const suggestion = closestNameTo(name, candidates);
  return suggestion ? ` Did you mean '${format(suggestion)}'?` : "";
}
