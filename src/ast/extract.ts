import { Project, SyntaxKind } from 'ts-morph';
import type { FileExtraction, ExtractedSymbol, ExtractedImport } from '../types.js';

function jsdocOf(node: { getJsDocs?: () => Array<{ getCommentText(): string | undefined }> }): string {
  const docs = node.getJsDocs?.() ?? [];
  return docs.map((d) => d.getCommentText() ?? '').join(' ').trim();
}

export function extractFromSource(filePath: string, source: string): FileExtraction {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: true },
  });
  const sf = project.createSourceFile(filePath, source, { overwrite: true });

  const symbols: ExtractedSymbol[] = [];
  const push = (s: ExtractedSymbol) => symbols.push(s);

  // Functions
  for (const fn of sf.getFunctions()) {
    const name = fn.getName();
    if (!name) continue;
    const params = fn.getParameters().map((p) => p.getText()).join(', ');
    const ret = fn.getReturnTypeNode()?.getText();
    push({
      kind: 'function',
      name,
      signature: `${name}(${params})${ret ? ': ' + ret : ''}`,
      exported: fn.isExported(),
      startLine: fn.getStartLineNumber(),
      jsdoc: jsdocOf(fn as never),
    });
  }

  // Classes + methods
  for (const cls of sf.getClasses()) {
    const name = cls.getName();
    if (!name) continue;
    push({
      kind: 'class',
      name,
      signature: `class ${name}`,
      exported: cls.isExported(),
      startLine: cls.getStartLineNumber(),
      jsdoc: jsdocOf(cls as never),
    });
    for (const m of cls.getMethods()) {
      const params = m.getParameters().map((p) => p.getText()).join(', ');
      const ret = m.getReturnTypeNode()?.getText();
      push({
        kind: 'method',
        name: `${name}.${m.getName()}`,
        signature: `${m.getName()}(${params})${ret ? ': ' + ret : ''}`,
        exported: cls.isExported(),
        startLine: m.getStartLineNumber(),
        jsdoc: jsdocOf(m as never),
      });
    }
  }

  // Interfaces / type aliases / enums
  for (const i of sf.getInterfaces()) {
    push({ kind: 'interface', name: i.getName(), signature: `interface ${i.getName()}`, exported: i.isExported(), startLine: i.getStartLineNumber(), jsdoc: jsdocOf(i as never) });
  }
  for (const t of sf.getTypeAliases()) {
    push({ kind: 'type', name: t.getName(), signature: `type ${t.getName()}`, exported: t.isExported(), startLine: t.getStartLineNumber(), jsdoc: jsdocOf(t as never) });
  }
  for (const e of sf.getEnums()) {
    push({ kind: 'enum', name: e.getName(), signature: `enum ${e.getName()}`, exported: e.isExported(), startLine: e.getStartLineNumber(), jsdoc: jsdocOf(e as never) });
  }

  // Top-level variable declarations only
  for (const vd of sf.getVariableDeclarations()) {
    const stmt = vd.getVariableStatement();
    if (!stmt || stmt.getParentOrThrow().getKind() !== SyntaxKind.SourceFile) continue;
    push({
      kind: 'const',
      name: vd.getName(),
      signature: vd.getName(),
      exported: stmt.isExported(),
      startLine: vd.getStartLineNumber(),
      jsdoc: jsdocOf(stmt as never),
    });
  }

  // Imports
  const imports: ExtractedImport[] = [];
  for (const imp of sf.getImportDeclarations()) {
    const module = imp.getModuleSpecifierValue();
    if (imp.getDefaultImport()) imports.push({ module, importedName: 'default' });
    if (imp.getNamespaceImport()) imports.push({ module, importedName: '*' });
    for (const n of imp.getNamedImports()) imports.push({ module, importedName: n.getName() });
    if (!imp.getDefaultImport() && !imp.getNamespaceImport() && imp.getNamedImports().length === 0) {
      imports.push({ module, importedName: '' }); // side-effect import
    }
  }

  return { symbols, imports };
}
