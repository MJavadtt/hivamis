/**
 * Hivamis task 7 — puts every visible Persian string of the web app through `tr`, so the English
 * catalogue can translate it. Re-runnable: what is already wrapped is left alone.
 *
 *   ../api/node_modules/.bin/tsx scripts/i18n-wrap.mts [--dry] [file …]
 *
 * - JSX text: a run of text and values becomes one sentence with placeholders —
 *   «فرستنده: {name}» → {tr('فرستنده: {0}', name)} — but only values the type checker says are
 *   strings or numbers (a boolean or a React node renders differently inside a sentence).
 * - A Persian attribute (label="…") becomes label={tr('…')}.
 * - A Persian string or template anywhere else becomes tr('…') / tr('… {0} …', value).
 * Imports, object keys, types and strings already inside tr() are left as they are.
 */
import ts from 'typescript';
import path from 'node:path';
import { writeFileSync } from 'node:fs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PERSIAN = /[؀-ۿ]/;
const SKIP_FILES = [/\/src\/i18n\//, /\/src\/lib\/format\.ts$/, /\/src\/lib\/help\.ts$/, /\.d\.ts$/];
const SKIP_ATTRS = new Set(['className', 'data-testid', 'id', 'key', 'href', 'to', 'src', 'type', 'name', 'role', 'dir', 'lang', 'inputMode']);

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const only = args.filter((a) => !a.startsWith('--')).map((f) => path.resolve(f));

const cfg = ts.getParsedCommandLineOfConfigFile(path.join(ROOT, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined })!;
const program = ts.createProgram(cfg.fileNames, cfg.options);
const checker = program.getTypeChecker();

const quote = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '')}'`;

/** JSX's own whitespace rule for a text child (what React renders). */
function jsxTextValue(raw: string): string {
  const lines = raw.split(/\r\n|\n|\r/);
  if (lines.length === 1) return raw;
  return lines
    .map((l, i) => {
      let x = l;
      if (i > 0) x = x.replace(/^[ \t]+/, '');
      if (i < lines.length - 1) x = x.replace(/[ \t]+$/, '');
      return x;
    })
    .filter((x) => x.length)
    .join(' ');
}

/** Renders the same inside a sentence: strings and numbers (and nothing at all). */
function primitive(expr: ts.Expression): boolean {
  const ok = (t: ts.Type): boolean => {
    if (t.isUnion()) return t.types.every(ok);
    const f = t.flags;
    return !!(f & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined));
  };
  return ok(checker.getTypeAtLocation(expr));
}

const containsJsx = (n: ts.Node): boolean => {
  let found = false;
  const walk = (x: ts.Node) => { if (found) return; if (ts.isJsxElement(x) || ts.isJsxSelfClosingElement(x) || ts.isJsxFragment(x)) { found = true; return; } x.forEachChild(walk); };
  walk(n);
  return found;
};

const isTrCall = (n: ts.Node | undefined) => !!n && ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'tr';

