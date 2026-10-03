/**
 * Hivamis task 7 — the Persian that arrives as data, read in the reader's language where it is shown.
 *
 *   ../api/node_modules/.bin/tsx scripts/i18n-dynamic.mts [--dry] [file …]
 *
 * `tr` translates the words written here; this pass reaches what the API and the contracts hand
 * over: `x.labelFa`, `role.nameFa`, `STATE_LABELS[s].fa`, `CURRENCY_LABELS[c]`, `stateLabelFa(s)`.
 * Where such a value is *shown* — a JSX child, a visible attribute, a toast — it becomes
 *   x.labelFa            → loc(x, 'label')     (the record's English side, else its Persian read back)
 *   ROLE_LABELS[r].fa    → pair(ROLE_LABELS[r])
 *   anything else        → trx(…)
 * Where it is data — an input's value, a filter, a payload — it is left alone. Re-runnable.
 */
import ts from 'typescript';
import path from 'node:path';
import { writeFileSync } from 'node:fs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SKIP_FILES = [/\/src\/i18n\//, /\/src\/lib\/format\.ts$/, /\.d\.ts$/];
/** Attributes that are data, not words on screen. */
const DATA_ATTRS = /^(value|defaultValue|key|className|id|href|to|src|type|name|role|dir|lang|inputMode|htmlFor|data-.*|on[A-Z].*)$/;
const WRAPPERS = new Set(['loc', 'trx', 'pair', 'tr']);

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const only = args.filter((a) => !a.startsWith('--')).map((f) => path.resolve(f));

const cfg = ts.getParsedCommandLineOfConfigFile(path.join(ROOT, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined })!;
const program = ts.createProgram(cfg.fileNames, cfg.options);
const checker = program.getTypeChecker();

// `any` counts: an untyped API row's `nameFa` is still a string by the naming convention.
const stringish = (e: ts.Expression) => {
  const ok = (t: ts.Type): boolean => (t.isUnion() ? t.types.every(ok) : !!(t.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Any)));
  return ok(checker.getTypeAtLocation(e));
};

/** A read of Persian data: x.labelFa, x?.nameFa, X.fa, FOO_LABELS[k], stateLabelFa(…), PERMISSIONS[p]. */
function persianRead(n: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(n)) {
    const name = n.name.text;
    if (/^[a-z][a-zA-Z]*Fa$/.test(name) || name === 'fa') return true;
  }
  if (ts.isElementAccessExpression(n) && ts.isIdentifier(n.expression) && (/_LABELS$/.test(n.expression.text) || n.expression.text === 'PERMISSIONS')) {
    // A map of pairs (ROLE_LABELS[r]) is read through .fa, caught above.
    return stringish(n);
  }
  if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && /^(stateLabelFa|leadSourceFa)$/.test(n.expression.text)) return true;
  return false;
}

function containsRead(n: ts.Node): boolean {
  let found = false;
  const walk = (x: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(x) && ts.isIdentifier(x.expression) && WRAPPERS.has(x.expression.text)) return; // already read
    if (ts.isArrowFunction(x) || ts.isFunctionExpression(x) || ts.isJsxElement(x) || ts.isJsxSelfClosingElement(x)) return;
    if (persianRead(x)) { found = true; return; }
    x.forEachChild(walk);
  };
  walk(n);
  return found;
}

/** Is this expression what ends up on screen? */
function shown(e: ts.Expression): boolean {
  let n: ts.Node = e;
  for (;;) {
    const p = n.parent;
    if (!p) return false;
    if (ts.isParenthesizedExpression(p) || ts.isNonNullExpression(p) || ts.isAsExpression(p)) { n = p; continue; }
    if (ts.isConditionalExpression(p) && p.condition !== n) { n = p; continue; }
    if (ts.isBinaryExpression(p) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(p.operatorToken.kind)) { n = p; continue; }
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && p.right === n) { n = p; continue; }
    if (ts.isJsxExpression(p)) {
      const gp = p.parent;
      if (ts.isJsxElement(gp) || ts.isJsxFragment(gp)) return true;
      if (ts.isJsxAttribute(gp)) return !DATA_ATTRS.test(gp.name.getText());
      return false;
    }
    if (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === 'toast' && p.arguments[0] === n) return true;
    return false;
  }
}

