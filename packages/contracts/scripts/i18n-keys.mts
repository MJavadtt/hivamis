/**
 * Hivamis task 7 — the Persian the API and the contracts put in front of people, as catalogue keys.
 *
 *   ../../apps/api/node_modules/.bin/tsx scripts/i18n-keys.mts [--json] [--missing]
 *
 * Every Persian string or template (`${x}` → {0}) in packages/contracts/src and apps/api/src, and the
 * demo organisation's job titles from the seed,
 * except what is not read as interface text: documents and emails that keep the language they were
 * issued in (pdf/, mail/), what is said to a language model (ai/, ask/model.ts), the words the
 * question parser looks for, comparisons, patterns and log lines.
 */
import ts from 'typescript';
import path from 'node:path';
import { readFileSync, readdirSync, statSync } from 'node:fs';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const SOURCES = [path.join(ROOT, 'packages/contracts/src'), path.join(ROOT, 'apps/api/src')];
const SKIP = [
  /\/contracts\/src\/i18n\.ts$/,
  // The guide carries its own English beside each Persian line (Hivamis task 8).
  /\/contracts\/src\/guide\.ts$/,
  /\/api\/src\/pdf\//, /\/api\/src\/mail\//, /\/api\/src\/ai\//, /\/api\/src\/ask\/model\.ts$/,
  // Documents: the approval certificate and accounting vouchers keep the language they were issued in.
  /\/api\/src\/approvals\/certificate\.ts$/, /\/api\/src\/accounting\/vouchers\.ts$/,
];
/** Email and certificate markup is a document, not interface text. */
const MARKUP = /<(div|p|ul|li|b|a|code|br|table|tr|td|h\d)[\s>/]/i;
const PERSIAN_LETTER = /[ء-يٹ-ۓپچژکگی]/;
/** Properties whose Persian is vocabulary for matching, a prompt, or an example in Persian on purpose. */
const SKIP_PROPS = new Set(['synonyms', 'words', 'aliases', 'keywords', 'example', 'examples', 'prompt', 'system', 'pattern']);
const SKIP_VARS = /(_WORDS|WORDS|STOP|SYNONYMS|ALIASES|_RE|PATTERN|PROMPT)$/i;
const MATCHERS = new Set(['includes', 'startsWith', 'endsWith', 'indexOf', 'split', 'replace', 'replaceAll', 'match', 'test', 'take', 'search']);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.ts$/.test(n) && !/\.d\.ts$/.test(n) ? [p] : [];
  });
}

function skipped(n: ts.Node): boolean {
  for (let p: ts.Node | undefined = n.parent, child: ts.Node = n; p; child = p, p = p.parent) {
    if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isLiteralTypeNode(p) || ts.isCaseClause(p)) return true;
    if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p)) && p.name === child) return true;
    if (ts.isPropertyAssignment(p) && SKIP_PROPS.has(p.name.getText())) return true;
    if (ts.isPropertyAssignment(p) && /En$/.test(p.name.getText())) return true;
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && SKIP_VARS.test(p.name.text)) return true;
    if (ts.isElementAccessExpression(p) && p.argumentExpression === child) return true;
    if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(p.operatorToken.kind)) return true;
    if (ts.isNewExpression(p) && /^(RegExp|Set)$/.test(p.expression.getText())) return true;
    // Header aliases for the import files: words looked for, not shown.
    if (ts.isArrayLiteralExpression(p) && ts.isCallExpression(p.parent) && p.parent.expression.getText() === 'col') return true;
    if (ts.isCallExpression(p)) {
      const callee = p.expression.getText();
      if (/^(console|logger|log|app\.log|request\.log|req\.log|fastify\.log)\b/.test(callee) || /\.log\.(info|warn|error|debug)$/.test(callee)) return true;
      if (ts.isPropertyAccessExpression(p.expression) && MATCHERS.has(p.expression.name.text) && p.arguments[0] === child) return true;
      if (/^(word|normalisePersian)$/.test(callee)) return true;
    }
    // Only the nearest statement-level context matters.
    if (ts.isStatement(p) || ts.isSourceFile(p)) break;
  }
  return false;
}

