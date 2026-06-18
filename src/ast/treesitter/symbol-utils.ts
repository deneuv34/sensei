import type { Node } from 'web-tree-sitter';

export const lineOf = (n: Node): number => n.startPosition.row + 1;

export const isUpperFirst = (name: string): boolean =>
  name.length > 0 && name[0] === name[0].toUpperCase() && name[0] !== name[0].toLowerCase();

/** Collect contiguous comment text immediately preceding a node. */
export function precedingComment(node: Node): string {
  const parts: string[] = [];
  let prev = node.previousNamedSibling;
  while (prev && (prev.type === 'comment' || prev.type === 'line_comment' || prev.type === 'block_comment')) {
    parts.unshift(prev.text);
    prev = prev.previousNamedSibling;
  }
  return parts.join(' ').replace(/^\/[/*!]+|\*+\/$|^\s*\*/gm, '').trim();
}
