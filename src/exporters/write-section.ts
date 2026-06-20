import fs from 'node:fs';
import path from 'node:path';

export const SECTION_START = '<!-- SENSEI:START -->';
export const SECTION_END = '<!-- SENSEI:END -->';

/**
 * Inject `body` into `filePath` between managed markers, preserving any
 * surrounding user content. Idempotent: re-running replaces the same block.
 */
export function writeManagedSection(filePath: string, body: string): void {
  const block = `${SECTION_START}\n${body}\n${SECTION_END}`;

  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${block}\n`);
    return;
  }

  const existing = fs.readFileSync(filePath, 'utf8');
  const markers = new RegExp(`${escapeRe(SECTION_START)}[\\s\\S]*?${escapeRe(SECTION_END)}`);
  if (markers.test(existing)) {
    // function replacement avoids `$` in body being treated as a back-reference
    fs.writeFileSync(filePath, existing.replace(markers, () => block));
    return;
  }

  const sep = existing.endsWith('\n') ? '\n' : '\n\n';
  fs.writeFileSync(filePath, `${existing}${sep}${block}\n`);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
