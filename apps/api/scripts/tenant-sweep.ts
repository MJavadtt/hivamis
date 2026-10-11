/**
 * Audit SEC-2b — every Prisma query on tenant data whose `where` does not reach an organisation.
 *
 *   node_modules/.bin/tsx scripts/tenant-sweep.ts [--json]      (in apps/api)
 *
 * Walks apps/api/src with the TypeScript compiler and reports each `<client>.<model>.<op>(…)` where
 * - the model belongs to an organisation (its own `organizationId`, or a parent's — the same rule
 *   lib/scope.ts follows), and
 * - the `where` mentions no organisation: no `organizationId`, no `organizationWhere(…)`, no tenant
 *   scope helper.
 *
 * Each hit is either scoped by something earlier in the function (a record already found in the
 * caller's organisation, the caller's own user) or a leak. The reviewed verdicts live in
 * tenant-sweep.reviewed.ts; tests/039-tenant-sweep fails on a hit nobody has reviewed.
 */
import ts from 'typescript';
import path from 'node:path';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { Prisma } from '@prisma/client';

const SRC = path.resolve(import.meta.dirname, '../src');
const OPS = /^(find(First|Unique|Many)(OrThrow)?|update(Many)?|delete(Many)?|count|upsert|aggregate|groupBy)$/;
const SCOPED = /organizationId|organizationWhere|tenant\(|scopeOf|orgScope|\.\.\.scope\b|inOrg\(|ownWhere/;

type Model = (typeof Prisma.dmmf.datamodel.models)[number];
const models = Prisma.dmmf.datamodel.models;
const byName = new Map(models.map((m) => [m.name, m]));
const accessorOf = (m: Model) => m.name[0]!.toLowerCase() + m.name.slice(1);
const hasOrg = (m: Model) => m.fields.some((f) => f.name === 'organizationId' && f.kind === 'scalar');

/** Tenant models, by accessor: the same fixed point the isolation harness uses. */
const tenant = (() => {
  const set = new Set(models.filter(hasOrg).map((m) => m.name));
  for (let grew = true; grew;) {
    grew = false;
    for (const m of models) {
      if (set.has(m.name)) continue;
      const parents = m.fields.filter((f) => f.kind === 'object' && f.isRequired && (f.relationFromFields?.length ?? 0) > 0);
      if (parents.some((p) => set.has(p.type))) { set.add(m.name); grew = true; }
    }
  }
  return new Set([...set].map((n) => accessorOf(byName.get(n)!)));
})();

export interface Hit {
  /** Stable across edits that do not touch the query: file, enclosing function, model.op, ordinal. */
  key: string;
  file: string;
  line: number;
  /** Where the enclosing function starts: what came before the query in it is its context. */
  fnLine: number;
  fn: string;
  model: string;
  op: string;
  where: string;
}

export function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.ts$/.test(n) && !/\.d\.ts$/.test(n) ? [p] : [];
  });
}

/** The function a node sits in — `name`, `POST /x` for a route, or `<top>` — and the line it starts on. */
export function enclosing(node: ts.Node, sf: ts.SourceFile): { name: string; line: number } {
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) && p.name) return { name: p.name.text, line: at(p) };
    if (ts.isMethodDeclaration(p) && ts.isIdentifier(p.name)) return { name: p.name.text, line: at(p) };
    if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p))) {
      const holder = p.parent;
      if (holder && ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)) return { name: holder.name.text, line: at(p) };
      if (holder && ts.isPropertyAssignment(holder)) return { name: holder.name.getText(sf), line: at(p) };
      if (holder && ts.isCallExpression(holder)) {
        const callee = holder.expression.getText(sf);
        const route = /^app\.(get|post|put|patch|delete)$/.exec(callee);
        const first = holder.arguments[0];
        if (route && first && ts.isStringLiteral(first)) return { name: `${route[1]!.toUpperCase()} ${first.text}`, line: at(p) };
      }
    }
  }
  return { name: '<top>', line: 1 };
}

export function sweep(): Hit[] {
  const hits: Hit[] = [];
  for (const file of files(SRC)) {
    const text = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const ordinals = new Map<string, number>();
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const op = node.expression.name.text;
        const target = node.expression.expression;
        if (OPS.test(op) && ts.isPropertyAccessExpression(target)) {
          const model = target.name.text;
          const client = target.expression.getText(sf);
          if (tenant.has(model) && /^(prisma|tx|t|db|client|this\.db|ctx\.db|trx)$/.test(client)) {
            const arg = node.arguments[0];
            const where = arg && ts.isObjectLiteralExpression(arg)
              ? arg.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(sf) === 'where' || ts.isShorthandPropertyAssignment(p) && p.name.text === 'where')
              : undefined;
            const whereText = where ? where.getText(sf) : arg ? arg.getText(sf) : '';
            if (!SCOPED.test(whereText)) {
              const { name: fn, line: fnLine } = enclosing(node, sf);
              const rel = path.relative(SRC, file);
              const base = `${rel}#${fn}#${model}.${op}`;
              const n = (ordinals.get(base) ?? 0) + 1;
              ordinals.set(base, n);
              hits.push({
                key: `${base}#${n}`, file: rel, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
                fnLine, fn, model, op, where: whereText.replace(/\s+/g, ' ').slice(0, 160),
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return hits;
}

if (process.argv[1] && /tenant-sweep\.(mts|ts)$/.test(process.argv[1])) {
  const hits = sweep();
  if (process.argv.includes('--json')) console.log(JSON.stringify(hits, null, 1));
  else {
    for (const h of hits) console.log(`${h.file}:${h.line}  ${h.fn}  ${h.model}.${h.op}  ${h.where}`);
    console.log(`${hits.length} unscoped quer${hits.length === 1 ? 'y' : 'ies'} on tenant models`);
  }
}