function transform(sf: ts.SourceFile): { text: string; count: number; used: Set<string> } {
  const text = sf.getFullText();
  const edits: { start: number; end: number; repl: string; name: string }[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isExpression(n) && persianRead(n) && !ts.isPropertyAccessExpression(n.parent) && !ts.isElementAccessExpression(n.parent)) {
      // Climb to the expression that is shown; transform there, once.
      let top: ts.Expression = n;
      while (top.parent && (ts.isParenthesizedExpression(top.parent) || ts.isNonNullExpression(top.parent)
        || (ts.isConditionalExpression(top.parent) && top.parent.condition !== top)
        || (ts.isBinaryExpression(top.parent) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(top.parent.operatorToken.kind)))) top = top.parent as ts.Expression;
      const inside = (x: ts.Node) => { for (let p = x.parent; p; p = p.parent) if (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && WRAPPERS.has(p.expression.text)) return true; return false; };
      if (!inside(n) && shown(n)) {
        const src = (x: ts.Node) => text.slice(x.getStart(sf), x.getEnd());
        if (top === n && ts.isPropertyAccessExpression(n) && /^[a-z][a-zA-Z]*Fa$/.test(n.name.text)) {
          edits.push({ start: n.getStart(sf), end: n.getEnd(), repl: `loc(${src(n.expression)}, '${n.name.text.slice(0, -2)}')`, name: 'loc' });
        } else if (top === n && ts.isPropertyAccessExpression(n) && n.name.text === 'fa') {
          edits.push({ start: n.getStart(sf), end: n.getEnd(), repl: `pair(${src(n.expression)})`, name: 'pair' });
        } else if (stringish(top) && !edits.some((e) => e.start <= top.getStart(sf) && e.end >= top.getEnd())) {
          edits.push({ start: top.getStart(sf), end: top.getEnd(), repl: `trx(${src(top)})`, name: 'trx' });
        }
      }
    }
    n.forEachChild(visit);
  };
  visit(sf);
  // Outer edits win; drop any nested inside another.
  edits.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: typeof edits = [];
  for (const e of edits) if (!kept.some((k) => k.start <= e.start && k.end >= e.end)) kept.push(e);
  let out = text;
  for (const e of [...kept].reverse()) out = out.slice(0, e.start) + e.repl + out.slice(e.end);
  return { text: out, count: kept.length, used: new Set(kept.map((k) => k.name)) };
}

function addImport(source: string, file: string, names: Set<string>): string {
  const rel = path.relative(path.dirname(file), path.join(ROOT, 'src/i18n')).replace(/\\/g, '/');
  const spec = rel.startsWith('.') ? rel : `./${rel}`;
  const re = new RegExp(`import \\{([^}]*)\\} from '${spec.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}';`);
  const m = re.exec(source);
  if (m) {
    const have = new Set(m[1]!.split(',').map((x) => x.trim()).filter(Boolean));
    for (const n of names) have.add(n);
    return source.replace(m[0], `import { ${[...have].sort().join(', ')} } from '${spec}';`);
  }
  const lastImport = [...source.matchAll(/^import .*;$/gm)].pop();
  const line = `import { ${[...names].sort().join(', ')} } from '${spec}';`;
  if (!lastImport) return `${line}\n${source}`;
  const at = lastImport.index! + lastImport[0].length;
  return source.slice(0, at) + '\n' + line + source.slice(at);
}

let files = 0, total = 0;
for (const sf of program.getSourceFiles()) {
  const f = sf.fileName;
  if (!f.startsWith(path.join(ROOT, 'src')) || SKIP_FILES.some((r) => r.test(f))) continue;
  if (only.length && !only.includes(f)) continue;
  const { text, count, used } = transform(sf);
  if (!count) continue;
  files++; total += count;
  if (dry) console.log(`${path.relative(ROOT, f)}: ${count}`);
  else writeFileSync(f, addImport(text, f, used));
}
console.log(`${dry ? 'would read' : 'read'} ${total} value(s) in ${files} file(s)`);
