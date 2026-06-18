import type { Node } from 'web-tree-sitter';
import type { ExtractedSymbol } from '../../../types.js';
import type { LangSpec } from '../spec.js';
import { lineOf } from '../symbol-utils.js';

const QUERY = `
(function_definition) @symbol
(class_definition) @symbol
(expression_statement (assignment left: (identifier))) @symbol
`;

const exported = (name: string): boolean => !name.startsWith('_');

/** Walk up to the nearest enclosing function (=> nested) or class (=> method owner). */
function enclosing(node: Node): { inFunction: boolean; className: string | null } {
  let p = node.parent;
  while (p) {
    if (p.type === 'function_definition') return { inFunction: true, className: null };
    if (p.type === 'class_definition') return { inFunction: false, className: p.childForFieldName('name')?.text ?? null };
    p = p.parent;
  }
  return { inFunction: false, className: null };
}

function docstring(body: Node | null): string {
  const first = body?.namedChild(0);
  if (first?.type === 'expression_statement') {
    const str = first.namedChild(0);
    if (str?.type === 'string') return str.text.replace(/^[rbuf]*("""|'''|"|')|("""|'''|"|')$/gi, '').trim();
  }
  return '';
}

function fnSymbol(node: Node): ExtractedSymbol | null {
  const name = node.childForFieldName('name')?.text ?? '';
  if (!name) return null;
  const ctx = enclosing(node);
  if (ctx.inFunction) return null; // skip nested functions
  const params = node.childForFieldName('parameters')?.text ?? '()';
  const ret = node.childForFieldName('return_type')?.text;
  const sig = `${name}${params}${ret ? ': ' + ret : ''}`;
  const jsdoc = docstring(node.childForFieldName('body'));
  if (ctx.className) {
    return { kind: 'method', name: `${ctx.className}.${name}`, signature: `${ctx.className}.${sig}`,
      exported: exported(name), startLine: lineOf(node), jsdoc };
  }
  return { kind: 'function', name, signature: sig, exported: exported(name), startLine: lineOf(node), jsdoc };
}

function constSymbol(node: Node): ExtractedSymbol | null {
  const ctx = enclosing(node);
  if (ctx.className || ctx.inFunction) return null; // module-level only
  const name = node.namedChild(0)?.childForFieldName('left')?.text ?? '';
  if (!name || name.toUpperCase() !== name) return null; // ALL_CAPS only
  return { kind: 'const', name, signature: name, exported: exported(name), startLine: lineOf(node), jsdoc: '' };
}

export const pythonSpec: LangSpec = {
  lang: 'py',
  query: QUERY,
  toSymbol(node) {
    if (node.type === 'function_definition') return fnSymbol(node);
    if (node.type === 'class_definition') {
      const name = node.childForFieldName('name')?.text ?? '';
      if (!name) return null;
      return { kind: 'class', name, signature: `class ${name}`, exported: exported(name),
        startLine: lineOf(node), jsdoc: docstring(node.childForFieldName('body')) };
    }
    return constSymbol(node); // expression_statement with assignment
  },
};
