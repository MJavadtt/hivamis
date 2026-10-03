/**
 * Hivamis task 7 — every key the web app passes to tr(), read with the TypeScript parser, so the
 * English catalogue can be checked against it (tests/english.test.tsx) and extended (--missing).
 *
 *   ../api/node_modules/.bin/tsx scripts/i18n-keys.mts [--missing] [--json]
 */
import ts from 'typescript';
import path from 'node:path';
import { readdirSync, readFileSync, statSync } from 'node:fs';

const ROOT = path.resolve(import.meta.dirname, '..');
function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d)) { const f = path.join(d, e); if (statSync(f).isDirectory()) walk(f); else if (/\.tsx?$/.test(f)) files.push(f); } };
  walk(path.join(ROOT, 'src'));
  return files;
}

export function keysOf(source: string, file = 'x.tsx'): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'tr') {
      const a = n.arguments[0];
      if (a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))) out.push(a.text);
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return out;
}

/** Every key in the app, with the files that use it. */
export function allKeys(): Map<string, string[]> {
  const keys = new Map<string, string[]>();
  for (const f of sourceFiles()) for (const k of keysOf(readFileSync(f, 'utf8'), f)) keys.set(k, [...(keys.get(k) ?? []), path.relative(ROOT, f)]);
  return keys;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const keys = allKeys();
  const en = JSON.parse(readFileSync(path.join(ROOT, 'src/i18n/en.json'), 'utf8')) as Record<string, string>;
  const missing = [...keys.keys()].filter((k) => !(k in en));
  if (process.argv.includes('--json')) console.log(JSON.stringify(process.argv.includes('--missing') ? missing : [...keys.keys()], null, 1));
  else console.log(`${keys.size} key(s); ${missing.length} without English`);
}
