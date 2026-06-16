import type { Node } from 'web-tree-sitter';
import type { ExtractedSymbol } from '../../../types.js';
import type { LangSpec } from '../spec.js';
import { lineOf, precedingComment } from '../symbol-utils.js';

const QUERY = `
(function_item) @symbol
(struct_item) @symbol
(trait_item) @symbol
(enum_item) @symbol
(type_item) @symbol
(const_item) @symbol
(static_item) @symbol
`;

const isPub = (node: Node): boolean =>
  node.children.some((c) => c?.type === 'visibility_modifier');

/** Owner type if this fn sits inside an `impl Type` (or trait). */
function implOwner(node: Node): string | null {
  let p = node.parent;
  while (p) {
    if (p.type === 'impl_item') return p.childForFieldName('type')?.text ?? null;
    if (p.type === 'trait_item') return p.childForFieldName('name')?.text ?? null;
    p = p.parent;
  }
  return null;
}

export const rustSpec: LangSpec = {
  lang: 'rust',
  query: QUERY,
  toSymbol(node): ExtractedSymbol | null {
    const line = lineOf(node);
    const name = node.childForFieldName('name')?.text ?? '';
    if (!name) return null;
    const doc = precedingComment(node);
    const exported = isPub(node);

    switch (node.type) {
      case 'function_item': {
        const params = node.childForFieldName('parameters')?.text ?? '()';
        const ret = node.childForFieldName('return_type')?.text;
        const owner = implOwner(node);
        const full = owner ? `${owner}.${name}` : name;
        const sig = `${full}${params}${ret ? ' -> ' + ret : ''}`;
        return { kind: owner ? 'method' : 'function', name: full, signature: sig,
          exported, startLine: line, jsdoc: doc };
      }
      case 'struct_item':
        return { kind: 'class', name, signature: `class ${name}`, exported, startLine: line, jsdoc: doc };
      case 'trait_item':
        return { kind: 'interface', name, signature: `interface ${name}`, exported, startLine: line, jsdoc: doc };
      case 'enum_item':
        return { kind: 'enum', name, signature: `enum ${name}`, exported, startLine: line, jsdoc: doc };
      case 'type_item':
        return { kind: 'type', name, signature: `type ${name}`, exported, startLine: line, jsdoc: doc };
      default: // const_item | static_item
        return { kind: 'const', name, signature: name, exported, startLine: line, jsdoc: doc };
    }
  },
};
