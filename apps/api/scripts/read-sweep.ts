/**
 * Audit PERF-4 — every `findMany` with no `take`: a read whose size is whatever the table holds.
 *
 *   node_modules/.bin/tsx scripts/read-sweep.ts [--json]      (in apps/api)
 *
 * Each is either bounded by what it reads (a fixed reference table, one record's children, ids already
 * in hand) or capped. The reviewed verdicts live in read-sweep.reviewed.ts; tests/057-read-sweep fails
 * on a read nobody has reviewed.
 */
import ts from 'typescript';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { enclosing, files } from './tenant-sweep.js';

const SRC = path.resolve(import.meta.dirname, '../src');

export interface Read { key: string; file: string; line: number; fn: string; model: string; where: string }

export function readSweep(): Read[] {
  const out: Read[] = [];
  for (const file of files(SRC)) {
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const ordinals = new Map<string, number>();
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'findMany'
        && ts.isPropertyAccessExpression(node.expression.expression)) {
        const arg = node.arguments[0];
        const props = arg && ts.isObjectLiteralExpression(arg) ? arg.properties : null;
        const has = (name: string) => !!props?.some((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name.getText(sf) === name);
        if (!has('take')) {
          const model = node.expression.expression.name.text;
          const { name: fn } = enclosing(node, sf);
          const rel = path.relative(SRC, file);
          const base = `${rel}#${fn}#${model}`;
          const n = (ordinals.get(base) ?? 0) + 1;
          ordinals.set(base, n);
          const where = props?.find((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name.getText(sf) === 'where');
          out.push({ key: `${base}#${n}`, file: rel, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, fn, model, where: (where ?? arg)?.getText(sf).replace(/\s+/g, ' ').slice(0, 140) ?? '' });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

/** The audit doc's list of reviewed reads (`--doc`), from the sweep and its verdicts. */
async function doc(reads: Read[]): Promise<string> {
  const { REVIEWED, WHY } = await import('./read-sweep.reviewed.js');
  const verdicts = REVIEWED as Record<string, string>;
  const why = WHY as Record<string, string>;
  const out = [`${reads.length} reads without a \`take\`, each with a verdict:`, '', '| Verdict | Reads | Why it is bounded |', '|---|---|---|'];
  for (const v of Object.keys(why)) out.push(`| ${v} | ${reads.filter((r) => verdicts[r.key] === v).length} | ${why[v]} |`);
  out.push('');
  for (const v of Object.keys(why)) {
    const mine = reads.filter((r) => verdicts[r.key] === v);
    if (!mine.length) continue;
    out.push(`<details><summary>${v} — ${mine.length} reads</summary>`, '');
    for (const r of mine) out.push(`- \`${r.file}\` ${r.fn} — \`${r.model}\``);
    out.push('', '</details>', '');
  }
  return out.join('\n');
}

if (process.argv[1] && /read-sweep\.(mts|ts)$/.test(process.argv[1])) {
  const reads = readSweep();
  if (process.argv.includes('--doc')) process.stdout.write(await doc(reads));
  else if (process.argv.includes('--json')) console.log(JSON.stringify(reads, null, 1));
  else { for (const r of reads) console.log(`${r.file}:${r.line}  ${r.fn}  ${r.model}  ${r.where}`); console.log(`${reads.length} findMany without take`); }
}
