# Extensions (roadmap #47)

An extension adds guards and effects to the workflow engine without forking Hivamis. Put
`.js`/`.mjs` modules in a directory and point `EXTENSIONS_DIR` at it; they load at boot, in file
name order. `acme-governance.mjs` here is a working example.

```js
export default {
  name: 'acme',               // lower-case latin; every key it registers starts with "acme."
  version: '1.0.0',
  descriptionFa: '…',
  register(api) {
    api.registerGuard({ key: 'acme.x', labelFa: '…', async run({ tx, entity, id, record, payload, actorId }) { return { ok: true } } });
    api.attachGuard('project', 'activate', 'acme.x');          // on top of Doc_H's guards
    api.registerEffect({ key: 'acme.y', entity: 'deliverable', action: 'deliver', labelFa: '…',
      async run({ tx, id, record, payload, actorId, organizationId, reason }) { return {} } });
  },
};
```

What holds, whatever an extension does:

- **It can add a rule, never remove one.** A key cannot be registered twice, so a core guard cannot
  be replaced; attached guards stand beside Doc_H's. An effect runs after the core effect and may
  not write `state`, `id`, `organizationId`, `code`, `createdAt` or any field the core effect set.
- **A guard is read-only.** Preflight asks it on every page view, and the rule lab replays it. It
  receives the transaction for reading; it must not write.
- **An effect runs inside the transition's transaction.** If it throws, the move does not happen.
  Keep it quick; calls to outside systems belong in webhooks (#46), not here.
- **Loading fails closed.** An extension that throws, or names a transition or guard that does not
  exist, stops the boot: an organisation's workflow must not look governed and not be.
- **Installing one is a change of the rules.** The workflows rule set gets a new version (#4), and
  every transition after it names that version.
- **Guards can be waived** (#7) like any other, and appear in preflight (#2) with their labels.

Extensions run with the API's own rights. Install only code you have reviewed.
