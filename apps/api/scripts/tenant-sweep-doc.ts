/**
 * Prints the "reviewed list" section of docs/audit-2026-10.md from the sweep and its verdicts, so the
 * document stays what the code is (audit SEC-2b):
 *   ./node_modules/.bin/tsx scripts/tenant-sweep-doc.ts > /tmp/section.md
 */
import { sweep } from './tenant-sweep.js';
import { REVIEWED, WHY } from './tenant-sweep.reviewed.js';

const hits = sweep() as { file: string; fn: string }[];
const per = new Map<string, number>();
for (const h of hits) { const k = `${h.file}#${h.fn}`; per.set(k, (per.get(k) ?? 0) + 1); }
const verdicts = REVIEWED as Record<string, string>;
const why = WHY as Record<string, string>;
const of = (v: string) => Object.keys(verdicts).filter((k) => verdicts[k] === v).sort();

const out: string[] = ['### The reviewed list', '', `${hits.length} queries in ${per.size} functions, every one with a verdict (kept current as later items change them):`, '',
  '| Verdict | Functions | Queries | Why it is scoped |', '|---|---|---|---|'];
for (const v of Object.keys(why)) out.push(`| ${v} | ${of(v).length} | ${of(v).reduce((s, k) => s + (per.get(k) ?? 0), 0)} | ${why[v]} |`);
out.push('');
for (const v of Object.keys(why)) {
  out.push(`<details><summary>${v} — ${of(v).length} functions</summary>`, '');
  for (const k of of(v)) out.push(`- \`${k}\` (${per.get(k) ?? 0})`);
  out.push('', '</details>', '');
}
process.stdout.write(out.join('\n'));
