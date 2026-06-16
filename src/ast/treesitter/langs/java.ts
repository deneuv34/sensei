import type { Node } from 'web-tree-sitter';
import type { ExtractedSymbol } from '../../../types.js';
import type { LangSpec } from '../spec.js';
import { lineOf, precedingComment } from '../symbol-utils.js';

const QUERY = `
(class_declaration) @symbol
(interface_declaration) @symbol
(enum_declaration) @symbol
(method_declaration) @symbol
`;

const isPublic = (node: Node): boolean => {
  const mods = node.children.find((c) => c?.type === 'modifiers');
  return mods?.text.includes('public') ?? false;
};

/** Nearest enclosing type name for a method. */
function ownerType(node: Node): string | null {
  let p = node.parent;
  while (p) {
    if (p.type === 'class_declaration' || p.type === 'interface_declaration' || p.type === 'enum_declaration') {
      return p.childForFieldName('name')?.text ?? null;
    }
    p = p.parent;
  }
  return null;
}

export const javaSpec: LangSpec = {
  lang: 'java',
  query: QUERY,
  toSymbol(node): ExtractedSymbol | null {
    const line = lineOf(node);
    const name = node.childForFieldName('name')?.text ?? '';
    if (!name) return null;
    const doc = precedingComment(node);

    if (node.type === 'method_declaration') {
      const owner = ownerType(node);
      const full = owner ? `${owner}.${name}` : name;
      const params = node.childForFieldName('parameters')?.text ?? '()';
      const ret = node.childForFieldName('type')?.text;
      const sig = `${full}${params}${ret ? ': ' + ret : ''}`;
      return { kind: 'method', name: full, signature: sig, exported: isPublic(node), startLine: line, jsdoc: doc };
    }

    const kind = node.type === 'interface_declaration' ? 'interface'
      : node.type === 'enum_declaration' ? 'enum' : 'class';
    return { kind, name, signature: `${kind} ${name}`, exported: isPublic(node), startLine: line, jsdoc: doc };
  },
};
