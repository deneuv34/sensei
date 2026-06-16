// src/ast/extract.ts
import ts from 'typescript';
import type { FileExtraction, ExtractedSymbol, ExtractedImport } from '../types.js';

function scriptKind(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (filePath.endsWith('.js')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function hasExportModifier(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function jsdocText(node: ts.Node): string {
  const parts: string[] = [];
  for (const item of ts.getJSDocCommentsAndTags(node)) {
    if (ts.isJSDoc(item) && item.comment) {
      parts.push(
        typeof item.comment === 'string'
          ? item.comment
          : item.comment.map((c) => c.text).join(''),
      );
    }
  }
  return parts.join(' ').trim();
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function paramsText(sf: ts.SourceFile, params: ts.NodeArray<ts.ParameterDeclaration>): string {
  return params.map((p) => p.getText(sf)).join(', ');
}

function callSignature(
  sf: ts.SourceFile,
  name: string,
  params: ts.NodeArray<ts.ParameterDeclaration>,
  ret: ts.TypeNode | undefined,
): string {
  const retText = ret?.getText(sf);
  return `${name}(${paramsText(sf, params)})${retText ? ': ' + retText : ''}`;
}

export function extractFromSource(filePath: string, source: string): FileExtraction {
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind(filePath));
  const symbols: ExtractedSymbol[] = [];
  const imports: ExtractedImport[] = [];

  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      const name = stmt.name.text;
      symbols.push({
        kind: 'function',
        name,
        signature: callSignature(sf, name, stmt.parameters, stmt.type),
        exported: hasExportModifier(stmt),
        startLine: lineOf(sf, stmt),
        jsdoc: jsdocText(stmt),
      });
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      const name = stmt.name.text;
      const exported = hasExportModifier(stmt);
      symbols.push({
        kind: 'class',
        name,
        signature: `class ${name}`,
        exported,
        startLine: lineOf(sf, stmt),
        jsdoc: jsdocText(stmt),
      });
      for (const member of stmt.members) {
        if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
          const mName = member.name.text;
          symbols.push({
            kind: 'method',
            name: `${name}.${mName}`,
            signature: callSignature(sf, mName, member.parameters, member.type),
            exported,
            startLine: lineOf(sf, member),
            jsdoc: jsdocText(member),
          });
        }
      }
    } else if (ts.isInterfaceDeclaration(stmt)) {
      symbols.push({
        kind: 'interface',
        name: stmt.name.text,
        signature: `interface ${stmt.name.text}`,
        exported: hasExportModifier(stmt),
        startLine: lineOf(sf, stmt),
        jsdoc: jsdocText(stmt),
      });
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      symbols.push({
        kind: 'type',
        name: stmt.name.text,
        signature: `type ${stmt.name.text}`,
        exported: hasExportModifier(stmt),
        startLine: lineOf(sf, stmt),
        jsdoc: jsdocText(stmt),
      });
    } else if (ts.isEnumDeclaration(stmt)) {
      symbols.push({
        kind: 'enum',
        name: stmt.name.text,
        signature: `enum ${stmt.name.text}`,
        exported: hasExportModifier(stmt),
        startLine: lineOf(sf, stmt),
        jsdoc: jsdocText(stmt),
      });
    } else if (ts.isVariableStatement(stmt)) {
      const exported = hasExportModifier(stmt);
      const jsdoc = jsdocText(stmt);
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue; // skip destructuring patterns
        const name = decl.name.text;
        symbols.push({
          kind: 'const',
          name,
          signature: name,
          exported,
          startLine: lineOf(sf, decl),
          jsdoc,
        });
      }
    } else if (ts.isImportDeclaration(stmt)) {
      if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      const module = stmt.moduleSpecifier.text;
      const clause = stmt.importClause;
      if (!clause) {
        imports.push({ module, importedName: '' }); // side-effect import
        continue;
      }
      let added = false;
      if (clause.name) {
        imports.push({ module, importedName: 'default' });
        added = true;
      }
      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          imports.push({ module, importedName: '*' });
          added = true;
        } else {
          for (const el of clause.namedBindings.elements) {
            imports.push({ module, importedName: el.name.text });
            added = true;
          }
        }
      }
      if (!added) imports.push({ module, importedName: '' });
    }
  }

  return { symbols, imports };
}
