/**
 * The operator's commands (roadmap #50), run where the API runs:
 *   node dist/cli.js <command> [--flag value …] [--json]      (in the container)
 *   pnpm --filter @hiva/api cli <command> …                    (in development)
 *
 *   status                 version, schema, last reference sync, organisations
 *   reference:sync         bring every organisation's reference data up to the code [--slug s]
 *   tenant:list            the organisations on this installation
 *   tenant:create          --name --slug --admin-email --admin-name [--host h]… [--legal-name] [--currency] [--timezone]
 *   tenant:update          --slug [--name] [--add-host h]… [--remove-host h]… [--suspend | --resume] [--quota-mb N | --quota-mb none]
 *   demo:deactivate        deactivate every demo account (@hiva.local) and end its sessions — what a
 *                          production API that refuses to start asks for (audit SEC-8)
 *   org:reset              --keep-admin EMAIL [--slug s] [--password-stdin] [--yes]
 *                          a clean start: every person and record but that system administrator, the
 *                          history kept (src/setup/reset.ts). Without --yes, says what it would delete.
 *                          The new password, if any, comes on standard input — never on the command line.
 */
import { prisma } from './db.js';
import { AppError } from './lib/errors.js';
import { deactivateDemoAccounts } from './lib/demo-accounts.js';
import { syncReference } from './setup/reference.js';
import { listOrganizations, provisionOrganization, systemStatus, updateOrganization } from './setup/tenant.js';
import { APP_VERSION } from './version.js';
import { planReset, resetOrganization } from './setup/reset.js';

/** Standard input, whole, without its last line break: how a password reaches this, unseen by `ps`. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

/** The organisation named, or the only one there is. */
async function organizationFor(slug: string | undefined): Promise<string> {
  if (slug) return (await prisma.organization.findUniqueOrThrow({ where: { slug }, select: { id: true } })).id;
  const all = await prisma.organization.findMany({ select: { id: true, slug: true }, take: 2 });
  if (all.length !== 1) throw new AppError(400, 'MISSING_FLAG', '--slug لازم است: این نصب بیش از یک سازمان دارد.');
  return all[0]!.id;
}

type Flags = Record<string, string[]>;

export function parseArgs(argv: string[]): { command: string; flags: Flags } {
  const [command = 'help', ...rest] = argv;
  const flags: Flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = rest[i + 1];
    const value = next !== undefined && !next.startsWith('--') ? (i++, next) : 'true';
    (flags[key] ??= []).push(value);
  }
  return { command, flags };
}

const one = (f: Flags, k: string) => f[k]?.[f[k]!.length - 1];
/** `--quota-mb 2048`, or `none` for no limit (audit LOG-5); absent leaves it as it is. */
const quotaOf = (v: string | undefined): number | null | undefined => {
  if (v === undefined) return undefined;
  if (v === 'none') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new AppError(400, 'BAD_QUOTA', '--quota-mb یک عدد درست مثبت یا none است.');
  return n;
};
const need = (f: Flags, k: string) => {
  const v = one(f, k);
  if (!v || v === 'true') throw new AppError(400, 'MISSING_FLAG', `--${k} لازم است.`);
  return v;
};

export async function run(argv: string[]): Promise<unknown> {
  const { command, flags } = parseArgs(argv);
  switch (command) {
    case 'status':
      return systemStatus();
    case 'reference:sync': {
      const slug = one(flags, 'slug');
      const only = slug ? [(await prisma.organization.findUniqueOrThrow({ where: { slug }, select: { id: true } })).id] : undefined;
      return syncReference(prisma, { trigger: 'manual', appVersion: APP_VERSION, only });
    }
    case 'tenant:list':
      return listOrganizations();
    case 'tenant:create':
      return provisionOrganization({
        name: need(flags, 'name'), slug: need(flags, 'slug'),
        legalName: one(flags, 'legal-name'), currency: one(flags, 'currency'), timezone: one(flags, 'timezone'),
        hosts: flags.host ?? [],
        admin: { email: need(flags, 'admin-email'), fullName: need(flags, 'admin-name') },
      });
    case 'tenant:update':
      return updateOrganization(need(flags, 'slug'), {
        name: one(flags, 'name'), addHosts: flags['add-host'], removeHosts: flags['remove-host'],
        active: flags.suspend ? false : flags.resume ? true : undefined,
        storageQuotaMb: quotaOf(one(flags, 'quota-mb')),
      });
    case 'demo:deactivate':
      return deactivateDemoAccounts();
    case 'org:reset': {
      const organizationId = await organizationFor(one(flags, 'slug'));
      const email = need(flags, 'keep-admin');
      if (!flags.yes) return { dryRun: true, ...(await planReset(organizationId, email)) };
      const password = flags['password-stdin'] ? await readStdin() : undefined;
      return resetOrganization(organizationId, email, password || undefined);
    }
    default:
      return {
        usage: 'status | reference:sync [--slug s] | tenant:list | tenant:create --name --slug --admin-email --admin-name [--host h]… | tenant:update --slug [--name] [--add-host h] [--remove-host h] [--suspend|--resume] [--quota-mb N|none] | demo:deactivate | org:reset --keep-admin EMAIL [--slug s] [--password-stdin] [--yes]',
      };
  }
}

const isMain = process.argv[1] && /cli\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  run(process.argv.slice(2))
    .then((out) => {
      process.stdout.write(`${JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2)}\n`);
      return prisma.$disconnect();
    })
    .catch(async (e: unknown) => {
      const err = e as { code?: string; message?: string };
      process.stderr.write(`${JSON.stringify({ error: { code: err.code ?? 'FAILED', message: err.message ?? String(e) } })}\n`);
      await prisma.$disconnect();
      process.exit(1);
    });
}
