import type { ExtractedSymbol, SymbolKind } from '../../../types.js';
import type { LangSpec } from '../spec.js';
import { lineOf, isUpperFirst, precedingComment } from '../symbol-utils.js';

const QUERY = `
(function_declaration) @symbol
(method_declaration) @symbol
(type_spec) @symbol
(const_spec) @symbol
`;

function sig(name: string, params: string, result: string | undefined): string {
  return `${name}${params}${result ? ' ' + result : ''}`;
}

export const goSpec: LangSpec = {
  lang: 'go',
  query: QUERY,
  toSymbol(node): ExtractedSymbol | null {
    const line = lineOf(node);

    if (node.type === 'function_declaration') {
      const name = node.childForFieldName('name')?.text ?? '';
      if (!name) return null;
      const params = node.childForFieldName('parameters')?.text ?? '()';
      const result = node.childForFieldName('result')?.text;
      return { kind: 'function', name, signature: sig(name, params, result),
        exported: isUpperFirst(name), startLine: line, jsdoc: precedingComment(node) };
    }

    if (node.type === 'method_declaration') {
      const name = node.childForFieldName('name')?.text ?? '';
      if (!name) return null;
      const recv = node.childForFieldName('receiver');
      const owner = recv?.descendantsOfType('type_identifier')[0]?.text ?? '';
      const params = node.childForFieldName('parameters')?.text ?? '()';
      const result = node.childForFieldName('result')?.text;
      const full = owner ? `${owner}.${name}` : name;
      return { kind: 'method', name: full, signature: sig(full, params, result),
        exported: isUpperFirst(name), startLine: line, jsdoc: precedingComment(node) };
    }

    if (node.type === 'type_spec') {
      const name = node.childForFieldName('name')?.text ?? '';
      if (!name) return null;
      const t = node.childForFieldName('type')?.type;
      const kind: SymbolKind = t === 'struct_type' ? 'class' : t === 'interface_type' ? 'interface' : 'type';
      return { kind, name, signature: `${kind} ${name}`, exported: isUpperFirst(name),
        startLine: line, jsdoc: precedingComment(node.parent ?? node) };
    }

    // const_spec
    const name = node.childForFieldName('name')?.text ?? node.namedChild(0)?.text ?? '';
    if (!name) return null;
    return { kind: 'const', name, signature: name, exported: isUpperFirst(name),
      startLine: line, jsdoc: '' };
  },
};