function transformFile(sf: ts.SourceFile): { text: string; count: number } {
  const text = sf.getFullText();
  let count = 0;

  const emitChildren = (node: ts.Node, from: number, to: number): string => {
    let out = '';
    let pos = from;
    node.forEachChild((child) => {
      const cs = child.getStart(sf);
      if (cs < pos) return;
      out += text.slice(pos, cs) + emit(child);
      pos = child.getEnd();
    });
    return out + text.slice(pos, to);
  };

  function stringLiteralSkipped(n: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral): boolean {
    const p = n.parent;
    if (!p) return true;
    if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p)) return true;
    if (ts.isLiteralTypeNode(p)) return true;
    if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p)) && p.name === n) return true;
    if (ts.isElementAccessExpression(p) && p.argumentExpression === n) return true;
    if (ts.isCaseClause(p)) return true;
    if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(p.operatorToken.kind)) return true;
    if (isTrCall(p) && (p as ts.CallExpression).arguments[0] === n) return true;
    if (ts.isJsxAttribute(p)) return true; // handled with the attribute
    if (ts.isTaggedTemplateExpression(p)) return true;
    // console messages are for developers
    if (ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression) && ts.isIdentifier(p.expression.expression) && p.expression.expression.text === 'console') return true;
    return false;
  }

  /** A JSX child as written — JSX text carries its own whitespace, so take it from its pos. */
  const raw = (x: ts.JsxChild) => (ts.isJsxText(x) ? text.slice(x.pos, x.end) : text.slice(x.pos, x.getStart(sf)) + emit(x));

  function emitJsxChildren(children: ts.NodeArray<ts.JsxChild>): string {
    const runnable = (x: ts.JsxChild) => ts.isJsxText(x) || (ts.isJsxExpression(x) && (!x.expression || (!containsJsx(x.expression) && primitive(x.expression))));
    let out = '';
    let i = 0;
    while (i < children.length) {
      if (!runnable(children[i]!)) { out += raw(children[i]!); i++; continue; }
      let j = i;
      while (j < children.length && runnable(children[j]!)) j++;
      const run = children.slice(i, j);
      i = j;
      if (!run.some((x) => ts.isJsxText(x) && PERSIAN.test(x.text))) { out += run.map(raw).join(''); continue; }
      // One sentence: each text child as React renders it, each value a placeholder.
      let template = '';
      const values: string[] = [];
      for (const x of run) {
        if (ts.isJsxText(x)) template += jsxTextValue(x.text);
        else if (x.expression) { template += `{${values.length}}`; values.push(emit(x.expression)); }
      }
      // Spaces at the edges separate the sentence from its neighbours; they stay outside the key.
      const leading = template.match(/^\s*/)![0], trailing = template.slice(template.trimEnd().length);
      const keep = (ws: string) => (ws ? `{${quote(ws)}}` : '');
      out += `${keep(leading)}{tr(${[quote(template.trim()), ...values].join(', ')})}${keep(trailing)}`;
      count++;
    }
    return out;
  }

  function emit(node: ts.Node): string {
    // JSX elements and fragments: the children are read as sentences.
    if (ts.isJsxElement(node)) {
      return emit(node.openingElement) + emitJsxChildren(node.children) + text.slice(node.closingElement.getFullStart(), node.closingElement.getEnd());
    }
    if (ts.isJsxFragment(node)) {
      return text.slice(node.openingFragment.getStart(sf), node.openingFragment.getEnd()) + emitJsxChildren(node.children) + text.slice(node.closingFragment.getFullStart(), node.closingFragment.getEnd());
    }
    if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer) && PERSIAN.test(node.initializer.text) && !SKIP_ATTRS.has(node.name.getText(sf))) {
      count++;
      return `${node.name.getText(sf)}={tr(${quote(node.initializer.text)})}`;
    }
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && PERSIAN.test(node.text) && !stringLiteralSkipped(node)) {
      count++;
      return `tr(${quote(node.text)})`;
    }
    if (ts.isTemplateExpression(node) && !ts.isTaggedTemplateExpression(node.parent) && !isTrCall(node.parent)) {
      const literal = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join('');
      if (PERSIAN.test(literal)) {
        let template = node.head.text;
        const values: string[] = [];
        node.templateSpans.forEach((s, k) => { template += `{${k}}${s.literal.text}`; values.push(emit(s.expression)); });
        count++;
        return `tr(${[quote(template), ...values].join(', ')})`;
      }
    }
    return emitChildren(node, node.getStart(sf), node.getEnd());
  }

  let out = '';
  let pos = 0;
  sf.forEachChild((child) => {
    out += text.slice(pos, child.getStart(sf)) + emit(child);
    pos = child.getEnd();
  });
  out += text.slice(pos);
  return { text: out, count };
}

function addImport(sf: ts.SourceFile, source: string): string {
  if (/import \{[^}]*\btr\b[^}]*\} from '[^']*i18n'/.test(source)) return source;
  const rel = path.relative(path.dirname(sf.fileName), path.join(ROOT, 'src/i18n')).replace(/\\/g, '/');
  const spec = rel.startsWith('.') ? rel : `./${rel}`;
  const imports = sf.statements.filter(ts.isImportDeclaration);
  const line = `import { tr } from '${spec}';\n`;
  if (!imports.length) return line + source;
  const lastEnd = imports[imports.length - 1]!.getEnd();
  // Positions refer to the original text; the import goes after the last original import.
  return source.slice(0, lastEnd) + '\n' + line.trimEnd() + source.slice(lastEnd);
}

let files = 0, total = 0;
for (const sf of program.getSourceFiles()) {
  const f = sf.fileName;
  if (!f.startsWith(path.join(ROOT, 'src')) || SKIP_FILES.some((r) => r.test(f))) continue;
  if (only.length && !only.includes(f)) continue;
  const { text, count } = transformFile(sf);
  if (!count) continue;
  files++; total += count;
  // The import is placed by original positions: transform first, then insert into the new text at
  // the same offset is unsafe — so insert the import into the transformed text after its imports.
  const tsf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, f.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const result = addImport(tsf, text);
  if (dry) console.log(`${path.relative(ROOT, f)}: ${count}`);
  else writeFileSync(f, result);
}
console.log(`${dry ? 'would wrap' : 'wrapped'} ${total} string(s) in ${files} file(s)`);
