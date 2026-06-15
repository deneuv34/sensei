const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'for', 'of', 'and', 'or', 'in', 'on', 'with', 'is', 'be',
  'add', 'create', 'implement', 'support', 'feature', 'new', 'update', 'fix', 'make',
  'build', 'using', 'use', 'allow', 'enable', 'handle', 'into', 'from', 'this', 'that',
]);

export function splitIdentifier(word: string): string[] {
  return word
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase boundary
    .split(/[^a-zA-Z0-9]+/)                  // non-alphanumeric boundary
    .filter(Boolean);
}

export function tokenize(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const word of text.split(/[^a-zA-Z0-9]+/).filter(Boolean)) {
    for (const part of splitIdentifier(word)) {
      const t = part.toLowerCase();
      if (t.length < 2 || STOPWORDS.has(t) || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}