/**
 * English the source already carries: `labelFa` beside `labelEn`, `fa` beside `en` in one object.
 * These need no translator — the pair is the translation.
 */
export function pairedEnglish(): Map<string, string> {
  const out = new Map<string, string>();
  for (const dir of SOURCES) {
    for (const f of files(dir)) {
      if (SKIP.some((r) => r.test(f))) continue;
      const sf = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (n: ts.Node) => {
        if (ts.isObjectLiteralExpression(n)) {
          const props = new Map<string, string>();
          for (const p of n.properties) {
            if (ts.isPropertyAssignment(p) && (ts.isStringLiteral(p.initializer) || ts.isNoSubstitutionTemplateLiteral(p.initializer))) props.set(p.name.getText(sf), p.initializer.text);
          }
          for (const [name, fa] of props) {
            const base = name === 'fa' ? '' : name.endsWith('Fa') ? name.slice(0, -2) : null;
            if (base === null || !PERSIAN_LETTER.test(fa)) continue;
            const en = props.get(base ? `${base}En` : 'en');
            if (en && !PERSIAN_LETTER.test(en) && !out.has(fa)) out.set(fa, en);
          }
        }
        n.forEachChild(visit);
      };
      visit(sf);
    }
  }
  return out;
}

export function serverKeys(): Map<string, string> {
  const out = new Map<string, string>(); // key → first file
  for (const dir of SOURCES) {
    for (const f of files(dir)) {
      if (SKIP.some((r) => r.test(f))) continue;
      const sf = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (n: ts.Node) => {
        let key: string | null = null;
        if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && PERSIAN_LETTER.test(n.text)) key = n.text;
        else if (ts.isTemplateExpression(n)) {
          const literal = [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join('');
          if (PERSIAN_LETTER.test(literal)) key = n.head.text + n.templateSpans.map((s, i) => `{${i}}${s.literal.text}`).join('');
        }
        if (key !== null && !MARKUP.test(key) && !skipped(n)) {
          const k = key.trim() === key ? key : key; // keys keep their spacing; the translator trims on lookup
          if (!out.has(k)) out.set(k, path.relative(ROOT, f));
        }
        n.forEachChild(visit);
      };
      visit(sf);
    }
  }
  // The demo organisation's job titles: what a fresh installation shows next to every name.
  const seed = path.join(ROOT, 'apps/api/prisma/seed.ts');
  const sf = ts.createSourceFile(seed, readFileSync(seed, 'utf8'), ts.ScriptTarget.Latest, true);
  const visit = (n: ts.Node) => {
    // Only a person's title — an object that also has an email — not a record's title, which is data.
    const isPerson = (o: ts.Node) => ts.isObjectLiteralExpression(o) && o.properties.some((x) => x.name?.getText(sf) === 'email');
    if (ts.isPropertyAssignment(n) && /^(title|jobTitle)$/.test(n.name.getText(sf)) && ts.isStringLiteral(n.initializer) && isPerson(n.parent)
      && PERSIAN_LETTER.test(n.initializer.text) && !out.has(n.initializer.text)) out.set(n.initializer.text, path.relative(ROOT, seed));
    n.forEachChild(visit);
  };
  visit(sf);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const keys = serverKeys();
  const catalogue = JSON.parse(readFileSync(path.join(ROOT, 'packages/contracts/i18n/en.json'), 'utf8').toString() || '{}') as Record<string, string>;
  const missing = [...keys.keys()].filter((k) => catalogue[k] === undefined);
  if (process.argv.includes('--json')) console.log(JSON.stringify([...keys].map(([k, f]) => [f, k])));
  else if (process.argv.includes('--missing')) { for (const k of missing) console.log(`${keys.get(k)}\t${k}`); console.log(`${keys.size} key(s); ${missing.length} without English`); }
  else console.log(`${keys.size} key(s); ${missing.length} without English`);
}
