# Screens

Every page of Hivamis as it opens, on a desktop (`desktop/`, 1440×900) and a phone (`phone/`,
390×844). They were taken by `apps/api/scripts/screen-sweep.ts` (audit UI-V), signed in as each of
the seed's twelve roles, against a production build on a copy of the demo data.

- **Names** follow the route: `projects-id.jpg` is a project's page, `finance.jpg` the finance page.
- **Per role:** the dashboard (`home--…`), My Work (`my-work--…`) and the phone app (`m--…`) differ
  by role, so they are shot once for each role, named after the account (`home--designer.jpg`).
- **Every other page** is shot by the first role that reaches it.

To take them again, against a running stack (see the UI-V section of `docs/audit-2026-10.md`):

```bash
AUDIT_WEB=http://localhost:4173 pnpm --filter @hiva/api exec tsx scripts/screen-sweep.ts
```
